/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	toolsSpecified: boolean;
	allowSubagents: boolean;
	model?: string;
	/** Validated `thinking` value; absent means the Sub-agent inherits the session's level. */
	thinking?: ThinkingLevel;
	/** The unrecognized `thinking` value, kept so execute() can warn about it. */
	invalidThinking?: string;
	/** Declared per-agent timeout in minutes; absent means the call-level or global default. */
	timeoutMinutes?: number;
	/** Badge color for the agent name (Claude-Code style); absent or invalid renders no badge. */
	color?: string;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

/**
 * Raw agent frontmatter. Values are `unknown` because `parseFrontmatter` runs a
 * real YAML parser, so any scalar or collection can appear here.
 *
 * A type alias rather than an interface: `parseFrontmatter` constrains its
 * parameter to `Record<string, unknown>`, and only an alias picks up the
 * implicit index signature that satisfies it.
 */
type AgentFrontmatter = {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	allowSubagents?: unknown;
	model?: unknown;
	thinking?: unknown;
	timeoutMinutes?: unknown;
	color?: unknown;
};

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Bounds (minutes) for subagent timeouts, enforced wherever a timeout is declared. */
export const MIN_TIMEOUT_MINUTES = 1;
export const MAX_TIMEOUT_MINUTES = 480;
/** Timeout used when neither the call nor the Agent definition declares one. */
export const DEFAULT_TIMEOUT_MINUTES = 30;

/**
 * Clamp a raw timeout value into bounds. Anything that is not a finite
 * number yields undefined ("not declared"), so bad frontmatter can never
 * produce a zero or infinite timeout.
 */
function clampTimeoutMinutes(value: unknown): number | undefined {
	const n = typeof value === "string" ? Number(value.trim()) : value;
	if (typeof n !== "number" || !Number.isFinite(n)) return undefined;
	return Math.min(Math.max(n, MIN_TIMEOUT_MINUTES), MAX_TIMEOUT_MINUTES);
}

/**
 * Resolve the effective timeout in minutes.
 * Precedence: call-level param, then the Agent definition, then the default.
 */
export function resolveTimeoutMinutes(callLevel?: unknown, agentLevel?: unknown): number {
	return clampTimeoutMinutes(callLevel) ?? clampTimeoutMinutes(agentLevel) ?? DEFAULT_TIMEOUT_MINUTES;
}

/**
 * Split a frontmatter `thinking` value into a usable level and, when the value
 * is unrecognized, the raw text so the caller can warn about it.
 *
 * An empty field (`thinking:`), which YAML parses as null, means "not declared"
 * rather than a mistake. An unrecognized value is reported rather than silently
 * ignored: a typo would otherwise look like a level that simply never took
 * effect, which is harder to notice than a warning.
 */
function parseThinking(value: unknown): { level?: ThinkingLevel; invalid?: string } {
	if (value === undefined || value === null) return {};
	if (typeof value !== "string") return { invalid: String(value) };

	const level = value.trim();
	if ((THINKING_LEVELS as readonly string[]).includes(level)) return { level: level as ThinkingLevel };
	return { invalid: level };
}

/**
 * Normalize a frontmatter `tools` value to a list of tool names.
 *
 * Both spellings are valid YAML and both are in use:
 *
 *     tools: read, bash        # string
 *     tools: [read, bash]      # array
 *
 * so accept either. Anything else (a number, a map, a nested list) yields no
 * tools rather than throwing: this runs inside agent discovery, where a single
 * bad file must not take down every other agent in the same directory.
 */
