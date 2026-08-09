/**
 * prime-header — Prime Agent "BrandSplashHeader" replica for Pi
 *
 * Ports the launch/welcome layout from prime-agent
 * (packages/coding-agent/src/modes/interactive/interactive-mode.ts,
 *  class BrandSplashHeader):
 *   - ASCII butterfly logo on the left, side-by-side with metadata
 *     (version / model · thinking / cwd / stats / start hint)
 *   - Categorized control legends below the brand mark
 */

import {
	VERSION,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/* ── Header logo (5 rows of art, centered within a 10-row footprint) ── */

const HEADER_LOGO = `

░       ░░░        ░
▒  ▒▒▒▒  ▒▒▒▒▒  ▒▒▒▒
▓       ▓▓▓▓▓▓  ▓▓▓▓
█  ███████████  ████
█  ████████        █


`;

const LOGO_LINES = HEADER_LOGO.split("\n");
const LOGO_WIDTH = Math.max(...LOGO_LINES.map((l) => visibleWidth(l)));
const GUTTER = 4;
const LABEL_WIDTH = 9;

/* ── Helpers ── */

function formatCwd(cwd: string): string {
	const home = homedir();
	const normalized = cwd.replace(/\\/g, "/");
	const h = home.replace(/\\/g, "/");
	if (h && normalized === h) return "~";
	if (h && normalized.startsWith(`${h}/`)) return `~${normalized.slice(h.length)}`;
	return normalized;
}

function truncateMiddle(value: string, width: number): string {
	if (visibleWidth(value) <= width) return value;
	if (width <= 1) return truncateToWidth(value, width, "");
	const ellipsis = "…";
	const normalized = value.replace(/\\/g, "/");
	const prefix = normalized.startsWith("~/") ? "~/" : normalized.startsWith("/") ? "/" : "";
	const body = prefix ? normalized.slice(prefix.length) : normalized;
	const parts = body.split("/").filter((p) => p.length > 0);
	const last = parts.pop() ?? "";
	const prev = parts.pop();
	const suffix = prev ? `${prev}/${last}` : last;
	const candidate = `${prefix}${ellipsis}/${suffix}`;
	if (visibleWidth(candidate) <= width) return candidate;
	return truncateToWidth(candidate, width);
}

function countSkills(ctx: ExtensionContext): number {
	const home = process.env.HOME ?? "";
	let count = 0;
	for (const d of [
		join(home, ".agents", "skills"),
		join(ctx.cwd, ".agents", "skills"),
		join(home, ".pi", "agent", "skills"),
		join(ctx.cwd, ".pi", "skills"),
	]) {
		if (!existsSync(d)) continue;
		try {
			for (const e of readdirSync(d, { withFileTypes: true })) {
				if (e.isDirectory() || e.name.endsWith(".md")) count++;
			}
		} catch { /* skip */ }
	}
	return count;
}

function countPackages(): number {
	const settingsPath = join(process.env.HOME ?? "", ".pi", "agent", "settings.json");
	try {
		const s = JSON.parse(readFileSync(settingsPath, "utf-8"));
		return Array.isArray(s.packages) ? s.packages.length : 0;
	} catch {
		return 0;
	}
}

function countPrompts(): number {
	const home = process.env.HOME ?? "";
	const root = join(home, ".pi", "agent", "npm", "node_modules");
	if (!existsSync(root)) return 0;
	let total = 0;
	try {
		for (const name of readdirSync(root)) {
			if (name.startsWith(".")) continue;
			const dirs = name.startsWith("@")
				? readdirSync(join(root, name)).map((s) => join(name, s))
				: [name];
			for (const sub of dirs) {
				const pj = join(root, sub, "package.json");
				if (!existsSync(pj)) continue;
				try {
					const m = JSON.parse(readFileSync(pj, "utf-8"));
					if (!m.pi || !Array.isArray(m.pi.prompts)) continue;
					for (const e of m.pi.prompts) {
						let d = join(root, sub, e);
						if (!existsSync(d)) d = join(root, sub, e.replace(/^(\.\.?\/)+/, ""));
						if (existsSync(d)) total += readdirSync(d).filter((f: string) => f.endsWith(".md")).length;
					}
				} catch { /* skip */ }
			}
		}
	} catch { /* skip */ }
	return total;
}

/* ── Component ── */

class PrimeSplashHeader implements Component {
	private readonly pi: ExtensionAPI;
	private readonly ctx: ExtensionContext;

	constructor(pi: ExtensionAPI, ctx: ExtensionContext) {
		this.pi = pi;
		this.ctx = ctx;
	}

	invalidate(): void {
		// Render output derives from current theme/session state.
	}

	dispose(): void {
		// Nothing to clean up.
	}

	render(width: number): string[] {
		const theme = this.ctx.ui.theme;
		const safeWidth = Math.max(1, width);
		const paddingX = safeWidth > 1 ? 1 : 0;
		const contentWidth = Math.max(1, safeWidth - paddingX * 2);
		const metaWidth = contentWidth - LOGO_WIDTH - GUTTER;
		const showMeta = metaWidth >= LABEL_WIDTH + 8;
		const valueWidth = Math.max(1, metaWidth - LABEL_WIDTH);

		const labelled = (label: string, value: string) => {
			const displayValue =
				label === "cwd" ? truncateMiddle(value, valueWidth) : truncateToWidth(value, valueWidth);
			return (
				theme.fg("dim", label.padEnd(LABEL_WIDTH)) +
				theme.fg("muted", displayValue)
			);
		};

		const model = this.ctx.model?.id ?? "—";
		const thinking = this.pi.getThinkingLevel() ?? "high";
		const cwd = formatCwd(this.ctx.cwd);
		const stats = `${countSkills(this.ctx)} skills · ${countPrompts()} prompts · ${countPackages()} extensions`;

		const metaLines: string[] = [];
		if (showMeta) {
			metaLines.push(
				labelled("version", `v${VERSION}`),
				labelled("model", `${model} · ${thinking}`),
				labelled("cwd", cwd),
				labelled("setup", stats),
			);
		}

		const metaStart = Math.max(0, Math.floor((LOGO_LINES.length - metaLines.length) / 2));
		const padLine = (content: string): string =>
			" ".repeat(paddingX) +
			truncateToWidth(content, contentWidth, "") +
			" ".repeat(Math.max(0, safeWidth - paddingX - visibleWidth(content)));

		const lines = [""];
		for (let i = 0; i < LOGO_LINES.length; i++) {
			const logoLine = theme.fg("text", LOGO_LINES[i] ?? "");
			const meta = showMeta && i >= metaStart && i < metaStart + metaLines.length ? metaLines[i - metaStart]! : "";
			const padding = showMeta
				? " ".repeat(Math.max(0, LOGO_WIDTH - visibleWidth(LOGO_LINES[i] ?? "") + GUTTER))
				: "";
			lines.push(padLine(logoLine + padding + meta));
		}

		return lines;
	}
}

/* ── Entry point ── */

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setHeader(() => new PrimeSplashHeader(pi, ctx));
	});
}
