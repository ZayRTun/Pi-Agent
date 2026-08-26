/**
 * OpenCode-style attention notifications for Pi.
 *
 * This is intentionally a small host extension rather than a second UI:
 * - completion and error sounds use OpenCode's default sound assets
 * - notifications use OSC 777, the same terminal-mediated mechanism used by
 *   Pi's own notify example and OpenCode's TUI attention feature
 * - question notifications integrate with rpiv-ask-user-question when present
 * - subagent completion sounds hook into the `subagent` tool result (the
 *   custom subagent extension at agent/extensions/subagent/) via tool_result
 * - settings are read from the `attention` object in Pi settings.json
 *
 * Enable it in ~/.pi/agent/settings.json:
 *
 *   "attention": {
 *     "enabled": true,
 *     "notifications": true,
 *     "sound": true,
 *     "volume": 0.4
 *   }
 */

import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, resolve } from "node:path";

const ASK_USER_BLOCKED_EVENT = "rpiv:ask-user:blocked";

// The custom subagent extension (agent/extensions/subagent/) registers a tool
// named "subagent" and returns per-task results in details.results with the
// same shape as its internal SingleResult type.
const SUBAGENT_TOOL_NAME = "subagent";
const RUNNING_EXIT_CODE = -1;

const SOUND_NAMES = ["default", "question", "permission", "error", "done", "subagent_done"] as const;
type SoundName = (typeof SOUND_NAMES)[number];

type AttentionSettings = {
	enabled?: unknown;
	notifications?: unknown;
	sound?: unknown;
	volume?: unknown;
	sound_pack?: unknown;
	sounds?: unknown;
};

type ResolvedAttentionSettings = {
	enabled: boolean;
	notifications: boolean;
	sound: boolean;
	volume: number;
	soundPack: string;
	sounds: Partial<Record<SoundName, string>>;
};

type SettingsFile = { attention?: AttentionSettings };

type SubagentResult = {
	agent?: unknown;
	task?: unknown;
	exitCode?: unknown;
	stopReason?: unknown;
	aborted?: unknown;
	errorMessage?: unknown;
};

type SubagentDetails = {
	mode?: unknown;
	results?: unknown;
};

const DEFAULT_SETTINGS: ResolvedAttentionSettings = {
	enabled: false,
	notifications: true,
	sound: true,
	volume: 0.4,
	soundPack: "opencode.default",
	sounds: {},
};

const BUILTIN_SOUND_FILES: Record<SoundName, string> = {
	default: "bip-bop-01.mp3",
	question: "bip-bop-03.mp3",
	permission: "staplebops-06.mp3",
	error: "nope-03.mp3",
	done: "bip-bop-01.mp3",
	subagent_done: "yup-01.mp3",
};

const SOUND_DIR = join(dirname(fileURLToPath(import.meta.url)), "sounds");

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSettings(path: string): SettingsFile {
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		return isRecord(value) && isRecord(value.attention) ? { attention: value.attention as AttentionSettings } : {};
	} catch {
		return {};
	}
}

function resolveConfiguredSound(value: string, baseDir: string): string {
	if (value.startsWith("file://")) {
		try {
			return fileURLToPath(value);
		} catch {
			return value;
		}
	}
	if (value.startsWith("~/")) return join(process.env.HOME ?? "", value.slice(2));
	return isAbsolute(value) ? value : resolve(baseDir, value);
}

function readAttention(path: string): { settings: AttentionSettings; baseDir: string } {
	return { settings: readSettings(path).attention ?? {}, baseDir: dirname(path) };
}

