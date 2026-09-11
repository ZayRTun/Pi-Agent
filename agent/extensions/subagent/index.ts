/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message, Usage } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	getAgentDir,
	getMarkdownTheme,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	type AgentConfig,
	type AgentScope,
	DEFAULT_TIMEOUT_MINUTES,
	discoverAgents,
	MAX_TIMEOUT_MINUTES,
	MIN_TIMEOUT_MINUTES,
	renderAgentBadge,
	resolveTimeoutMinutes,
	THINKING_LEVELS,
} from "./agents.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const PER_TASK_OUTPUT_CAP = 50 * 1024;
const STDERR_CAPTURE_CAP = 32 * 1024;
const CHAIN_CONTEXT_CAP = 50 * 1024;
const ABORT_ESCALATION_MS = 5000;
// Streaming updates are throttled to this cadence; see emitUpdate.
const UPDATE_THROTTLE_MS = 200;

// ── Spinner ────────────────────────────────────────────────────────────────
// A single shared ticker drives every running row. It only runs while at
// least one tool row is rendering a Running state, and is unref'd so it
// never keeps the process alive on its own.
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

let spinnerFrame = 0;
let spinnerTimer: ReturnType<typeof setInterval> | null = null;
// Keyed by toolCallId: pi creates a fresh context object per render call, so
// entries must REPLACE by id — a Set of contexts would accumulate one stale
// entry per render and multiply invalidation work every tick (OOM).
const activeRows = new Map<string, () => void>();

function ensureSpinnerTimer() {
	if (spinnerTimer) return;
	spinnerTimer = setInterval(() => {
		spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
		for (const [id, invalidate] of activeRows) {
			try {
				invalidate();
			} catch {
				activeRows.delete(id);
			}
		}
		if (activeRows.size === 0) stopSpinnerTimerIfIdle();
	}, SPINNER_INTERVAL_MS);
	spinnerTimer.unref?.();
}

function stopSpinnerTimerIfIdle() {
	if (spinnerTimer && activeRows.size === 0) {
		clearInterval(spinnerTimer);
		spinnerTimer = null;
	}
}

function formatTokens(count: number): string {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
	return count.toString();
}

/**
 * Format a cost as `~$0.0042`, or "" when there is nothing to show. The
 * tilde is load-bearing: usage.cost is pi's own estimate from the model's
 * listed rates, not a billed figure. Nothing prints for zero — a model with
 * no pricing data reports 0, and `$0.00` would claim the cost was measured
 * and found to be nothing rather than never measured at all.
 */
function formatCost(cost: number): string {
	if (!(cost > 0)) return ""; // also catches NaN
	if (cost < 0.0001) return "<$0.0001";
	if (cost >= 1) return `~$${cost.toFixed(2)}`;
	const rounded = Number(cost.toFixed(4));
	const decimals = (String(rounded).split(".")[1] ?? "").length;
	return `~$${rounded.toFixed(Math.max(2, decimals))}`;
}

/** Shorten a model id for display: drop the provider prefix, keep any suffix. */
function shortModelName(model: string | undefined): string | undefined {
	if (!model) return undefined;
	const slash = model.lastIndexOf("/");
	const short = slash >= 0 ? model.slice(slash + 1) : model;
	return short || model;
}

/**
 * Human-readable usage line, pi-subagents stats order:
 * `model · thinking: high · ↻turns≤max · N tool uses · tokens · duration · ~cost`.
 * Zero/unknown fields are dropped so short runs stay short.
 */
function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
	thinking?: string,
): string {
	const parts: string[] = [];
	const shortModel = shortModelName(model);
	if (shortModel) parts.push(shortModel);
	if (thinking) parts.push(`thinking: ${thinking}`);
	if (usage.turns) parts.push(`↻${usage.turns}`);
	const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	if (tokens > 0) parts.push(`${formatTokens(tokens)} token${tokens === 1 ? "" : "s"}`);
	const costText = formatCost(usage.cost);
	if (costText) parts.push(costText);
	return parts.join(" · ");
}

/** Tool name → human-readable activity verb (pi-subagents TOOL_DISPLAY). */
const TOOL_ACTIVITY: Record<string, string> = {
	read: "reading",
	bash: "running command",
	edit: "editing",
	write: "writing",
	grep: "searching",
	ffgrep: "searching",
	find: "finding files",
	fffind: "finding files",
	ls: "listing",
	fetch_content: "fetching",
	web_search: "searching the web",
};

/** Grouped tool counts in first-seen order: `read ×4 · grep ×2`. */
function countTools(messages: Message[]): string {
	const counts = new Map<string, number>();
	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		for (const part of msg.content) {
			if (part.type === "toolCall") counts.set(part.name, (counts.get(part.name) ?? 0) + 1);
		}
	}
	return [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(" · ");
}

/** Most recent tool call, or undefined when the agent hasn't called one yet. */
function lastToolCall(messages: Message[]): { name: string; args: Record<string, any> } | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		for (let j = msg.content.length - 1; j >= 0; j--) {
			const part = msg.content[j];
			if (part.type === "toolCall") return { name: part.name, args: part.arguments };
		}
	}
	return undefined;
}