function parseToolList(value: unknown): string[] | undefined | null {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) && typeof value !== "string") return null;

	const raw = Array.isArray(value) ? value : value.split(",");
	if (raw.some((tool) => typeof tool !== "string")) return null;
	return raw.map((tool) => tool.trim()).filter(Boolean);
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		let frontmatter: AgentFrontmatter;
		let body: string;
		try {
			({ frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content));
		} catch {
			// A malformed agent must not prevent valid agents from loading.
			continue;
		}

		if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") {
			continue;
		}

		const tools = parseToolList(frontmatter.tools);
		if (tools === null) continue;

		const thinking = parseThinking(frontmatter.thinking);

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools,
			toolsSpecified: frontmatter.tools !== undefined,
			allowSubagents: frontmatter.allowSubagents === true,
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
			thinking: thinking.level,
			invalidThinking: thinking.invalid,
			timeoutMinutes: clampTimeoutMinutes(frontmatter.timeoutMinutes),
			color: typeof frontmatter.color === "string" ? frontmatter.color : undefined,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents.sort((a, b) => a.name.localeCompare(b.name));
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	const agentMap = new Map<string, AgentConfig>();

	if (scope === "both") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	} else if (scope === "user") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	} else {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}

// ── Agent name badges ──────────────────────────────────────────────────────
// Claude-Code-style name badges: the configured color becomes the background,
// with black or white text picked by WCAG contrast. Adapted from the
// pi-subagents extension's agent-color.ts.

const NAMED_AGENT_COLORS: Record<string, string> = {
	red: "#DC2626",
	blue: "#6A9BCC",
	green: "#16A34A",
	yellow: "#CA8A04",
	purple: "#827DBD",
	orange: "#D97757",
	pink: "#C46686",
	cyan: "#0891B2",
};

/** Resolve a frontmatter `color:` value to normalized #RRGGBB, or undefined. */
export function resolveAgentColor(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	const resolved = NAMED_AGENT_COLORS[normalized] ?? normalized;
	return /^#[0-9a-f]{6}$/i.test(resolved) ? resolved.toUpperCase() : undefined;
}

type BadgeRgb = { r: number; g: number; b: number };

function parseBadgeHex(hex: string): BadgeRgb {
	return {
		r: Number.parseInt(hex.slice(1, 3), 16),
		g: Number.parseInt(hex.slice(3, 5), 16),
		b: Number.parseInt(hex.slice(5, 7), 16),
	};
}

function badgeLuminance({ r, g, b }: BadgeRgb): number {
	const linear = (value: number) => {
		const channel = value / 255;
		return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

export interface AgentBadgeTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
	getColorMode?: () => string;
}

/**
 * Render an agent name as a padded background badge when `color` is valid;
 * otherwise fall back to the theme's toolTitle styling. Invalid colors render
 * no badge rather than throwing: discovery must never break on cosmetics.
 */
export function renderAgentBadge(
	name: string,
	color: string | undefined,
	theme: AgentBadgeTheme,
	opts?: { bold?: boolean },
): string {
	const resolved = resolveAgentColor(color);
	const label = opts?.bold === false ? name : theme.bold(name);
	if (!resolved) return theme.fg("toolTitle", label);
	const rgb = parseBadgeHex(resolved);
	const mode = theme.getColorMode?.() ?? "truecolor";
	let open: string;
	let shown: BadgeRgb = rgb;
	if (mode === "256color") {
		// Quantize to the xterm-256 cube; judge contrast against the shown color.
		const steps = [0, 95, 135, 175, 215, 255];
		const near = (v: number) => steps.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));
		shown = { r: near(rgb.r), g: near(rgb.g), b: near(rgb.b) };
		const idx = 16 + 36 * steps.indexOf(shown.r) + 6 * steps.indexOf(shown.g) + steps.indexOf(shown.b);
		open = `\u001b[48;5;${idx}m`;
	} else {
		open = `\u001b[48;2;${rgb.r};${rgb.g};${rgb.b}m`;
	}
	const ink = badgeLuminance(shown) > 0.179 ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 };
	const fgOpen =
		mode === "256color"
			? `\u001b[38;5;${ink.r === 0 ? 16 : 231}m`
			: `\u001b[38;2;${ink.r};${ink.g};${ink.b}m`;
	return `${open}${fgOpen} ${label} \u001b[39m\u001b[49m`;
}
