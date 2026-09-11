/**
 * auto-session-name — names each session after the user's actual first prompt.
 *
 * The resume picker shows `session.name ?? session.firstMessage`. When a session
 * starts with a skill command (e.g. `/implement issue #85`), pi injects the skill
 * content as a `<skill ...>` block ahead of the prompt, so the picker previews the
 * XML dump instead of "issue #85". This extension listens to the `input` event,
 * which fires BEFORE skill/template expansion, and derives a clean session name
 * from the raw prompt text.
 *
 * Result: the picker shows "issue #85" instead of
 * `<skill name="implement" location="...">References are relative to ...`
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_NAME_LENGTH = 80;

/**
 * Derive a session name from raw input text (pre-expansion).
 * Returns null when no sensible name can be derived.
 */
function deriveSessionName(rawText: string | undefined): string | null {
	let text = (rawText ?? "").trim();
	if (!text) {
		return null;
	}

	// Slash command with args (e.g. "/implement issue #85" or "/skill:tdd write tests"):
	// use the args as the name — that's what the user actually typed as the task.
	// Bare commands ("/compact", "/model") yield no name.
	if (text.startsWith("/")) {
		const match = text.match(/^\/\S+\s+([\s\S]+)$/);
		if (!match) {
			return null;
		}
		text = match[1].trim();
		if (!text) {
			return null;
		}
	}

	const firstLine = text.split("\n", 1)[0].trim();
	if (!firstLine) {
		return null;
	}
	if (firstLine.length > MAX_NAME_LENGTH) {
		return `${firstLine.slice(0, MAX_NAME_LENGTH - 1)}…`;
	}
	return firstLine;
}

export default function (pi: ExtensionAPI) {
	pi.on("input", async (event, _ctx) => {
		// Never derive names from extension-injected messages
		if (event.source === "extension") {
			return { action: "continue" };
		}

		// Respect existing names — user renames (ctrl+r) are never overwritten.
		// Only set when the session is still unnamed, so mid-session steering
		// messages are ignored once the name exists.
		if (pi.getSessionName()) {
			return { action: "continue" };
		}

		const name = deriveSessionName(event.text);
		if (name) {
			pi.setSessionName(name);
		}

		return { action: "continue" };
	});
}