/**
 * Live activity line for a running agent. Always tool-first: the most recent
 * tool call decides the wording, so the parent sees movement even when the
 * child hasn't produced reply text yet.
 */
function describeActivity(messages: Message[]): string {
	const last = lastToolCall(messages);
	if (last) {
		const plain = describeToolPlain(last.name, last.args);
		// `describeToolPlain` falls back to the bare tool name; only attach the
		// detail when it actually says something about the call.
		return plain && plain !== last.name ? `${plain}…` : `${TOOL_ACTIVITY[last.name] ?? last.name}…`;
	}
	const text = getFinalOutput(messages);
	if (text.trim()) {
		const line = text.split("\n").find((l) => l.trim())?.trim() ?? "";
		return line.length > 80 ? `${line.slice(0, 80)}…` : line;
	}
	return "thinking…";
}

/** First non-empty line of text, truncated — the `⎿` summary under each row. */
function oneLineSummary(text: string, maxChars = 80): string {
	const line = text.split("\n").find((l) => l.trim())?.trim() ?? "";
	if (!line) return "(no output)";
	return line.length > maxChars ? `${line.slice(0, maxChars)}…` : line;
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}…` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find":
		case "fffind": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep":
		case "ffgrep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "search ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}…` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

/**
 * Plain-text description of a tool call for headers and activity lines:
 * `index.ts`, `sleep 150`, `/timeout/ in src/`. No colors — callers style it.
 * Falls back to the bare tool name when nothing useful can be said.
 */
function describeToolPlain(toolName: string, args: Record<string, unknown>): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};
	const str = (v: unknown) => (typeof v === "string" ? v : "");
	switch (toolName) {
		case "bash": {
			const command = str(args.command) || "...";
			return command.length > 60 ? `${command.slice(0, 60)}…` : command;
		}
		case "read": {
			const filePath = shortenPath(str(args.file_path ?? args.path) || "...");
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				return `${filePath}:${startLine}${endLine ? `-${endLine}` : ""}`;
			}
			return filePath;
		}
		case "write": {
			const filePath = shortenPath(str(args.file_path ?? args.path) || "...");
			const lines = str(args.content).split("\n").length;
			return lines > 1 ? `${filePath} (${lines} lines)` : filePath;
		}
		case "edit":
			return shortenPath(str(args.file_path ?? args.path) || "...");
		case "ls":
			return shortenPath(str(args.path) || ".");
		case "find":
		case "fffind": {
			const pattern = str(args.pattern) || "*";
			const dir = str(args.path);
			return dir ? `${pattern} in ${shortenPath(dir)}` : pattern;
		}
		case "grep":
		case "ffgrep": {
			const pattern = str(args.pattern);
			const dir = str(args.path);
			const what = pattern ? `/${pattern}/` : "";
			const where = dir ? ` in ${shortenPath(dir)}` : "";
			return `${what}${where}`.trim() || toolName;
		}
		case "fetch_content":
			return str(args.url) || str(args.urls) || toolName;
		case "web_search":
			return str(args.query) || str(args.queries) || toolName;
		default: {
			const argsStr = JSON.stringify(args);
			if (argsStr === "{}") return toolName;
			return argsStr.length > 50 ? `${argsStr.slice(0, 50)}…` : argsStr;
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	totalTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	agentColor?: string;
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	aborted?: boolean;
	startedAt?: number;
	endedAt?: number;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
	/** Per-call color lookup so renderCall can badge agent names pre-spawn. */
	agentColors?: Record<string, string | undefined>;
}

/**
 * Wrap a prior step's output before it is pasted into the next step's task.
 *
 * Raw splicing hides where instructions end and old output begins, so the
 * next agent can mistake one for the other. The label names the source step,
 * states the byte size, and flags truncation — the child can then judge how
 * much to trust the context instead of guessing.
 */
function formatPreviousOutput(output: string, agent: string, step: number, truncated: boolean): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	const note = truncated ? ", truncated to fit the chain context cap" : "";
	return `[Output from step ${step} (${agent}), ${byteLength} bytes${note}]:\n${output}`;
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function toNestedUsage(results: SingleResult[]): Usage {
	const usage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};

	for (const result of results) {
		usage.input += result.usage.input;
		usage.output += result.usage.output;
		usage.cacheRead += result.usage.cacheRead;
		usage.cacheWrite += result.usage.cacheWrite;
		usage.totalTokens += result.usage.totalTokens;
		usage.cost.total += result.usage.cost;
	}
	return usage;
}

function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

type RunState = "running" | "succeeded" | "failed" | "aborted";

function getRunState(result: SingleResult): RunState {
	if (result.exitCode === -1) return "running";
	if (result.aborted || result.stopReason === "aborted") return "aborted";
	return result.exitCode !== 0 || result.stopReason === "error" ? "failed" : "succeeded";
}

