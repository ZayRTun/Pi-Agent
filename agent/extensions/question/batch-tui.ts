/**
 * TUI component for the Batch Question interaction.
 *
 * Renders a tabbed/stepper navigator for 2–12 independent Questions.
 * Users navigate with arrow keys, answer questions by pressing number keys,
 * revisit them, and submit only after all are answered or skipped.
 *
 * Tab layout for ≤ 6 questions; stepper layout for > 6.
 * Cancel discards all draft answers.
 */

import type { NormalizedOption, NormalizedQuestion } from "./types.js";

/** Draft answer stored while navigating between questions. */
interface DraftAnswer {
  status: "answered" | "skipped";
  selectedValues?: string[];
  selectedOption?: NormalizedOption;
  customText?: string;
}

/** Result of the batch interaction. */
export interface BatchTuiResult {
  status: "answered" | "cancelled";
  /** Answers keyed by question ID. Present when answered. */
  draftAnswers: Map<string, DraftAnswer>;
}

/** Callback to signal the result. */
export type BatchDoneCallback = (result: BatchTuiResult) => void;

/**
 * Create a batch TUI component for use with ctx.ui.custom().
 */
export function createBatchComponent(
  questions: NormalizedQuestion[],
  theme: any,
  done: BatchDoneCallback,
): {
  render: (width: number) => string[];
  handleInput: (data: string) => void;
  invalidate: () => void;
} {
  const drafts = new Map<string, DraftAnswer>();
  let activeIndex = 0;
  let view: "navigator" | "editor" | "submit-confirm" = "navigator";
  let editorText = "";
  let multiSelected = new Set<number>();
  let cachedLines: string[] | undefined;

  function refresh() {
    cachedLines = undefined;
  }

  function activeQuestion(): NormalizedQuestion {
    return questions[activeIndex];
  }

  function currentOptions(): (NormalizedOption & { isOther?: boolean })[] {
    const q = activeQuestion();
    const opts: (NormalizedOption & { isOther?: boolean })[] = [...q.options];
    if (q.allowOther) {
      opts.push({ label: "Type something\u2026", value: "__other__", isOther: true });
    }
    return opts;
  }

  function allAnsweredOrSkipped(): boolean {
    return questions.every((q) => {
      const d = drafts.get(q.id);
      return d && (d.status === "answered" || d.status === "skipped");
    });
  }

  function answeredCount(): number {
    return questions.filter((q) => {
      const d = drafts.get(q.id);
      return d && (d.status === "answered" || d.status === "skipped");
    }).length;
  }

  function questionStatusIcon(q: NormalizedQuestion): string {
    const d = drafts.get(q.id);
    if (!d) return "\u25cb"; // ○ unanswered
    if (d.status === "skipped") return "\u25cb"; // ○ skipped
    return "\u25cf"; // ● answered
  }

  function questionStatusColor(q: NormalizedQuestion): string {
    const d = drafts.get(q.id);
    if (!d) return "dim";
    if (d.status === "skipped") return "warning";
    return "success";
  }

  function loadMultiState() {
    const q = activeQuestion();
    const draft = drafts.get(q.id);
    if (q.mode === "multi-select" && draft?.selectedValues) {
      const opts = currentOptions();
      multiSelected = new Set<number>();
      for (let i = 0; i < opts.length; i++) {
        if (draft.selectedValues.includes(opts[i].value)) {
          multiSelected.add(i);
        }
      }
    } else {
      multiSelected = new Set<number>();
    }
  }

  function handleInput(data: string) {
    // ── Editor mode (custom "Other" input) ────────────────────────
    if (view === "editor") {
      if (data === "\x1b") {
        view = "navigator";
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
          drafts.set(activeQuestion().id, { status: "answered", customText: trimmed });
          advanceToNext();
        }
        return;
      } else if (data.length === 1 && data >= " ") {
        editorText += data;
      }
      refresh();
      return;
    }

    // ── Submit confirmation view ──────────────────────────────────
    if (view === "submit-confirm") {
      if (data === "\x1b") {
        view = "navigator";
        refresh();
        return;
      }
      if (data === "\r" || data === "\n") {
        done({ status: "answered", draftAnswers: drafts });
        return;
      }
      return;
    }

    // ── Navigator view ────────────────────────────────────────────

    // Global Escape: cancel the entire batch
    if (data === "\x1b") {
      done({ status: "cancelled", draftAnswers: new Map() });
      return;
    }

    // Left/Right arrows: navigate between questions
    if (data === "\x1b[D") {
      if (activeIndex > 0) {
        activeIndex--;
        loadMultiState();
      }
      refresh();
      return;
    }
    if (data === "\x1b[C") {
      if (activeIndex < questions.length - 1) {
        activeIndex++;
        loadMultiState();
      }
      refresh();
      return;
    }

    // Up/Down arrows: navigate within multi-select options
    if (data === "\x1b[A" || data === "\x1b[B") {
      const q = activeQuestion();
      if (q.mode === "multi-select") {
        const opts = currentOptions();
        const maxIdx = opts.length - 1;
        // Use a simple selection index for multi-select navigation
        // Not tracked separately; we use number keys instead
      }
      refresh();
      return;
    }

    // Space: toggle multi-select on active question
    if (data === " ") {
      const q = activeQuestion();
      if (q.mode === "multi-select") {
        const opts = currentOptions();
        // Submit multi-select if selections exist
        if (multiSelected.size > 0) {
          const selectedValues = Array.from(multiSelected)
            .filter((i: number) => i < opts.length && !opts[i].isOther)
            .map((i: number) => opts[i].value);
          drafts.set(q.id, { status: "answered", selectedValues });
          advanceToNext();
        }
      }
      refresh();
      return;
    }

    // Tab: jump to next question
    if (data === "\t") {
      if (activeIndex < questions.length - 1) {
        activeIndex++;
      } else {
        activeIndex = 0;
      }
      loadMultiState();
      refresh();
      return;
    }

    // Shift+Tab: jump to previous question
    if (data === "\x1b[Z") {
      if (activeIndex > 0) {
        activeIndex--;
      } else {
        activeIndex = questions.length - 1;
      }
      loadMultiState();
      refresh();
      return;
    }

    // Number keys: select option by number (1-9, 0 for 10th)
    if (data >= "1" && data <= "9") {
      const num = parseInt(data, 10);
      selectOptionByIndex(num - 1);
      return;
    }
    if (data === "0") {
      selectOptionByIndex(9);
      return;
    }

    // s/S: skip the active question
    if (data === "s" || data === "S") {
      drafts.set(activeQuestion().id, { status: "skipped" });
      advanceToNext();
      return;
    }

    // Enter: submit if all answered, otherwise no-op in navigator
    if (data === "\r" || data === "\n") {
      if (allAnsweredOrSkipped()) {
        done({ status: "answered", draftAnswers: drafts });
      }
      return;
    }
  }

  function selectOptionByIndex(idx: number) {
    const q = activeQuestion();
    const opts = currentOptions();

    if (idx < 0 || idx >= opts.length) return;
    const opt = opts[idx];

    if (opt.isOther) {
      // Open editor for custom text
      view = "editor";
      editorText = "";
      refresh();
      return;
    }

    if (q.mode === "multi-select") {
      // Toggle this option
      const next = new Set(multiSelected);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      multiSelected = next;

      // Store in drafts
      const selectedValues = Array.from(next)
        .filter((i: number) => i < opts.length && !opts[i].isOther)
        .map((i: number) => opts[i].value);
      drafts.set(q.id, { status: "answered", selectedValues });
      refresh();
      return;
    }

    // Single-select: answer immediately
    drafts.set(q.id, { status: "answered", selectedOption: opt });
    advanceToNext();
  }

  function advanceToNext() {
    // Find next unanswered question
    for (let i = activeIndex + 1; i < questions.length; i++) {
      if (!drafts.has(questions[i].id)) {
        activeIndex = i;
        loadMultiState();
        refresh();
        return;
      }
    }
    // Wrap around from start
    for (let i = 0; i < activeIndex; i++) {
      if (!drafts.has(questions[i].id)) {
        activeIndex = i;
        loadMultiState();
        refresh();
        return;
      }
    }
    // All answered — if all done, switch to submit view
    if (allAnsweredOrSkipped()) {
      view = "submit-confirm";
    }
    loadMultiState();
    refresh();
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

    // ── Navigation bar ────────────────────────────────────────────
    const useTabs = questions.length <= 6;
    addLine(theme.fg("accent", "\u2500".repeat(w)));

    if (useTabs) {
      // Tab layout: one tab per question
      const tabs: string[] = [];
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        const icon = questionStatusIcon(q);
        const color = questionStatusColor(q);
        const isActive = i === activeIndex;
        const label = q.label;
        const tabText = `${icon} ${label}`;
        if (isActive) {
          tabs.push(theme.fg("accent", theme.bold(tabText)));
        } else {
          tabs.push(theme.fg(color, tabText));
        }
      }
      addLine(" " + tabs.join(theme.fg("dim", " \u2502 ")));
    } else {
      // Stepper layout: compact list
      const parts: string[] = [];
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        const icon = questionStatusIcon(q);
        const color = questionStatusColor(q);
        const isActive = i === activeIndex;
        const label = q.label;
        if (isActive) {
          parts.push(theme.fg("accent", theme.bold(`[${icon} ${label}]`)));
        } else {
          parts.push(theme.fg(color, `${icon} ${label}`));
        }
      }
      const joined = parts.join(theme.fg("dim", "  "));
      if (joined.length <= w) {
        addLine(" " + joined);
      } else {
        let row = "";
        for (const part of parts) {
          const test = row ? row + theme.fg("dim", "  ") + part : part;
          if (test.length > w && row) {
            addLine(" " + row);
            row = part;
          } else {
            row = test;
          }
        }
        if (row) addLine(" " + row);
      }
    }

    // Progress indicator
    const progress = `${answeredCount()}/${questions.length}`;
    addLine(theme.fg("dim", ` Progress: ${progress}`));
    addLine("");

    // ── Active question content ───────────────────────────────────

    if (view === "editor") {
      const q = activeQuestion();
      const opts = currentOptions();
      for (let i = 0; i < opts.length; i++) {
        const opt = opts[i];
        const checkbox =
          q.mode === "multi-select" && multiSelected.has(i) ? "\u2611 " : "  ";
        addWrapped("  " + theme.fg("muted", `${i + 1}. ${checkbox}${opt.label}`));
      }
      addLine("");
      addWrapped(" " + theme.fg("muted", "Your answer:"));
      addWrapped(" " + theme.fg("accent", "> " + editorText + "\u2588"));
      addLine("");
      addWrapped(" " + theme.fg("dim", "Enter to submit \u00b7 Esc to go back"));
    } else if (view === "submit-confirm") {
      addWrapped(" " + theme.fg("success", theme.bold("All questions answered!")));
      addLine("");
      addWrapped(" " + theme.fg("accent", "Press Enter to submit \u00b7 Esc to go back and edit"));
    } else {
      // Navigator: show active question
      const q = activeQuestion();
      const opts = currentOptions();

      // Question text
      addWrapped(" " + theme.fg("text", theme.bold(`Q${activeIndex + 1}: `)) + theme.fg("text", q.text));
      addLine("");

      // Options
      for (let i = 0; i < opts.length; i++) {
        const opt = opts[i];
        const isOther = opt.isOther === true;
        const number = isOther ? " " : `${i + 1}`;
        let checkbox = "";
        if (q.mode === "multi-select" && !isOther) {
          checkbox = multiSelected.has(i) ? "\u2611 " : "\u2610 ";
        }
        const label = `${number}. ${checkbox}${opt.label}`;
        addWrapped("  " + theme.fg("text", label));
      }

      // Skip control
      addWrapped("  " + theme.fg("dim", "s. Skip this question"));

      // Show current draft if exists
      const draft = drafts.get(q.id);
      if (draft) {
        addLine("");
        if (draft.status === "skipped") {
          addWrapped("  " + theme.fg("warning", "\u2794 Skipped"));
        } else if (draft.customText) {
          addWrapped("  " + theme.fg("success", `\u2714 ${draft.customText}`));
        } else if (draft.selectedOption) {
          addWrapped(
            "  " + theme.fg("success", `\u2714 ${draft.selectedOption.label}`),
          );
        } else if (draft.selectedValues) {
          const labels = draft.selectedValues.map((v) => {
            const opt = q.options.find((o) => o.value === v);
            return opt?.label ?? v;
          });
          addWrapped(
            "  " + theme.fg("success", `\u2714 ${labels.join(", ")}`),
          );
        }
      }
    }

    // ── Help bar ──────────────────────────────────────────────────
    addLine("");
    if (view === "editor") {
      // help shown inline above
    } else if (view === "submit-confirm") {
      // help shown inline above
    } else {
      const help = allAnsweredOrSkipped()
        ? theme.fg("success", "Enter to submit \u00b7 Esc cancel")
        : theme.fg("dim", "1-9 select \u00b7 s skip \u00b7 Tab/Arrow nav \u00b7 Esc cancel");
      addWrapped(" " + help);
    }

    addLine(theme.fg("accent", "\u2500".repeat(w)));

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
