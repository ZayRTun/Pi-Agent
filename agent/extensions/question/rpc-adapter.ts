/**
 * RPC adapter for the Question interaction.
 *
 * Uses native dialog methods (ctx.ui.select, ctx.ui.input, ctx.ui.confirm)
 * to collect answers sequentially. Preserves the same structured result
 * contract as the TUI mode.
 */

import type {
  BatchAnswer,
  BatchResult,
  NormalizedQuestion,
  QuestionResult,
} from "./types.js";
import {
  buildAnsweredResult,
  buildResult,
  buildSkippedResult,
  normalizeValue,
} from "./interaction.js";

interface RpcContext {
  ui: {
    select: (title: string, options: string[]) => Promise<string | undefined>;
    input: (
      title: string,
      placeholder?: string,
    ) => Promise<string | undefined>;
    confirm: (title: string, message: string) => Promise<boolean>;
  };
  mode: string;
}

/**
 * Run a single-Question interaction in RPC mode using native dialogs.
 */
export async function runRpcQuestion(
  question: NormalizedQuestion,
  ctx: RpcContext,
): Promise<QuestionResult> {
  if (question.mode === "text") {
    // Free text: present a choice between typing and skipping,
    // mirroring the TUI Skip control.
    const choice = await ctx.ui.select(question.text, [
      "Type your answer…",
      "Skip",
    ]);

    if (choice === undefined) {
      return buildResult("cancelled", [], question);
    }

    if (choice === "Skip") {
      return buildResult(
        "answered",
        [buildSkippedResult(question)],
        question,
      );
    }

    // User chose to type
    const answer = await ctx.ui.input(question.text, "Type your answer…");
    if (answer === undefined) {
      return buildResult("cancelled", [], question);
    }
    const trimmed = answer.trim();
    if (!trimmed) {
      return buildResult("cancelled", [], question);
    }
    return buildResult(
      "answered",
      [buildAnsweredResult(question, undefined, trimmed)],
      question,
    );
  }

  if (question.mode === "single-select") {
    // Build options with optional "Other"
    const optionLabels = question.options.map((o) => o.label);
    if (question.allowOther) {
      optionLabels.push("Type something…");
    }
    optionLabels.push("Skip");

    const choice = await ctx.ui.select(question.text, optionLabels);

    if (choice === undefined) {
      return buildResult("cancelled", [], question);
    }

    if (choice === "Skip") {
      return buildResult(
        "answered",
        [buildSkippedResult(question)],
        question,
      );
    }

    if (choice === "Type something…") {
      const customAnswer = await ctx.ui.input(question.text, "Your answer…");
      if (customAnswer === undefined) {
        return buildResult("cancelled", [], question);
      }
      const trimmed = customAnswer.trim();
      if (!trimmed) {
        return buildResult("cancelled", [], question);
      }
      return buildResult(
        "answered",
        [buildAnsweredResult(question, undefined, trimmed)],
        question,
      );
    }

    // Find the matching option
    const selectedOption = question.options.find((o) => o.label === choice);
    if (selectedOption) {
      return buildResult(
        "answered",
        [buildAnsweredResult(question, selectedOption)],
        question,
      );
    }

    return buildResult("cancelled", [], question);
  }

  if (question.mode === "multi-select") {
    // First: offer a Skip control, mirroring the TUI.
    const skipChoice = await ctx.ui.confirm(
      question.text,
      "Skip this question?",
    );
    if (skipChoice) {
      return buildResult(
        "answered",
        [buildSkippedResult(question)],
        question,
      );
    }

    // Sequential selection: ask one at a time
    const selectedValues: string[] = [];

    for (const opt of question.options) {
      const confirmed = await ctx.ui.confirm(
        question.text,
        `Select "${opt.label}"?`,
      );
      if (confirmed) {
        selectedValues.push(opt.value);
      }
    }

    // Check for custom "Other"
    if (question.allowOther) {
      const wantsOther = await ctx.ui.confirm(
        question.text,
        "Would you like to type a custom answer?",
      );
      if (wantsOther) {
        const customAnswer = await ctx.ui.input(
          question.text,
          "Your custom answer…",
        );
        if (customAnswer !== undefined && customAnswer.trim()) {
          selectedValues.push(normalizeValue(customAnswer));
        }
      }
    }

    if (selectedValues.length === 0) {
      return buildResult("cancelled", [], question);
    }

    return buildResult(
      "answered",
      [
        {
          ...buildAnsweredResult(question, undefined, undefined, selectedValues),
        },
      ],
      question,
    );
  }

  return buildResult("cancelled", [], question);
}

/**
 * Run a Batch interaction in RPC mode using native dialogs.
 * Collects questions sequentially, preserving the same domain result contract.
 */
export async function runRpcBatch(
  questions: NormalizedQuestion[],
  ctx: RpcContext,
): Promise<BatchResult> {
  const answers: BatchAnswer[] = [];

  for (const question of questions) {
    // Run single-question interaction for each
    const result = await runRpcQuestion(question, ctx);

    if (result.status === "cancelled") {
      // If user cancels any question, cancel the whole batch
      return {
        status: "cancelled",
        answers: [],
        questions,
      };
    }

    if (result.answers.length > 0) {
      answers.push(result.answers[0]);
    } else {
      // No answer returned — treat as cancelled
      return {
        status: "cancelled",
        answers: [],
        questions,
      };
    }
  }

  return {
    status: "answered",
    answers,
    questions,
  };
}
