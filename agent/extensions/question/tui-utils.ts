/**
 * Shared TUI utilities for Question interaction components.
 *
 * Extracted to eliminate duplicated code between question-tui.ts
 * and batch-tui.ts.
 */

import type { NormalizedOption, NormalizedQuestion } from "./types.js";

/** Option with an `isOther` flag for the "Type something…" entry. */
export type OtherOption = NormalizedOption & { isOther?: boolean };

/**
 * Build the list of displayable options for a question.
 * Appends a "Type something…" Other option when `allowOther` is true.
 */
export function currentOptions(
  question: NormalizedQuestion,
): OtherOption[] {
  const opts: OtherOption[] = [...question.options];
  if (question.allowOther) {
    opts.push({
      label: "Type something\u2026",
      value: "__other__",
      isOther: true,
    });
  }
  return opts;
}

/** Word-wrapping line builder for terminal-width-constrained rendering. */
export function createLineBuilder(width: number) {
  const w = Math.max(1, width);
  const lines: string[] = [];

  function addLine(text: string) {
    lines.push(text);
  }

  function addWrapped(text: string) {
    const words = text.split(" ");
    let current = "";
    for (const word of words) {
      if (current && current.length + 1 + word.length > w) {
        addLine(current);
        current = word;
      } else {
        current = current ? current + " " + word : word;
      }
    }
    if (current) addLine(current);
  }

  return { lines, addLine, addWrapped, width: w };
}
