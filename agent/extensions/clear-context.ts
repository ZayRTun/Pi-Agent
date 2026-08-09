/**
 * Clear Extension
 *
 * Adds a `/clear` command that resets the session's conversation history,
 * token counter, and TUI — keeping system instructions, base configurations,
 * and project settings intact.
 *
 * HOW IT WORKS:
 *   `ctx.newSession()` creates a brand-new replacement session file with
 *   no conversation history.  The old session is linked via parentSession
 *   so you can still find it in the session browser, but the new session
 *   starts completely fresh — zero messages, zero tokens, clean TUI.
 *
 *   System instructions (AGENTS.md, SYSTEM.md, skills, etc.) are loaded
 *   from disk independently of the session, so they survive the switch.
 *
 * INSTALLATION:
 *   Place this file at:
 *     ~/.pi/agent/extensions/clear-context.ts
 *
 *   Then run /reload in pi, or restart pi.
 *
 * USAGE:
 *   /clear     — Clears conversation history. System instructions stay.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("clear", {
		description:
			"Clear the session's conversation history and reset the token context window. " +
			"System instructions, configurations, and project settings are preserved.",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			// Wait for any in-flight agent work to settle before we switch sessions
			await ctx.waitForIdle();

			const oldSessionFile = ctx.sessionManager.getSessionFile();

			const result = await ctx.newSession({
				parentSession: oldSessionFile,

				// withSession runs in the REPLACEMENT session context.
				// Do NOT use the original `ctx` or `pi` here — they are stale.
				// Only use the `replacementCtx` that's passed in.
				withSession: async (replacementCtx) => {
					replacementCtx.ui.notify("Session context cleared.", "info");
				},
			});

			if (result.cancelled) {
				ctx.ui.notify("Clear was cancelled by another extension.", "warning");
			}
		},
	});
}
