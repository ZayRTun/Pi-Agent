/**
 * Question Interaction Extension
 *
 * A stateless Pi extension that registers the `ask_user_question` tool,
 * allowing an agent to collect one free-text, single-select, multi-select,
 * or custom "Other" Answer through a reusable interaction mechanism.
 *
 * The extension does not own workflow state. Calling skills (grilling,
 * wayfinder, etc.) remain responsible for question rounds, decisions,
 * and session state.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
  buildAnsweredResult,
  buildResult,
  buildSkippedResult,
  normalizeQuestion,
  validateToolInput,
} from "./interaction.js";
import type { NormalizedQuestion, QuestionInput, QuestionResult } from "./types.js";
import { createQuestionComponent } from "./question-tui.js";
import { runRpcQuestion } from "./rpc-adapter.js";

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
// Extension entry point
// ---------------------------------------------------------------------------

export default function questionExtension(pi: ExtensionAPI) {
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
      "Do not use ask_user_question for questions that are part of a skill's internal workflow (e.g. grilling design questions). Use it only for clear, standalone clarifications.",
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
}
