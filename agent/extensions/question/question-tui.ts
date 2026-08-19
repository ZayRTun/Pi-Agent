/**
 * TUI component for the single-Question interaction.
 *
 * Handles free-text, single-select, multi-select, and custom "Other"
 * input modes. Provides nested Escape behavior: first Escape exits
 * text editing, second Escape cancels the interaction.
 *
 * Skip is a separate interaction control, not an ordinary option.
 */

import type { NormalizedOption, NormalizedQuestion } from "./types.js";

/** Result from the TUI interaction. */
export interface TuiQuestionResult {
  status: "answered" | "cancelled" | "skipped";
  selectedValues?: string[];
  selectedOption?: NormalizedOption;
  customText?: string;
}

/** Callback to signal the result. */
export type DoneCallback = (result: TuiQuestionResult) => void;

/**
 * Creates a Component-like object for ctx.ui.custom().
 */
export function createQuestionComponent(
  question: NormalizedQuestion,
  theme: any,
  done: DoneCallback,
): {
  render: (width: number) => string[];
  handleInput: (data: string) => void;
  invalidate: () => void;
} {
  // Shared multi-select state persists across all views
  let multiSelected = new Set<number>();
  let view: "options" | "editor" | "submit" = "options";
  let optionIndex = 0;
  let editorText = "";
  let cachedLines: string[] | undefined;

  function refresh() {
    cachedLines = undefined;
  }

  function currentOptions(): (NormalizedOption & { isOther?: boolean })[] {
    const opts: (NormalizedOption & { isOther?: boolean })[] = [
      ...question.options,
    ];
    if (question.allowOther) {
      opts.push({ label: "Type something…", value: "__other__", isOther: true });
    }
    return opts;
  }

  function handleInput(data: string) {
    // ── Editor mode ──────────────────────────────────────────────
    if (view === "editor") {
      if (data === "\x1b") {
        // Escape: return to options
        view = "options";
        optionIndex = currentOptions().length; // highlight Skip
        refresh();
        return;
      }
      if (data === "\x7f" || data === "\b") {
        if (editorText.length > 0) {
          editorText = editorText.slice(0, -1);
        }
      } else if (data === "\r" || data === "\n") {
        const trimmed = editorText.trim();
        if (trimmed) {
          done({ status: "answered", customText: trimmed });
        }
        return;
      } else if (data.length === 1 && data >= " ") {
        editorText += data;
      }
      refresh();
      return;
    }

    // ── Submit view (multi-select confirmation) ──────────────────
    if (view === "submit") {
      if (data === "\x1b") {
        view = "options";
        optionIndex = 0;
        refresh();
        return;
      }
      if (data === "\r" || data === "\n") {
        const opts = currentOptions();
        const selectedValues = Array.from(multiSelected)
          .filter((i: number) => i < opts.length && !opts[i].isOther)
          .map((i: number) => opts[i].value);
        if (selectedValues.length > 0) {
          done({ status: "answered", selectedValues });
        }
        return;
      }
      return;
    }

    // ── Options view ─────────────────────────────────────────────
    const opts = currentOptions();
    const skipIndex = opts.length;

    if (data === "\x1b") {
      done({ status: "cancelled" });
      return;
    }
    if (data === "\x1b[A") {
      if (optionIndex > 0) optionIndex--;
      refresh();
      return;
    }
    if (data === "\x1b[B") {
      if (optionIndex < skipIndex) optionIndex++;
      refresh();
      return;
    }

    if (data === "\r" || data === "\n") {
      if (optionIndex === skipIndex) {
        done({ status: "skipped" });
        return;
      }
      const selected = opts[optionIndex];
      if (question.mode === "multi-select") {
        if (selected.isOther) {
          view = "editor";
          editorText = "";
          refresh();
          return;
        }
        const next = new Set(multiSelected);
        if (next.has(optionIndex)) next.delete(optionIndex);
        else next.add(optionIndex);
        multiSelected = next;
        refresh();
        return;
      }
      // Single-select
      if (selected.isOther) {
        view = "editor";
        editorText = "";
        refresh();
        return;
      }
      done({ status: "answered", selectedOption: selected });
      return;
    }

    if (data === " ") {
      if (question.mode === "multi-select" && optionIndex < opts.length) {
        const selected = opts[optionIndex];
        if (selected.isOther) {
          view = "editor";
          editorText = "";
          refresh();
          return;
        }
        const next = new Set(multiSelected);
        if (next.has(optionIndex)) next.delete(optionIndex);
        else next.add(optionIndex);
        multiSelected = next;
        refresh();
        return;
      }
    }
  }

  function render(width: number): string[] {
    if (cachedLines) return cachedLines;

    const lines: string[] = [];
    const w = Math.max(1, width);

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

    addLine(theme.fg("accent", "─".repeat(w)));
    addWrapped(" " + theme.fg("text", question.text));
    addLine("");

    const opts = currentOptions();
    const skipIndex = opts.length;

    // ── Render by view ───────────────────────────────────────────

    if (view === "editor") {
      for (let i = 0; i < opts.length; i++) {
        const opt = opts[i];
        const checkbox =
          question.mode === "multi-select" && multiSelected.has(i)
            ? "☑ "
            : "  ";
        addWrapped("  " + theme.fg("muted", `${i + 1}. ${checkbox}${opt.label}`));
      }
      addLine("");
      addWrapped(" " + theme.fg("muted", "Your answer:"));
      addWrapped(" " + theme.fg("accent", "> " + editorText + "█"));
      addLine("");
      addWrapped(" " + theme.fg("dim", "Enter to submit · Esc to go back"));
    } else if (view === "submit") {
      for (let i = 0; i < opts.length; i++) {
        const opt = opts[i];
        if (opt.isOther) continue;
        const isChecked = multiSelected.has(i);
        const checkbox = isChecked ? "☑ " : "☐ ";
        const color = isChecked ? "text" : "muted";
        addWrapped(" " + theme.fg(color, `${checkbox}${opt.label}`));
      }
      addLine("");
      const count = multiSelected.size;
      if (count > 0) {
        addWrapped(" " + theme.fg("success", `Press Enter to submit ${count} selection(s)`));
      } else {
        addWrapped(" " + theme.fg("warning", "No selections made"));
      }
    } else {
      // Options view
      for (let i = 0; i < opts.length; i++) {
        const opt = opts[i];
        const selected = i === optionIndex;
        const isOther = opt.isOther === true;
        const prefix = selected ? theme.fg("accent", "> ") : "  ";
        let checkbox = "";
        if (question.mode === "multi-select" && !isOther) {
          checkbox = multiSelected.has(i) ? "☑ " : "☐ ";
        }
        const label = `${i + 1}. ${checkbox}${opt.label}`;
        const color = selected ? "accent" : "text";
        addWrapped(prefix + theme.fg(color, label));
      }
      // Skip control
      const skipSelected = optionIndex === skipIndex;
      const skipPrefix = skipSelected ? theme.fg("accent", "> ") : "  ";
      addWrapped(skipPrefix + theme.fg(skipSelected ? "warning" : "dim", "Skip"));
    }

    addLine("");
    if (view === "editor") {
      // help shown inline
    } else if (question.mode === "multi-select") {
      addWrapped(" " + theme.fg("dim", "↑↓ navigate · Space toggle · Enter confirm · Esc cancel"));
    } else {
      addWrapped(" " + theme.fg("dim", "↑↓ navigate · Enter select · Esc cancel"));
    }
    addLine(theme.fg("accent", "─".repeat(w)));

    cachedLines = lines;
    return lines;
  }

  return {
    render,
    handleInput,
    invalidate: () => {
      cachedLines = undefined;
    },
  };
}
