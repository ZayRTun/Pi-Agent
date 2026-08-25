/**
 * Custom Status-Bar Footer Extension
 *
 * Renders a clean, two-column, single-line status bar that updates at runtime
 * and responds to theme changes.
 *
 * Left:   <pwd> |  <branch> | <model> | <thinking>
 * Right: 󰧑 [████░░░░░░░░░░░░░░] 12.5% · 25k/200k · 1.3k 2.4k
 *
 * Toggle with /footer
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";

export default function(pi: ExtensionAPI) {
	let enabled = true; // custom footer on by default
	let requestRender: (() => void) | null = null;
	let partialOutputTokens = 0;
	// Prime-style session state: ○ idle / ● working (agent streaming or running tools)
	let sessionState: "idle" | "working" = "idle";

	function estimateOutputFromMessage(msg: any): number {
		let chars = 0;
		const content = Array.isArray(msg.content) ? msg.content : [msg.content];
		for (const block of content) {
			if (typeof block === "string") chars += block.length;
			else if (block?.type === "text") chars += block.text?.length ?? 0;
		}
		return Math.round(chars / 4);
	}

	// ── Toggle command ─────────────────────────────────────────────
	pi.registerCommand("footer", {
		description: "Toggle custom footer on/off",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			if (enabled) {
				installFooter(ctx);
				ctx.ui.notify("Custom footer enabled", "info");
			} else {
				ctx.ui.setFooter(undefined);
				requestRender = null;
				ctx.ui.notify("Default footer restored", "info");
			}
		},
	});

	// ── Streaming events (live I/O estimate) ───────────────────────
	pi.on("message_update", async (event: any) => {
		if (event.message?.role === "assistant") {
			sessionState = "working";
			partialOutputTokens = estimateOutputFromMessage(event.message);
		}
		requestRender?.();
	});

	pi.on("message_end", async (event: any) => {
		if (event.message?.role === "assistant") {
			sessionState = "idle";
			partialOutputTokens = 0;
		}
		requestRender?.();
	});

	pi.on("agent_start", () => {
		sessionState = "working";
		requestRender?.();
	});

	pi.on("agent_end", () => {
		sessionState = "idle";
		requestRender?.();
	});

	pi.on("model_select", () => requestRender?.());
	pi.on("thinking_level_select", () => requestRender?.());

	// ── Session lifecycle ──────────────────────────────────────────
	pi.on("session_start", async (_event, ctx) => {
		if (enabled) installFooter(ctx);
	});

	// ── Footer installer ───────────────────────────────────────────
	function installFooter(ctx: any) {
		ctx.ui.setFooter((tui: any, theme: any, footerData: any) => {
			requestRender = () => tui.requestRender();

			const unsubBranch = footerData.onBranchChange(() =>
				tui.requestRender(),
			);

			return {
				dispose: () => {
					unsubBranch();
					requestRender = null;
				},

				invalidate() { },

				render(width: number): string[] {
					// ── Left column ────────────────────────────────
					const home = homedir();
					const pwd = ctx.cwd.replace(home, "~");
					const branch = footerData.getGitBranch() ?? "no-repo";
					const modelId = ctx.model?.id ?? "no-model";
					const thinkingLevel = pi.getThinkingLevel();

					const sep = theme.fg("dim", " | ");

					const stateGlyph =
						sessionState === "working"
							? theme.fg("accent", "●")
							: theme.fg("dim", "○");

					const leftPwd = theme.fg("accent", `${pwd}`);
					const gitIcon = theme.fg("muted", "");
					const leftBranch = `${gitIcon} ${theme.fg("text", branch)}`;
					const modelStyled = theme.fg("text", modelId);
					const thinkingStyled = theme.fg("muted", thinkingLevel);

					const leftSegment = `${stateGlyph} ${leftPwd}${sep}${leftBranch}${sep}${modelStyled}${sep}${thinkingStyled}`;

					// ── Right column ──────────────────────────────

					const fmtN = (n: number): string => {
						if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
						if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "k";
						return `${n}`;
					};
					const fmtR = (n: number): string => {
						if (n >= 1_000_000) return Math.round(n / 1_000_000) + "M";
						if (n >= 1_000) return Math.round(n / 1_000) + "k";
						return `${n}`;
					};

					// Cumulative I/O tokens (all entries + live partial)
					let inputTokens = 0, outputTokens = 0;
					for (const e of ctx.sessionManager.getEntries()) {
						if (e.type === "message") {
							const m = e.message;
							if (m.role === "assistant" || (m.role === "toolResult" && m.usage)) {
								inputTokens += m.usage?.input || 0;
								outputTokens += m.usage?.output || 0;
							}
						} else if ((e.type === "branch_summary" || e.type === "compaction") && e.usage) {
							inputTokens += e.usage.input || 0;
							outputTokens += e.usage.output || 0;
						}
					}
					outputTokens += partialOutputTokens;

					const ioPart = `${theme.fg("warning", "")}${theme.fg("text", fmtR(inputTokens))} ${theme.fg("warning", "")}${theme.fg("text", fmtR(outputTokens))}`;

					// Context usage
					const usage = ctx.getContextUsage();
					const tokensUsed = usage?.tokens ?? 0;
					const maxTokens = usage?.contextWindow ?? ctx.model?.contextWindow ?? 128_000;
					const pct = usage?.percent ?? 0;

					// Progress bar
					const barWidth = 20;
					const filled = Math.min(Math.round((tokensUsed / maxTokens) * barWidth), barWidth);
					const bar = "\u{2588}".repeat(Math.max(0, filled)) +
						"\u{2591}".repeat(Math.max(0, barWidth - filled));

					const barColor =
						tokensUsed >= 150_000 ? "error"
							: tokensUsed > 100_000 ? "warning"
								: "success";
					const pctColor =
						pct > 90 ? "error" : pct > 70 ? "warning" : "muted";

					// const rightSegment =
					// 	`${theme.fg(barColor, "󰧑")} \u{2595}${theme.fg(barColor, bar)}\u{258F} ` +
					// 	`${theme.fg(pctColor, `${pct.toFixed(1)}%`)} \u{00B7} ` +
					// 	`${theme.fg("text", `${fmtN(tokensUsed)}/${fmtN(maxTokens)}`)} \u{00B7} ` +
					// 	ioPart;

					const rightSegment =
						`${theme.fg(barColor, fmtN(tokensUsed))}/${fmtN(maxTokens)} \u{00B7} ` +
						ioPart;

					// ── Assemble ──────────────────────────────────
					const gap = " ".repeat(
						Math.max(1, width - visibleWidth(leftSegment) - visibleWidth(rightSegment)),
					);

					// Clean full-row gap between the editor block and the status bar.
					// (A half-row gap requires a half-block row, which always leaves a
					// black half visible somewhere — the "line" above the input. A
					// solid Prime-exact editor + perfect centering forces a full row.)
					// return ["", truncateToWidth(`${leftSegment}${gap}${rightSegment}`, width)];
					return [truncateToWidth(`${leftSegment}${gap}${rightSegment}`, width)];
				},
			};
		});
	}
}