function stateIcon(state: RunState, theme: { fg: (color: string, text: string) => string }): string {
	switch (state) {
		case "running":
			return theme.fg("accent", SPINNER_FRAMES[spinnerFrame]);
		case "succeeded":
			return theme.fg("success", "✓");
		case "failed":
			return theme.fg("error", "✗");
		case "aborted":
			return theme.fg("warning", "⏹");
	}
}

function resultElapsedMs(result: SingleResult): number | undefined {
	if (result.startedAt === undefined) return undefined;
	return (result.endedAt ?? Date.now()) - result.startedAt;
}



// Strip a leading "In /abs/path," fragment (task authors often phrase
// instructions as "In <file>, do X"; the path is noise in the preview).
// Then keep the preview to a single truncated line.
function previewTask(task: string, maxChars: number): string {
	const stripped = task.replace(/^In\s+(?:\/|~\/)[^,]+,?\s*/i, "").trim();
	const text = stripped.length > 0 ? stripped : task.trim();
	return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

function isFailedResult(result: SingleResult): boolean {
	const state = getRunState(result);
	return state === "failed" || state === "aborted";
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

function truncateOutput(output: string, cap = PER_TASK_OUTPUT_CAP): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= cap) return output;

	let truncated = output.slice(0, cap);
	while (Buffer.byteLength(truncated, "utf8") > cap) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

/**
 * Create one temp dir per delegation. Every file the delegation needs (today:
 * the system-prompt file) lives in it, so a single removeTempDir call cleans
 * up everything — a new file can never be added without inheriting the same
 * cleanup. Files are mode 0600: prompts can contain private repo context.
 */
async function createTaskTempDir(agentName: string): Promise<{
	dir: string;
	writeFile: (name: string, content: string) => Promise<string>;
}> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const writeFile = async (name: string, content: string): Promise<string> => {
		const filePath = path.join(dir, `${name}-${safeName}.md`);
		await withFileMutationQueue(filePath, async () => {
			await fs.promises.writeFile(filePath, content, { encoding: "utf-8", mode: 0o600 });
		});
		return filePath;
	};
	return { dir, writeFile };
}

// Delete a delegation's temp dir. Failures are ignored: the dir lives under
// the OS temp root, so the system sweeper reclaims anything we miss.
async function removeTempDir(dir: string | null): Promise<void> {
	if (!dir) return;
	try {
		await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 2 });
	} catch {
		/* ignore */
	}
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

