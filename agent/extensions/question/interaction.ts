/**
 * Shared interaction boundary for the Question extension.
 *
 * Handles mode inference, normalization, validation, and answer/result
 * construction. Stateless — no session persistence or workflow state.
 *
 * This module is the test seam: callers verify behavior through these
 * public functions rather than testing private component state.
 */

import type {
  Answer,
  InteractionStatus,
  NormalizedOption,
  NormalizedQuestion,
  QuestionAnswerStatus,
  QuestionInput,
  QuestionOption,
  QuestionResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// Value normalization
// ---------------------------------------------------------------------------

/**
 * Derive a machine value from a display label.
 * Boundary-trims, lowercases, replaces whitespace with hyphens,
 * strips non-alphanumeric characters (except hyphens).
 */
export function normalizeValue(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// ---------------------------------------------------------------------------
// Mode inference
// ---------------------------------------------------------------------------

/**
 * Infer the input mode from a QuestionInput.
 *
 * Rules (per spec):
 * - omitted or empty options → "text"
 * - non-empty options, multiSelect not set → "single-select"
 * - non-empty options, multiSelect true → "multi-select"
 * - multiSelect true without options → invalid (returns error)
 */
export function inferMode(
  question: QuestionInput,
): { mode: "text" | "single-select" | "multi-select" } | { error: string } {
  const hasOptions = question.options && question.options.length > 0;
  const multiSelect = question.mode === "multi-select";

  if (multiSelect && !hasOptions) {
    return { error: "multi-select mode requires at least one option" };
  }

  if (hasOptions) {
    return { mode: multiSelect ? "multi-select" : "single-select" };
  }

  return { mode: "text" };
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a single option: preserve display label, derive or trim value.
 */
export function normalizeOption(option: QuestionOption): NormalizedOption {
  const label = option.label.trim();
  const value = option.value !== undefined ? option.value.trim() : normalizeValue(label);
  return { label, value };
}

/**
 * Normalize a QuestionInput into a NormalizedQuestion.
 * Does not validate — call {@link validateQuestion} first.
 */
export function normalizeQuestion(question: QuestionInput): NormalizedQuestion {
  const modeResult = inferMode(question);
  const mode = "mode" in modeResult ? modeResult.mode : "text";

  const options = (question.options ?? []).map(normalizeOption);

  const defaultAllowOther =
    mode === "text" ? false : question.allowOther !== false;

  const text = question.text.trim();
  const label =
    question.label?.trim() ??
    (text.length > 20 ? text.slice(0, 20) + "…" : text);

  return {
    id: question.id,
    text,
    label,
    mode,
    options,
    allowOther: defaultAllowOther,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a single QuestionInput. Returns an error string or null.
 */
export function validateQuestion(question: QuestionInput): string | null {
  // ID validation
  if (!question.id || typeof question.id !== "string" || question.id.trim() === "") {
    return "Question id must be a non-empty string";
  }

  // Text validation
  if (!question.text || typeof question.text !== "string" || question.text.trim() === "") {
    return "Question text must be a non-empty string";
  }

  const hasOptions = question.options && question.options.length > 0;

  // Mode validation
  if (question.mode === "multi-select" && !hasOptions) {
    return "multi-select mode requires at least one option";
  }

  if (!hasOptions && question.mode && question.mode !== "text") {
    return `mode "${question.mode}" requires options`;
  }

  // Option validation
  if (hasOptions) {
    const options = question.options!;
    for (const opt of options) {
      if (!opt.label || typeof opt.label !== "string" || opt.label.trim() === "") {
        return "Option label must be a non-empty string";
      }
    }

    // Duplicate label check
    const labels = options.map((o) => o.label.trim().toLowerCase());
    const uniqueLabels = new Set(labels);
    if (uniqueLabels.size !== labels.length) {
      return "Duplicate option labels are not allowed";
    }

    // Duplicate value check
    const values = options.map((o) =>
      o.value !== undefined ? o.value.trim().toLowerCase() : normalizeValue(o.label),
    );
    const uniqueValues = new Set(values);
    if (uniqueValues.size !== values.length) {
      return "Duplicate option values are not allowed";
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Answer construction
// ---------------------------------------------------------------------------

/**
 * Build an answered status for a single Question.
 */
export function buildAnsweredResult(
  question: NormalizedQuestion,
  selectedOption?: NormalizedOption,
  customText?: string,
  selectedValues?: string[],
): Answer {
  if (question.mode === "multi-select" && selectedValues) {
    // Multi-select: find labels matching the selected values
    const selectedOptions = question.options.filter((o) =>
      selectedValues.includes(o.value),
    );
    return {
      questionId: question.id,
      status: "answered",
      label: selectedOptions.map((o) => o.label).join(", "),
      value: selectedValues[0],
      values: selectedValues,
      wasCustom: false,
    };
  }

  if (customText !== undefined) {
    return {
      questionId: question.id,
      status: "answered",
      label: customText,
      value: normalizeValue(customText),
      wasCustom: true,
    };
  }

  if (selectedOption) {
    return {
      questionId: question.id,
      status: "answered",
      label: selectedOption.label,
      value: selectedOption.value,
      wasCustom: false,
    };
  }

  // Should not be called without input — return cancelled as fallback
  return {
    questionId: question.id,
    status: "skipped",
  };
}

/**
 * Build a skipped status for a single Question.
 */
export function buildSkippedResult(question: NormalizedQuestion): Answer {
  return {
    questionId: question.id,
    status: "skipped",
  };
}

/**
 * Build the overall QuestionResult for the tool return.
 */
export function buildResult(
  status: InteractionStatus,
  answers: Answer[],
  question?: NormalizedQuestion,
): QuestionResult {
  return { status, answers, question };
}

// ---------------------------------------------------------------------------
// Tool input validation (called from tool execute)
// ---------------------------------------------------------------------------

/**
 * Validate the full tool input parameters.
 * Returns an error string or null.
 */
export function validateToolInput(input: {
  question?: QuestionInput;
  id?: string;
  text?: string;
  options?: QuestionOption[];
  mode?: string;
}): string | null {
  // Support both flat and nested input shapes
  const question: QuestionInput = input.question ?? {
    id: input.id ?? "",
    text: input.text ?? "",
    options: input.options,
    mode: input.mode as QuestionInput["mode"],
  };

  return validateQuestion(question);
}
