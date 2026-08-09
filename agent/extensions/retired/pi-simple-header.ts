/**
 * pi-simple-header — Clean, minimal Pi header extension
 *
 * Simplified from pi-cc-header:
 * - Static Pi logo (no animation), no IBM stripes, no Minecraft gradient
 * - Logo and version use the current theme's accent color
 * - No commands
 */

import {
	VERSION,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

/* ── Pi logo cell set (same as pi-cc-header phase 6 final frame) ── */

const LOGO_CELLS = new Set(
	"3,2 3,3 3,4 4,4 4,2 5,2 5,3 5,5 6,2 6,5".split(" "),
);

/* ── Helpers ── */

function formatCwd(cwd: string): string {
	const home = process.env.HOME;
	return home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

function padRight(text: string, width: number): string {
	const clipped = truncateToWidth(text, width, "");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
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
	const settingsPath = join(
		process.env.HOME ?? "",
		".pi",
		"agent",
		"settings.json",
	);
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
	const scanPkg = (pkgDir: string) => {
		const pj = join(pkgDir, "package.json");
		if (!existsSync(pj)) return;
		try {
			const m = JSON.parse(readFileSync(pj, "utf-8"));
			if (!m.pi || !Array.isArray(m.pi.prompts)) return;
			for (const e of m.pi.prompts) {
				let d = join(pkgDir, e);
				if (!existsSync(d)) d = join(pkgDir, e.replace(/^(\.\.?\/)+/, ""));
				if (existsSync(d))
					total += readdirSync(d).filter((f: string) =>
						f.endsWith(".md"),
					).length;
			}
		} catch { /* skip */ }
	};

	try {
		for (const name of readdirSync(root)) {
			if (name.startsWith(".")) continue;
			if (name.startsWith("@")) {
				let subs: string[];
				try { subs = readdirSync(join(root, name)); } catch { continue; }
				for (const sub of subs) scanPkg(join(root, name, sub));
			} else {
				scanPkg(join(root, name));
			}
		}
	} catch { /* skip */ }

	return total;
}

function agentsLabel(ctx: ExtensionContext): string {
	const home = process.env.HOME ?? "";
	const g = existsSync(join(home, ".pi", "agent", "AGENTS.md"));
	const p = existsSync(join(ctx.cwd, "AGENTS.md")) ||
		existsSync(join(ctx.cwd, ".pi", "AGENTS.md"));
	if (g && p) return "Aa";
	if (g) return "A";
	if (p) return "a";
	return "";
}

/* ── Component ── */

const LOGO_W = 12;
const LEFT_PAD = " "; // left margin for the whole header

class SimpleHeader implements Component {
	constructor(
		private readonly pi: ExtensionAPI,
		private readonly ctx: ExtensionContext,
	) { }

	render(width: number): string[] {
		const theme = this.ctx.ui.theme;
		const accent = (s: string) => theme.fg("accent", s);
		const muted = (s: string) => theme.fg("muted", s);

		// Build logo lines (cols 2–7 from original phase 6 — trimmed left+right padding)
		const logoLines: string[] = [];
		for (let y = 1; y <= 7; y++) {
			let line = "";
			for (let x = 2; x <= 7; x++) {
				line += LOGO_CELLS.has(`${y},${x}`) ? accent("██") : "  ";
			}
			logoLines.push(line);
		}

		const skills = countSkills(this.ctx);
		const prompts = countPrompts();
		const exts = countPackages();
		const agents = agentsLabel(this.ctx);

		const model = this.ctx.model?.id ?? "Default";
		const effort = this.pi.getThinkingLevel();
		const cwd = formatCwd(this.ctx.cwd);

		const skillText = `${skills} skills`;
		const extText = `${exts} extensions`;
		const statsLine = `${skillText} · ${prompts} prompts · ${extText}`;

		const piText = `${accent(`Pi v${VERSION}`)}`;
		const infoMaxW = Math.max(0, width - LOGO_W);

		const info: Record<number, string> = {
			2: piText,
			3: muted(`${model} · ${effort}`),
			4: muted(statsLine),
			5: muted(agents ? `${agents} · ${cwd}` : cwd),
		};

		const lines: string[] = [];
		for (let i = 1; i < logoLines.length; i++) {
			const right = info[i] != null ? padRight(info[i], infoMaxW) : "";
			lines.push(padRight(logoLines[i] ?? "", LOGO_W) + right);
		}
		return lines.map((l) => padRight(truncateToWidth(LEFT_PAD + l, width, ""), width));
	}

	invalidate(): void { }
	dispose(): void { }
}

/* ── Entry point ── */

export default function(pi: ExtensionAPI) {
	let active: SimpleHeader | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
		setTimeout(() => {
			ctx.ui.setHeader(() => {
				active?.dispose();
				active = new SimpleHeader(pi, ctx);
				return active;
			});
		}, 0);
	});
}