interface DispatchDefaults {
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

async function runSingleAgent(
	defaultCwd: string,
	dispatchDefaults: DispatchDefaults,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	timeoutMinutes: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			agentColor: undefined,
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, totalTokens: 0, turns: 0 },
			step,
		};
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	// Model and thinking level are independent axes: each one is taken from the
	// agent definition when declared, and inherited from the invoking session
	// otherwise. Declaring a model therefore must not disturb the level.
	const model = agent.model ?? dispatchDefaults.model;
	if (model) args.push("--model", model);
	const thinking = agent.thinking ?? dispatchDefaults.thinkingLevel;
	if (thinking) args.push("--thinking", thinking);
	if (agent.toolsSpecified) args.push("--tools", agent.tools?.join(",") ?? "");
	if (!agent.allowSubagents) args.push("--exclude-tools", "subagent");

	// Timeout precedence: call-level timeoutMinutes, then the Agent definition's
	// timeoutMinutes, then the global default. resolveTimeoutMinutes clamps to
	// [MIN_TIMEOUT_MINUTES, MAX_TIMEOUT_MINUTES], so garbage can never yield a
	// zero or infinite timeout.
	const effectiveTimeoutMinutes = resolveTimeoutMinutes(timeoutMinutes, agent.timeoutMinutes);
	const timeoutMs = effectiveTimeoutMinutes * 60 * 1000;

	// One temp dir per delegation; removeTempDir in the finally block deletes
	// the whole dir at once.
	let tmpDir: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		agentColor: agent.color,
		task,
		exitCode: -1, // running until the process closes; emitUpdate streams this state
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, totalTokens: 0, turns: 0 },
		model,
		step,
	};

	// Streaming updates are throttled: a chatty subagent (dozens of file reads)
	// would otherwise force a parent TUI re-render per tool call. The leading
	// call goes through immediately so "starting..." feedback stays snappy;
	// further calls within the window collapse into one trailing call, and
	// flushUpdate() delivers the final state synchronously before return.
	let lastEmitMs = 0;
	let pendingEmit: ReturnType<typeof setTimeout> | null = null;
	const sendUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};
	const emitUpdate = () => {
		if (!onUpdate) return;
		const waitMs = UPDATE_THROTTLE_MS - (Date.now() - lastEmitMs);
		if (waitMs <= 0) {
			if (pendingEmit) {
				clearTimeout(pendingEmit);
				pendingEmit = null;
			}
			lastEmitMs = Date.now();
			sendUpdate();
		} else if (!pendingEmit) {
			pendingEmit = setTimeout(() => {
				pendingEmit = null;
				lastEmitMs = Date.now();
				sendUpdate();
			}, waitMs);
			pendingEmit.unref?.();
		}
	};
	const flushUpdate = () => {
		if (pendingEmit) {
			clearTimeout(pendingEmit);
			pendingEmit = null;
			lastEmitMs = Date.now();
			sendUpdate();
		}
	};

	try {
		const tmp = await createTaskTempDir(agent.name);
		tmpDir = tmp.dir;

		if (agent.systemPrompt.trim()) {
			const promptPath = await tmp.writeFile("prompt", agent.systemPrompt);
			args.push("--append-system-prompt", promptPath);
		}

		// Pass the task via stdin, not argv. argv has a hard OS size limit
		// (ARG_MAX) and is world-visible in `ps`; stdin has neither problem.
		// A "Task:" prefix is kept so the child sees the same shape as before.
		const taskInput = `Task: ${task}`;

		let wasAborted = false;
		let timedOut = false;
		currentResult.startedAt = Date.now();

		const processResult = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				detached: process.platform !== "win32",
				stdio: ["pipe", "pipe", "pipe"],
			});
			let buffer = "";
			let settled = false;
			let abortTimer: ReturnType<typeof setTimeout> | undefined;
			let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

			const killProcessTree = (kind: NodeJS.Signals) => {
				try {
					if (process.platform !== "win32" && proc.pid) process.kill(-proc.pid, kind);
					else proc.kill(kind);
				} catch {
					// The process may have exited between the check and the kill.
				}
			};
			const finish = (code: number | null, termSignal: NodeJS.Signals | null) => {
				if (settled) return;
				settled = true;
				if (abortTimer) clearTimeout(abortTimer);
				if (timeoutTimer) clearTimeout(timeoutTimer);
				if (signal) signal.removeEventListener("abort", abortProc);
				resolve({ code, signal: termSignal });
			};
			const onTimeout = () => {
				if (settled) return;
				timedOut = true;
				wasAborted = true;
				killProcessTree("SIGTERM");
				abortTimer = setTimeout(() => {
					if (!settled) killProcessTree("SIGKILL");
				}, ABORT_ESCALATION_MS);
			};
			const abortProc = () => {
				if (settled) return;
				wasAborted = true;
				killProcessTree("SIGTERM");
				abortTimer = setTimeout(() => {
					if (!settled) killProcessTree("SIGKILL");
				}, ABORT_ESCALATION_MS);
			};

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
							currentResult.usage.totalTokens += usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				if (currentResult.stderr.length >= STDERR_CAPTURE_CAP) return;
				currentResult.stderr += data.toString().slice(0, STDERR_CAPTURE_CAP - currentResult.stderr.length);
			});

			proc.on("close", (code, termSignal) => {
				if (buffer.trim()) processLine(buffer);
				finish(code, termSignal);
			});

			proc.on("error", (error) => {
				currentResult.errorMessage = error.message;
				finish(1, null);
			});

			// Feed the task on stdin (see above for why not argv), then close it
			// so the child is never left waiting on input.
			proc.stdin.on("error", () => {
				/* child exited before reading stdin; close carries the outcome */
			});
			proc.stdin.end(taskInput, "utf-8");

			// Per-call timeout: SIGTERM first, SIGKILL after the same escalation
			// window as user cancellation.
			timeoutTimer = setTimeout(onTimeout, timeoutMs);
			timeoutTimer.unref?.();

			if (signal) {
				if (signal.aborted) abortProc();
				else signal.addEventListener("abort", abortProc, { once: true });
			}
		});

		currentResult.exitCode = processResult.code ?? 1;
		currentResult.endedAt = Date.now();
		// Deliver any throttled trailing update before returning, so the parent
		// never shows stale progress for a finished agent.
		flushUpdate();
		if (wasAborted) currentResult.aborted = true;
		if (timedOut) {
			currentResult.stopReason = "error";
			currentResult.errorMessage ||=
				`Subagent timed out after ${effectiveTimeoutMinutes} minute${effectiveTimeoutMinutes === 1 ? "" : "s"}. Pass a larger timeoutMinutes to allow more time.`;
		}
		if (processResult.code === null && !wasAborted) {
			currentResult.stopReason = "error";
			currentResult.errorMessage ||= `Subagent terminated by ${processResult.signal ?? "unknown signal"}.`;
		}
		if (currentResult.exitCode === 0 && !getFinalOutput(currentResult.messages)) {
			currentResult.stopReason = "error";
			currentResult.errorMessage ||= "Subagent exited without a final text response.";
		}
		flushUpdate();
		return currentResult;
	} catch (error) {
		currentResult.exitCode = 1;
		currentResult.endedAt = Date.now();
		currentResult.errorMessage = error instanceof Error ? error.message : String(error);
		flushUpdate();
		return currentResult;
	} finally {
		await removeTempDir(tmpDir);
	}
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	timeoutMinutes: Type.Optional(
		Type.Number({
				description: `Timeout for this delegation in minutes. Overrides the agent's timeoutMinutes, which overrides the default of ${DEFAULT_TIMEOUT_MINUTES}. Clamped to ${MIN_TIMEOUT_MINUTES}-${MAX_TIMEOUT_MINUTES}.`,
				minimum: MIN_TIMEOUT_MINUTES,
				maximum: MAX_TIMEOUT_MINUTES,
			}),
	),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	timeoutMinutes: Type.Optional(
		Type.Number({
				description: `Timeout for this step in minutes. Overrides the agent's timeoutMinutes, which overrides the default of ${DEFAULT_TIMEOUT_MINUTES}. Clamped to ${MIN_TIMEOUT_MINUTES}-${MAX_TIMEOUT_MINUTES}.`,
				minimum: MIN_TIMEOUT_MINUTES,
				maximum: MAX_TIMEOUT_MINUTES,
			}),
	),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Require interactive approval for untrusted project-local agents; false rejects them. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	timeoutMinutes: Type.Optional(
		Type.Number({
			description: `Timeout for the delegation in minutes (single mode). Overrides the agent's timeoutMinutes, which overrides the default of ${DEFAULT_TIMEOUT_MINUTES}. Clamped to ${MIN_TIMEOUT_MINUTES}-${MAX_TIMEOUT_MINUTES}.`,
			minimum: MIN_TIMEOUT_MINUTES,
			maximum: MAX_TIMEOUT_MINUTES,
		}),
	),
});

