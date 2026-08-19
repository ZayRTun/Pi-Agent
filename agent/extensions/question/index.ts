/**
 * Question Interaction Extension
 *
 * A stateless Pi extension that registers the `ask_user_question` tool,
 * allowing an agent to collect one free-text, single-select, multi-select,
 * or custom "Other" Answer through a reusable interaction mechanism.
 *
 * The extension does not own workflow state. Calling skills remain
 * responsible for question rounds, decisions, and session state.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
  buildAnsweredResult,
  buildBatchResult,
  buildResult,
  buildSkippedResult,
  normalizeBatch,
  normalizeQuestion,
  validateBatchToolInput,
  validateToolInput,
} from "./interaction.js";
import type {
  BatchAnswer,
  BatchInput,
  BatchInteractionStatus,
  BatchQuestionInput,
  BatchResult,
  InteractionStatus,
  NormalizedOption,
  NormalizedQuestion,
  QuestionAnswerStatus,
  QuestionInput,
  QuestionOption,
  QuestionResult,
} from "./types.js";
import { BATCH_MIN, BATCH_MAX } from "./types.js";
import { createBatchComponent } from "./batch-tui.js";
import { createQuestionComponent } from "./question-tui.js";
import { runRpcBatch, runRpcQuestion } from "./rpc-adapter.js";

// ---------------------------------------------------------------------------
// Serialization lock — prevent concurrent Question interactions
// ---------------------------------------------------------------------------

let interactionLock = false;

// ---------------------------------------------------------------------------
// Option schema
// ---------------------------------------------------------------------------

const OptionSchema = Type.Object({
  label: Type.String({ description: "Display label for the option" }),
  value: Type.Optional(
    Type.String({
      description:
        "Machine value returned when selected. Derived from label if omitted.",
    }),
  ),
});

// ---------------------------------------------------------------------------
// Tool schema
// ---------------------------------------------------------------------------

const QuestionToolParams = Type.Object({
  id: Type.String({
    description: "Unique identifier for this question",
  }),
  text: Type.String({
    description: "The question text to display to the user",
  }),
  label: Type.Optional(
    Type.String({
      description:
        "Short navigation label (e.g. 'Scope', 'Priority'). Defaults to truncated text.",
    }),
  ),
  mode: Type.Optional(
    Type.Union(
      [
        Type.Literal("text"),
        Type.Literal("single-select"),
        Type.Literal("multi-select"),
      ],
      {
        description:
          "Input mode. Inferred from options when omitted: no options → text, options → single-select, options + multiSelect → multi-select.",
      },
    ),
  ),
  options: Type.Optional(
    Type.Array(OptionSchema, {
      description:
        "Available options. Triggers mode inference when present.",
    }),
  ),
  allowOther: Type.Optional(
    Type.Boolean({
      description:
        "Allow custom 'Other' text input. Default: false for text mode, true for select modes.",
    }),
  ),
});

// ---------------------------------------------------------------------------
// Batch tool schema
// ---------------------------------------------------------------------------

const BatchQuestionSchema = Type.Object({
  id: Type.String({ description: "Unique identifier for this question" }),
  text: Type.String({ description: "The question text to display to the user" }),
  label: Type.Optional(
    Type.String({
      description:
        "Short navigation label (e.g. 'Scope', 'Priority'). Defaults to truncated text.",
    }),
  ),
  mode: Type.Optional(
    Type.Union(
      [
        Type.Literal("text"),
        Type.Literal("single-select"),
        Type.Literal("multi-select"),
      ],
      {
        description:
          "Input mode. Inferred from options when omitted.",
      },
    ),
  ),
  options: Type.Optional(
    Type.Array(OptionSchema, {
      description: "Available options.",
    }),
  ),
  allowOther: Type.Optional(
    Type.Boolean({
      description:
        "Allow custom 'Other' text input. Default: false for text mode, true for select modes.",
    }),
  ),
});

const BatchToolParams = Type.Object({
  questions: Type.Array(BatchQuestionSchema, {
    description:
      "Two to twelve independent Questions with unique IDs and optional navigation labels.",
    minItems: 2,
    maxItems: 12,
  }),
});

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

// Re-export shared types for tests and future integrations
export type {
  BatchAnswer,
  BatchInput,
  BatchInteractionStatus,
  BatchQuestionInput,
  BatchResult,
  InteractionStatus,
  NormalizedOption,
  NormalizedQuestion,
  QuestionAnswerStatus,
  QuestionInput,
  QuestionOption,
  QuestionResult,
};
export { BATCH_MIN, BATCH_MAX };

export default function questionExtension(pi: ExtensionAPI) {
  // -----------------------------------------------------------------------
  // Single Question tool
  // -----------------------------------------------------------------------
  pi.registerTool({
    name: "ask_user_question",
    label: "Question",
    description:
      "Ask the user one question and collect their answer. Supports free-text, single-select, multi-select, and custom 'Other' input. Returns structured answered, cancelled, or unavailable outcomes. Do not modify packaged skills to use this tool.",
    promptSnippet:
      "Ask the user a structured question to collect free-text, single-select, multi-select, or custom Other input",
    promptGuidelines: [
      "Use ask_user_question when you need structured user input that cannot be answered by editing files or running commands.",
      "Use ask_user_question with options for single-select or multi-select choices. Omit options for free-text questions.",
      "Use ask_user_question with mode 'multi-select' when the user should choose several options from a list.",
      "Do not use ask_user_question for questions that are part of a skill's internal workflow (e.g. design review or brainstorming questions). Use it only for clear, standalone clarifications.",
    ],
    parameters: QuestionToolParams,
    executionMode: "sequential",

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // ------------------------------------------------------------------
      // Mode-specific handling
      // ------------------------------------------------------------------

      // JSON and print modes: return unavailable immediately
      if (ctx.mode === "json" || ctx.mode === "print") {
        return {
          content: [
            {
              type: "text" as const,
              text: "Question interaction unavailable in this mode",
            },
          ],
          details: buildResult("unavailable", []) as QuestionResult,
        };
      }

      // ------------------------------------------------------------------
      // Input validation
      // ------------------------------------------------------------------

      const validationError = validateToolInput(params);
      if (validationError) {
        throw new Error(validationError);
      }

      // ------------------------------------------------------------------
      // Normalize the question
      // ------------------------------------------------------------------

      const input: QuestionInput = {
        id: params.id,
        text: params.text,
        label: params.label,
        mode: params.mode as QuestionInput["mode"],
        options: params.options,
        allowOther: params.allowOther,
      };

      const question = normalizeQuestion(input);

      // ------------------------------------------------------------------
      // Serialize: acquire lock
      // ------------------------------------------------------------------

      if (interactionLock) {
        throw new Error(
          "Another Question interaction is already in progress. Wait for it to complete.",
        );
      }

      interactionLock = true;

      try {
        // ----------------------------------------------------------------
        // RPC mode: use native dialogs
        // ----------------------------------------------------------------

        if (ctx.mode === "rpc") {
          return await runRpcQuestion(question, ctx as any);
        }

        // ----------------------------------------------------------------
        // TUI mode: custom interactive UI
        // ----------------------------------------------------------------

        const result = await ctx.ui.custom<
          | {
              status: "answered" | "cancelled" | "skipped";
              selectedValues?: string[];
              selectedOption?: { label: string; value: string };
              customText?: string;
            }
          | null
        >((tui, theme, _kb, done) => {
          return createQuestionComponent(question, theme, done);
        });

        if (!result) {
          return {
            content: [
              { type: "text" as const, text: "User cancelled the question" },
            ],
            details: buildResult("cancelled", [], question) as QuestionResult,
          };
        }

        if (result.status === "cancelled") {
          return {
            content: [
              { type: "text" as const, text: "User cancelled the question" },
            ],
            details: buildResult("cancelled", [], question) as QuestionResult,
          };
        }

        if (result.status === "skipped") {
          const answer = buildSkippedResult(question);
          return {
            content: [
              {
                type: "text" as const,
                text: `User skipped: ${question.text}`,
              },
            ],
            details: buildResult("answered", [answer], question) as QuestionResult,
          };
        }

        // Answered
        const answer = buildAnsweredResult(
          question,
          result.selectedOption,
          result.customText,
          result.selectedValues,
        );

        const displayText = result.customText
          ? `User wrote: ${result.customText}`
          : result.selectedOption
            ? `User selected: ${result.selectedOption.label}`
            : result.selectedValues
              ? `User selected: ${result.selectedValues.join(", ")}`
              : "User answered";

        return {
          content: [{ type: "text" as const, text: displayText }],
          details: buildResult("answered", [answer], question) as QuestionResult,
        };
      } finally {
        interactionLock = false;
      }
    },

    // ------------------------------------------------------------------
    // Custom TUI rendering
    // ------------------------------------------------------------------

    renderCall(args, theme, _context) {
      const text = args.text as string;
      const mode = args.mode as string | undefined;
      const options = (args.options as Array<{ label: string }>) || [];

      let display = theme.fg("toolTitle", theme.bold("question "));
      display += theme.fg("muted", text);

      if (options.length > 0) {
        const modeLabel =
          mode === "multi-select" ? "multi-select" : "single-select";
        display += theme.fg("dim", ` [${modeLabel}, ${options.length} options]`);
      } else {
        display += theme.fg("dim", " [free-text]");
      }

      return new Text(display, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const details = result.details as QuestionResult | undefined;
      if (!details) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "", 0, 0);
      }

      if (details.status === "cancelled") {
        return new Text(theme.fg("warning", "Cancelled"), 0, 0);
      }

      if (details.status === "unavailable") {
        return new Text(theme.fg("dim", "Unavailable"), 0, 0);
      }

      const answer = details.answers[0];
      if (!answer) {
        return new Text(theme.fg("dim", "No answer"), 0, 0);
      }

      if (answer.status === "skipped") {
        return new Text(theme.fg("warning", "Skipped"), 0, 0);
      }

      const prefix = answer.wasCustom ? "(wrote) " : "";
      const display = answer.label || answer.value || "answered";
      return new Text(
        theme.fg("success", "✓ ") + theme.fg("muted", prefix) + theme.fg("accent", display),
        0,
        0,
      );
    },
  });

  // -----------------------------------------------------------------------
  // Batch Question tool
  // -----------------------------------------------------------------------
  pi.registerTool({
    name: "ask_user_questions",
    label: "Questions",
    description:
      "Ask the user multiple independent questions and collect their answers in a single interaction. Supports mixed free-text, single-select, multi-select, and custom 'Other' questions. Returns structured answered, cancelled, or unavailable outcomes. Do not modify packaged skills to use this tool.",
    promptSnippet:
      "Ask the user multiple independent questions and collect their answers",
    promptGuidelines: [
      "Use ask_user_questions when you need to collect multiple independent pieces of structured user input in one interaction.",
      "Each question in the batch supports free-text, single-select, multi-select, or custom 'Other' input.",
      "The batch must contain 2–12 questions with unique IDs and optional navigation labels.",
      "Do not use ask_user_questions for questions that are part of a skill's internal workflow.",
    ],
    parameters: BatchToolParams,
    executionMode: "sequential",

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // ------------------------------------------------------------------
      // Mode-specific handling
      // ------------------------------------------------------------------

      // JSON and print modes: return unavailable immediately
      if (ctx.mode === "json" || ctx.mode === "print") {
        return {
          content: [
            {
              type: "text" as const,
              text: "Question interaction unavailable in this mode",
            },
          ],
          details: buildBatchResult("unavailable", [], []) as BatchResult,
        };
      }

      // ------------------------------------------------------------------
      // Input validation
      // ------------------------------------------------------------------

      const validationError = validateBatchToolInput(params);
      if (validationError) {
        throw new Error(validationError);
      }

      // ------------------------------------------------------------------
      // Normalize all questions
      // ------------------------------------------------------------------

      const questionsInput: QuestionInput[] = (params as any).questions;
      const normalizedQuestions = normalizeBatch({ questions: questionsInput });

      // ------------------------------------------------------------------
      // Serialize: acquire lock
      // ------------------------------------------------------------------

      if (interactionLock) {
        throw new Error(
          "Another Question interaction is already in progress. Wait for it to complete.",
        );
      }

      interactionLock = true;

      try {
        // ----------------------------------------------------------------
        // RPC mode: use native dialogs sequentially
        // ----------------------------------------------------------------

        if (ctx.mode === "rpc") {
          return await runRpcBatch(normalizedQuestions, ctx as any);
        }

        // ----------------------------------------------------------------
        // TUI mode: custom interactive UI
        // ----------------------------------------------------------------

        const result = await ctx.ui.custom<
          | {
              status: "answered" | "cancelled";
              draftAnswers: Map<
                string,
                {
                  status: "answered" | "skipped";
                  selectedValues?: string[];
                  selectedOption?: { label: string; value: string };
                  customText?: string;
                }
              >;
            }
          | null
        >((tui, theme, _kb, done) => {
          return createBatchComponent(normalizedQuestions, theme, done);
        });

        if (!result || result.status === "cancelled") {
          return {
            content: [
              { type: "text" as const, text: "User cancelled the batch" },
            ],
            details: buildBatchResult("cancelled", [], normalizedQuestions) as BatchResult,
          };
        }

        // Build answers from draft answers, preserving question order
        const answers = normalizedQuestions.map((q) => {
          const draft = result.draftAnswers.get(q.id);
          if (!draft || draft.status === "skipped") {
            return {
              questionId: q.id,
              status: "skipped" as const,
            };
          }
          return buildAnsweredResult(
            q,
            draft.selectedOption as any,
            draft.customText,
            draft.selectedValues,
          );
        });

        const answeredCount = answers.filter((a) => a.status === "answered").length;
        const skippedCount = answers.filter((a) => a.status === "skipped").length;

        return {
          content: [
            {
              type: "text" as const,
              text: `Answered ${answeredCount}, skipped ${skippedCount} of ${normalizedQuestions.length} questions`,
            },
          ],
          details: buildBatchResult(
            "answered",
            answers,
            normalizedQuestions,
          ) as BatchResult,
        };
      } finally {
        interactionLock = false;
      }
    },

    // ------------------------------------------------------------------
    // Custom TUI rendering
    // ------------------------------------------------------------------

    renderCall(args, theme, _context) {
      const questions = (args.questions as Array<{ text: string; label?: string }>);
      const count = questions.length;
      const labels = questions
        .map((q) => q.label ?? q.text?.slice(0, 15))
        .filter(Boolean);

      let display = theme.fg("toolTitle", theme.bold("questions "));
      display += theme.fg("muted", `${count} questions`);

      if (labels.length <= 4) {
        display += theme.fg("dim", ` [${labels.join(", ")}]`);
      }

      return new Text(display, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const details = result.details as BatchResult | undefined;
      if (!details) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "", 0, 0);
      }

      if (details.status === "cancelled") {
        return new Text(theme.fg("warning", "Cancelled"), 0, 0);
      }

      if (details.status === "unavailable") {
        return new Text(theme.fg("dim", "Unavailable"), 0, 0);
      }

      const answered = details.answers.filter((a) => a.status === "answered").length;
      const skipped = details.answers.filter((a) => a.status === "skipped").length;
      const total = details.questions.length;

      const parts: string[] = [];
      if (answered > 0) parts.push(theme.fg("success", `${answered} answered`));
      if (skipped > 0) parts.push(theme.fg("warning", `${skipped} skipped`));

      const display = parts.length > 0 ? parts.join(theme.fg("dim", " ")) : theme.fg("dim", "No answers");
      return new Text(
        theme.fg("success", "\u2713 ") + theme.fg("muted", `${total} questions: `) + display,
        0,
        0,
      );
    },
  });
}
