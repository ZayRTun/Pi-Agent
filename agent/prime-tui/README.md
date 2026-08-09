# Prime Agent TUI for Pi

Replicates the [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) TUI in
this Pi (0.84.1) setup. Prime Agent is a hard fork of pi-mono
(`@earendil-works/pi`, v0.7.1); the reference source is vendored at
`./prime-agent-src` (MIT licensed).

## What was ported

| Piece | Prime source | How it's applied here |
|---|---|---|
| **Editor box** — full-width dark surface block, no borders, `> ` prompt | `packages/tui/src/components/editor.ts` (`useBackgroundSurface` + `promptPrefix`) | Patch: `pi-tui/dist/components/editor.js` + theme supplies `backgroundColor`/`commandColor` |
| **Slash (`/`) popover** — two-column (`› /cmd` + `[args]`/source right), `↑/↓ n more`, active description at bottom | `packages/tui/src/components/select-list.ts` (`showItemMetadata`, `showSelectedDescription`, `showDirectionalScrollInfo`) + `autocomplete.ts` (`argumentHint` passthrough) | Patches: `pi-tui/dist/components/select-list.js`, `pi-tui/dist/autocomplete.js`, layout flags in `editor.js` |
| **Theme** — Prime `prime.json` palette (violet `#7c6faf` on near-black `#050506`) | `packages/coding-agent/src/modes/interactive/theme/prime.json` | New theme: `~/.pi/agent/themes/prime.json` (mapped to the modern 52-token schema) |
| **Header / welcome** — butterfly ASCII logo side-by-side with metadata + categorized control legends | `interactive-mode.ts` `BrandSplashHeader` + `keybinding-hints.ts` | New extension: `~/.pi/agent/extensions/prime-header.ts` |
| **Status bar** — session state, model, reasoning, token % | Prime's footer is intentionally empty; the status bar comes from the modern Pi footer contract | `~/.pi/agent/extensions/custom-footer.ts` (added `○` idle / `●` working state glyph) |

## Files

```
~/.pi/agent/themes/prime.json                      # active theme (settings.json "theme": "prime")
~/.pi/agent/extensions/prime-header.ts             # splash header (replaces pi-simple-header)
~/.pi/agent/extensions/custom-footer.ts            # status bar footer
~/.pi/agent/prime-tui/apply-patches.sh             # reapply script (see below)
~/.pi/agent/prime-tui/patched/                     # canonical patched dist files
~/.pi/agent/prime-tui/backup/                      # pristine pre-patch copies (for revert)
~/.pi/agent/prime-tui/prime-agent-src/             # Prime Agent source reference (clone)
```

## Reapplying after a Pi update

Pi ships as an npm package, so `npm update` of `@earendil-works/pi-coding-agent`
wipes `node_modules`. After any update:

```bash
bash ~/.pi/agent/prime-tui/apply-patches.sh
```

## Reverting

Copy the pristine files from `~/.pi/agent/prime-tui/backup/` back over the paths
listed in `apply-patches.sh`, then restore `pi-simple-header.ts` from
`extensions/retired/` and set `"theme"` back in `settings.json`.

## Notes / known ceilings (`ponytail:`)

- The editor internals (`layoutText`) are private in modern pi-tui, so the Prime
  editor/popover had to be ported into the compiled dist rather than done via the
  extension API. Keep `apply-patches.sh` in the loop on upgrades.
- Prime anchors its popover via a TUI overlay (`aboveMarker`); modern pi-tui
  dropped marker-anchored overlays, so the popover renders inline directly above
  the input box instead of floating over chat content. Visually equivalent for the
  common one-line input case.
- The popover background uses the theme's `customMessageBg` token (closest modern
  equivalent to Prime's `toolPanelBg`); tweak in `prime.json` if you want a
  different popover shade.
- `pi-simple-header.ts` was moved to `extensions/retired/` because pi auto-loads
  every `.ts` file in `~/.pi/agent/extensions/` in addition to the `settings.json`
  list.
- The gap between the editor block and the footer is a clean full clear row
  rendered by the custom footer. This is deliberate: a half-row gap requires a
  half-block (▀) row, and a half-block row always leaves its unpainted half as a
  visible black strip (that was the "line" above the input). A half-row gap,
  perfect vertical centering, and a solid Prime-exact editor are mutually
  exclusive in a terminal (cells are atomic); the full-row gap is the only
  combination that is seamless, centered, and spaced. If flush is preferred,
  remove the leading "" from the footer's render.