export default function (pi: ExtensionAPI) {
	// Resolve the user-scope roster once at load so the tool description tells
	// the model the exact agent names to use (prevents invented names like
	// "general" that used to fail validation). Execution re-discovers agents per
	// call, so new agents still work without a restart — only the description
	// lags until the next restart.
	const rosterNames = discoverAgents(process.cwd(), "user")
		.agents.map((a) => a.name)
		.sort()
		.join(", ");

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			`Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
			`Available agents: ${rosterNames || "none"}.`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
			"Leaf agents cannot recursively call subagent unless their frontmatter sets allowSubagents: true.",
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const dispatchDefaults: DispatchDefaults = {
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				thinkingLevel: ctx.thinkingLevel,
			};
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
					agentColors: Object.fromEntries(agents.map((a) => [a.name, a.color])),
				});

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			const requestedAgentNames = new Set<string>();
			if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
			if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
			if (params.agent) requestedAgentNames.add(params.agent);

			const projectAgentsRequested = Array.from(requestedAgentNames)
				.map((name) => agents.find((a) => a.name === name))
				.filter((a): a is AgentConfig => a?.source === "project");
			const projectAgentsUntrusted = projectAgentsRequested.length > 0 && !ctx.isProjectTrusted();

			if ((agentScope === "project" || agentScope === "both") && projectAgentsUntrusted) {
				const mode = hasChain ? "chain" : hasTasks ? "parallel" : "single";
				if (!confirmProjectAgents || !ctx.hasUI) {
					return {
						content: [{
							type: "text",
							text: ctx.hasUI
								? "Canceled: project-local agents require approval; confirmProjectAgents cannot bypass the safety check."
								: "Canceled: project-local agents require an already-trusted project or interactive approval.",
						}],
						details: makeDetails(mode)([]),
						isError: true,
					};
				}

				const names = projectAgentsRequested.map((a) => a.name).join(", ");
				const dir = discovery.projectAgentsDir ?? "(unknown)";
				const ok = await ctx.ui.confirm(
					"Run project-local agents?",
					`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
				);
				if (!ok)
					return {
						content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
						details: makeDetails(mode)([]),
					};
			}

			// An unrecognized `thinking` value must not block the delegation: warn the
			// user, then fall through — the agent runs and inherits the session's level.
			if (ctx.hasUI) {
				for (const name of requestedAgentNames) {
					const invalid = agents.find((a) => a.name === name)?.invalidThinking;
					if (!invalid) continue;
					ctx.ui.notify(
						`Agent "${name}" has an unrecognized thinking level "${invalid}"; using the session's level instead. Valid levels: ${THINKING_LEVELS.join(", ")}.`,
						"warning",
					);
				}
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				// Raw text of the prior step, plus the labelled form actually pasted
				// into the next task. Both are kept: {previous} substitutes the
				// labelled form, while the missing-placeholder warning below quotes
				// the raw form's length from the unlabelled text.
				let previousOutput = "";
				let previousLabelled = "";
				const previousWarnings: string[] = [];

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const stepUsesPrevious = step.task.includes("{previous}");
					// A step that forgets {previous} silently drops the prior output.
					// Warn (don't fail): some chains are just "do A, then do B" with
					// no data passing, where dropping is intended.
					if (i > 0 && !stepUsesPrevious && previousOutput.length > 0) {
						previousWarnings.push(
							`Step ${i + 1} (${step.agent}) has no {previous} placeholder; step ${i} (${params.chain[i - 1].agent}) output (${Buffer.byteLength(previousOutput, "utf8")} bytes) was not passed.`,
						);
					}
					const taskWithContext = step.task.replace(/\{previous\}/g, previousLabelled);

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runSingleAgent(
						ctx.cwd,
						dispatchDefaults,
						agents,
						step.agent,
						taskWithContext,
						step.cwd,
						i + 1,
						step.timeoutMinutes,
						signal,
						chainUpdate,
						makeDetails("chain"),
					);
					results.push(result);

					const isError = isFailedResult(result);
					if (isError) {
						const errorMsg = truncateOutput(getResultOutput(result));
						const warningBlock =
							previousWarnings.length > 0 ? `\n\n[Chain warnings]\n- ${previousWarnings.join("\n- ")}` : "";
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}${warningBlock}` }],
							details: makeDetails("chain")(results),
							usage: toNestedUsage(results),
							isError: true,
						};
					}
					previousOutput = truncateOutput(getFinalOutput(result.messages), CHAIN_CONTEXT_CAP);
					const wasTruncated =
						Buffer.byteLength(getFinalOutput(result.messages), "utf8") >
						Buffer.byteLength(previousOutput, "utf8");
					previousLabelled = formatPreviousOutput(previousOutput, result.agent, i + 1, wasTruncated);
				}
				const finalText =
					truncateOutput(getFinalOutput(results[results.length - 1].messages)) || "(no output)";
				const warningBlock =
					previousWarnings.length > 0 ? `\n\n[Chain warnings]\n- ${previousWarnings.join("\n- ")}` : "";
				return {
					content: [{ type: "text", text: `${finalText}${warningBlock}` }],
					details: makeDetails("chain")(results),
					usage: toNestedUsage(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						agentColor: agents.find((a) => a.name === params.tasks[i].agent)?.color,
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
						startedAt: Date.now(),
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, totalTokens: 0, turns: 0 },
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSingleAgent(
						ctx.cwd,
						dispatchDefaults,
						agents,
						t.agent,
						t.task,
						t.cwd,
						undefined,
						t.timeoutMinutes,
						signal,
						// Per-task update callback
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"),
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const completeFailure = successCount === 0;
				const summaries = results.map((r) => {
					const output = truncateOutput(getResultOutput(r));
					const rState = getRunState(r);
					const status =
						rState === "succeeded"
							? "completed"
							: rState === "aborted"
								? "aborted"
								: `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`;
					return `### [${r.agent}] ${status}\n\n${output}`;
				});
				return {
					content: [
						{
							type: "text",
							text: truncateOutput(`Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`),
						},
					],
					details: makeDetails("parallel")(results),
					usage: toNestedUsage(results),
					// Total failure is a machine-readable error; anything else stays
					// success so the parent can use the partial results.
					isError: completeFailure,
				};
			}

			if (params.agent && params.task) {
				const result = await runSingleAgent(
					ctx.cwd,
					dispatchDefaults,
					agents,
					params.agent,
					params.task,
					params.cwd,
					undefined,
					params.timeoutMinutes,
					signal,
					onUpdate,
					makeDetails("single"),
				);
				const state = getRunState(result);
				if (state !== "succeeded") {
					const errorMsg = truncateOutput(getResultOutput(result));
					const label = state === "aborted" ? "aborted" : result.stopReason || "failed";
					return {
						content: [{ type: "text", text: `Agent ${label}: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						usage: toNestedUsage([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: truncateOutput(getFinalOutput(result.messages)) || "(no output)" }],
					details: makeDetails("single")([result]),
					usage: toNestedUsage([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			const scopeTag = scope === "user" ? "" : theme.fg("muted", ` [${scope}]`);
			// renderCall cannot run discovery (it has no cwd/session context),
			// so names render with theme styling and budgets show the default
			// unless the call declares its own timeoutMinutes.
			const callBadge = (name: string) => theme.fg("toolTitle", theme.bold(name));
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					scopeTag;
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = previewTask(cleanTask, 40);
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						callBadge(step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					scopeTag;
				for (const t of args.tasks.slice(0, 3)) {
					const preview = previewTask(t.task, 40);
					text += `\n  ${callBadge(t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				callBadge(agentName) +
				scopeTag;
			if (args.task) text += `\n  ${theme.fg("dim", previewTask(args.task, 80))}`;
			// Timeout budget up front. The effective value needs discovery plus
			// the call param, both known only at execute time, so show the
			// call-level value when declared, else the default.
			const callTimeout = args.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES;
			text += `\n  ${theme.fg("dim", `⏱ ${callTimeout}m budget`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			const details = result.details as SubagentDetails | undefined;
			const anyRunning = details?.results.some((r) => getRunState(r) === "running") ?? false;
			const rowContext = context as { toolCallId?: string; invalidate: () => void };
			if (isPartial && (anyRunning || !details || details.results.length === 0)) {
				if (typeof rowContext.toolCallId === "string") {
					activeRows.set(rowContext.toolCallId, () => rowContext.invalidate());
					ensureSpinnerTimer();
				}
			} else {
				if (typeof rowContext.toolCallId === "string") activeRows.delete(rowContext.toolCallId);
				stopSpinnerTimerIfIdle();
			}

			if (!details || details.results.length === 0) {
				if (isPartial) {
					return new Text(
						theme.fg("accent", SPINNER_FRAMES[spinnerFrame]) + theme.fg("muted", " starting subagent…"),
						0,
						0,
					);
				}
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();


			// ── Polished row rendering (pi-subagents style) ────────────────────
			// Header: `icon badge  task preview · stats · time`. The task preview
			// sits next to the name so a running row reads as a sentence; elapsed
			// time always trails.
			const polishedHeader = (r: SingleResult): string => {
				const icon = stateIcon(getRunState(r), theme);
				const badge = renderAgentBadge(r.agent, r.agentColor ?? details.agentColors?.[r.agent], theme);
				const sourceTag = r.agentSource === "user" ? "" : theme.fg("muted", ` (${r.agentSource})`);
				const taskPreview = previewTask(r.task, 60);
				const usageStr = formatUsageStats(r.usage, r.model);
				const elapsed = resultElapsedMs(r);
				const elapsedText = elapsed === undefined ? "" : formatDuration(elapsed);
				const statsLine = [usageStr, elapsedText].filter(Boolean).join(" · ");
				const core = `${icon} ${badge}${sourceTag}  ${theme.fg("muted", taskPreview)}`;
				return statsLine ? `${core} ${theme.fg("dim", "·")} ${theme.fg("dim", statsLine)}` : core;
			};

			// One-line `⎿` summary for a finished row: first line of output.
			const polishedSummary = (r: SingleResult): string => {
				const state = getRunState(r);
				if (state === "aborted") return `Aborted (${r.errorMessage ? oneLineSummary(r.errorMessage, 60) : "timeout"})`;
				if (state === "failed") return oneLineSummary(r.errorMessage || getResultOutput(r), 80);
				return oneLineSummary(getFinalOutput(r.messages), 80);
			};

			const renderSingleResult = (
				r: SingleResult,
				opts: { expanded: boolean; theme: any; mdTheme: any },
			): Container | Text => {
				const { expanded, theme, mdTheme } = opts;
				const state = getRunState(r);
				const isError = state !== "succeeded";
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);
				if (expanded) {
					const container = new Container();
					let header = polishedHeader(r);
					if (isError && r.stopReason)
						header += ` ${state === "aborted" ? theme.fg("warning", "[aborted]") : theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "\u2500\u2500 task \u2500\u2500"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "\u2500\u2500 output \u2500\u2500"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("success", "\u2713 ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					return container;
				}
				// Collapsed: two lines, always. `⎿` carries live activity while
				// running, the error while failed, or tools + summary when done.
				let text = polishedHeader(r);
				if (isError && r.stopReason)
					text += ` ${state === "aborted" ? theme.fg("warning", "[aborted]") : theme.fg("error", `[${r.stopReason}]`)}`;
				if (state === "running") {
					text += `\n${theme.fg("dim", `   \u2514\u2500 ${describeActivity(r.messages)}`)}`;
				} else if (isError) {
					text += `\n  ${theme.fg("error", `\u2514\u2500 ${polishedSummary(r)}`)}`;
				} else {
					const tools = countTools(r.messages);
					if (tools) text += `\n  ${theme.fg("dim", tools)}`;
					text += `\n  ${theme.fg("dim", `\u2514\u2500 ${polishedSummary(r)}`)}`;
				}
				return new Text(text, 0, 0);
			};

			if (details.mode === "single" && details.results.length === 1) {
				return renderSingleResult(details.results[0], { expanded, theme, mdTheme });
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const states = details.results.map((r) => getRunState(r));
				const successCount = states.filter((s) => s === "succeeded").length;
				const runningCount = states.filter((s) => s === "running").length;
				const runningIdx = details.results.findIndex((r) => getRunState(r) === "running");
				const failCount = states.filter((s) => s === "failed").length;
				const abortCount = states.filter((s) => s === "aborted").length;
				const totalElapsed = details.results.reduce((acc, r) => acc + (resultElapsedMs(r) ?? 0), 0);
				const icon = runningCount
					? stateIcon("running", theme)
					: failCount
						? theme.fg("error", "\u2717")
						: abortCount
							? theme.fg("warning", "\u23f9")
							: theme.fg("success", "\u2713");
				// Tree heading: `● chain 2/2 steps · 41s`, running shows position.
				const headStatus = runningCount
					? `step ${runningIdx + 1}/${details.results.length}`
					: `${successCount}/${details.results.length} steps`;
				const headStats = theme.fg("dim", `\u00b7 ${formatDuration(totalElapsed)}`);
				const heading = `${theme.fg("accent", "\u25cf")} ${theme.fg("toolTitle", theme.bold("chain "))}${theme.fg("accent", headStatus)} ${headStats}`;

				// One row per step: `1. ✓ badge (12s) — summary` or live activity.
				const stepRow = (r: SingleResult, idx: number): string => {
					const rState = getRunState(r);
					const rIcon = stateIcon(rState, theme);
					const badge = renderAgentBadge(r.agent, r.agentColor ?? details.agentColors?.[r.agent], theme);
					const elapsed = resultElapsedMs(r);
					const when = elapsed === undefined ? "" : ` (${formatDuration(elapsed)})`;
					const num = theme.fg("muted", `${idx + 1}.`);
					if (rState === "running") return `${num} ${rIcon} ${badge}${theme.fg("dim", when)} \u2014 ${describeActivity(r.messages)}`;
					return `${num} ${rIcon} ${badge}${theme.fg("dim", when)} \u2014 ${polishedSummary(r)}`;
				};

				if (expanded) {
					const container = new Container();
					container.addChild(new Text(heading, 0, 0));
					for (let idx = 0; idx < details.results.length; idx++) {
						const r = details.results[idx];
						const branch = idx === details.results.length - 1 ? "\u2514\u2500" : "\u251c\u2500";
						const finalOutput = getFinalOutput(r.messages);
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", branch) + " " + stepRow(r, idx), 0, 0));
						container.addChild(new Text(theme.fg("dim", `    Task: ${previewTask(r.task, 80)}`), 0, 0));
						const tools = countTools(r.messages);
						if (tools) container.addChild(new Text(theme.fg("dim", `    ${tools}`), 0, 0));
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed tree view.
				const lines = [heading];
				for (let idx = 0; idx < details.results.length; idx++) {
					const r = details.results[idx];
					const last = idx === details.results.length - 1;
					const branch = last ? "\u2514\u2500" : "\u251c\u2500";
					lines.push(theme.fg("dim", branch) + " " + stepRow(r, idx));
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) lines.push(theme.fg("dim", `Total: ${usageStr}`));
				if (!expanded) lines.push(theme.fg("muted", "(Ctrl+O to expand)"));
				return new Text(lines.join("\n"), 0, 0);
			}

			if (details.mode === "parallel") {
				const states = details.results.map((r) => getRunState(r));
				const running = states.filter((s) => s === "running").length;
				const successCount = states.filter((s) => s === "succeeded").length;
				const failCount = states.filter((s) => s === "failed").length;
				const abortCount = states.filter((s) => s === "aborted").length;
				const doneCount = states.length - running;
				const isRunning = running > 0;
				const totalElapsed = details.results.reduce((acc, r) => acc + (resultElapsedMs(r) ?? 0), 0);
				const icon = isRunning
					? stateIcon("running", theme)
					: failCount > 0 && successCount > 0
						? theme.fg("warning", "\u25d0")
						: failCount > 0
							? theme.fg("error", "\u2717")
							: abortCount > 0
								? theme.fg("warning", "\u23f9")
								: theme.fg("success", "\u2713");
				const status = isRunning
					? `${doneCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;
				const headStats = theme.fg("dim", `\u00b7 ${formatDuration(totalElapsed)}`);
				const heading = `${theme.fg("accent", "\u25cf")} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)} ${headStats}`;

				// One row per task: `✓ badge — summary (8s)` or live activity.
				const taskRow = (r: SingleResult): string => {
					const rState = getRunState(r);
					const rIcon = stateIcon(rState, theme);
					const badge = renderAgentBadge(r.agent, r.agentColor ?? details.agentColors?.[r.agent], theme);
					const elapsed = resultElapsedMs(r);
					const when = elapsed === undefined ? "" : theme.fg("dim", ` (${formatDuration(elapsed)})`);
					if (rState === "running") return `${rIcon} ${badge}${when} \u2014 ${describeActivity(r.messages)}`;
					return `${rIcon} ${badge}${when} \u2014 ${polishedSummary(r)}`;
				};

				if (expanded) {
					const container = new Container();
					container.addChild(new Text(heading, 0, 0));
					for (let idx = 0; idx < details.results.length; idx++) {
						const r = details.results[idx];
						const branch = idx === details.results.length - 1 ? "\u2514\u2500" : "\u251c\u2500";
						const finalOutput = getFinalOutput(r.messages);
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", branch) + " " + taskRow(r), 0, 0));
						container.addChild(new Text(theme.fg("dim", `    Task: ${previewTask(r.task, 80)}`), 0, 0));
						const tools = countTools(r.messages);
						if (tools) container.addChild(new Text(theme.fg("dim", `    ${tools}`), 0, 0));
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed tree view (also used while running).
				const lines = [heading];
				for (let idx = 0; idx < details.results.length; idx++) {
					const r = details.results[idx];
					const branch = idx === details.results.length - 1 ? "\u2514\u2500" : "\u251c\u2500";
					lines.push(theme.fg("dim", branch) + " " + taskRow(r));
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) lines.push(theme.fg("dim", `Total: ${usageStr}`));
				}
				if (!expanded) lines.push(theme.fg("muted", "(Ctrl+O to expand)"));
				return new Text(lines.join("\n"), 0, 0);
			}


			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}