function booleanSetting(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function volumeSetting(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(1, Math.max(0, value));
}

function soundOverrides(value: unknown, baseDir: string): Partial<Record<SoundName, string>> {
	if (!isRecord(value)) return {};
	const result: Partial<Record<SoundName, string>> = {};
	for (const name of SOUND_NAMES) {
		const file = value[name];
		if (typeof file === "string" && file.trim()) result[name] = resolveConfiguredSound(file.trim(), baseDir);
	}
	return result;
}

export function resolveAttentionSettings(cwd: string, projectTrusted: boolean): ResolvedAttentionSettings {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
	const globalPath = join(home, ".pi", "agent", "settings.json");
	const projectPath = join(cwd, CONFIG_DIR_NAME, "settings.json");
	const global = readAttention(globalPath);
	const project = projectTrusted ? readAttention(projectPath) : { settings: {}, baseDir: dirname(projectPath) };
	const merged = { ...global.settings, ...project.settings };
	const mergedSounds = {
		...soundOverrides(global.settings.sounds, global.baseDir),
		...soundOverrides(project.settings.sounds, project.baseDir),
	};

	return {
		enabled: booleanSetting(merged.enabled, DEFAULT_SETTINGS.enabled),
		notifications: booleanSetting(merged.notifications, DEFAULT_SETTINGS.notifications),
		sound: booleanSetting(merged.sound, DEFAULT_SETTINGS.sound),
		volume: volumeSetting(merged.volume, DEFAULT_SETTINGS.volume),
		soundPack: typeof merged.sound_pack === "string" && merged.sound_pack.trim()
			? merged.sound_pack.trim()
			: DEFAULT_SETTINGS.soundPack,
		sounds: mergedSounds,
	};
}

export function normalizeNotificationText(value: string, fallback: string, limit: number): string {
	const normalized = value
		.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
		.replace(/[ \t]+/g, " ")
		.trim();
	return Array.from(normalized || fallback).slice(0, limit).join("");
}

function oscField(value: string, fallback: string, limit: number): string {
	return normalizeNotificationText(value, fallback, limit).replace(/[;\\]/g, ",");
}

export function emitDesktopNotification(title: string, message: string): boolean {
	if (!process.stdout.isTTY) return false;
	try {
		const safeTitle = oscField(title, "Pi", 80);
		const safeMessage = oscField(message, "Pi needs attention", 240);
		if (process.env.KITTY_WINDOW_ID) {
			// Kitty OSC 99: title first, then body as a second part.
			process.stdout.write(`\x1b]99;i=1:d=0;${safeTitle}\x1b\\`);
			process.stdout.write(`\x1b]99;i=1:p=body;${safeMessage}\x1b\\`);
		} else {
			// OSC 777 is supported by Ghostty, iTerm2, WezTerm, and others.
			process.stdout.write(`\x1b]777;notify;${safeTitle};${safeMessage}\x07`);
		}
		return true;
	} catch {
		return false;
	}
}

function soundPath(name: SoundName, settings: ResolvedAttentionSettings): string {
	return settings.sounds[name] ?? join(SOUND_DIR, BUILTIN_SOUND_FILES[name]);
}

function playSound(pi: ExtensionAPI, name: SoundName, settings: ResolvedAttentionSettings): void {
	if (process.platform !== "darwin" || !settings.sound) return;
	const path = soundPath(name, settings);
	if (!existsSync(path)) return;
	void pi.exec("/usr/bin/afplay", ["-v", String(settings.volume), path]).catch(() => undefined);
}

function notify(
	pi: ExtensionAPI,
	settings: ResolvedAttentionSettings,
	title: string,
	message: string,
	sound: SoundName,
	withDesktopNotification = true,
): void {
	if (!settings.enabled) return;
	if (withDesktopNotification && settings.notifications) emitDesktopNotification(title, message);
	playSound(pi, sound, settings);
}

function projectTitle(ctx: ExtensionContext): string {
	const name = ctx.cwd.split(/[\\/]/).filter(Boolean).at(-1);
	return name ? `Pi · ${name}` : "Pi";
}

function isResultRunning(result: SubagentResult): boolean {
	return result.exitCode === RUNNING_EXIT_CODE;
}

function isResultSuccess(result: SubagentResult): boolean {
	if (result.exitCode !== 0) return false;
	return result.stopReason !== "error" && result.stopReason !== "aborted" && result.aborted !== true;
}

function subagentSummary(results: SubagentResult[], anyFailed: boolean): string {
	const names = results
		.map((result) => (typeof result.agent === "string" && result.agent.trim() ? result.agent : "subagent"))
		.slice(0, 3)
		.join(", ");
	return `${names}: ${anyFailed ? "one or more tasks failed" : "Task completed"}`;
}

function isTerminalError(event: { messages?: unknown; willRetry?: boolean }): boolean {
	if (event.willRetry === true || !Array.isArray(event.messages)) return false;
	return event.messages.some((message) => {
		if (!isRecord(message) || message.role !== "assistant") return false;
		return message.stopReason === "error" || message.stopReason === "aborted";
	});
}

export default function registerOpenCodeAttention(pi: ExtensionAPI): void {
	let settings = DEFAULT_SETTINGS;
	let active = false;
	let errored = false;
	let isTuiSession = false;
	let projectName = "Pi";
	const unsubscribers: Array<() => void> = [];

	pi.on("session_start", (_event, ctx) => {
		isTuiSession = ctx.mode === "tui";
		settings = resolveAttentionSettings(ctx.cwd, ctx.isProjectTrusted());
		projectName = projectTitle(ctx);
		active = false;
		errored = false;
	});

	pi.on("agent_start", () => {
		if (!isTuiSession) return;
		active = true;
		errored = false;
	});

	pi.on("agent_end", (event) => {
		if (!isTuiSession || !isTerminalError(event)) return;
		errored = true;
		notify(pi, settings, projectName, "Session error", "error");
	});

	pi.on("agent_settled", () => {
		if (!isTuiSession || !active) return;
		active = false;
		if (errored) return;
		notify(pi, settings, projectName, "Session done", "done");
	});

	// The ask-user-question extension emits this public event while its UI is
	// awaiting input. It is intentionally optional so this extension also works
	// without that package installed.
	unsubscribers.push(pi.events.on(ASK_USER_BLOCKED_EVENT, (data) => {
		if (!isTuiSession || !isRecord(data) || data.active !== true) return;
		notify(pi, settings, projectName, "Question needs input", "question");
	}));

	// The custom subagent extension registers the "subagent" tool and returns
	// its per-task results in details.results. Match OpenCode: child work gets
	// its own sound, but no desktop banner.
	pi.on("tool_result", (event) => {
		if (!isTuiSession || event.toolName !== SUBAGENT_TOOL_NAME) return;
		const details = event.details as SubagentDetails | undefined;
		if (!isRecord(details) || !Array.isArray(details.results)) return;
		const results = details.results.filter(isRecord) as unknown as SubagentResult[];
		if (results.length === 0 || results.some(isResultRunning)) return;
		const anyFailed = results.some((result) => !isResultSuccess(result));
		const sound: SoundName = anyFailed ? "error" : "subagent_done";
		notify(pi, settings, projectName, subagentSummary(results, anyFailed), sound, false);
	});

	pi.on("session_shutdown", () => {
		isTuiSession = false;
		active = false;
		for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
	});
}
