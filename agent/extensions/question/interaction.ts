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
  BatchAnswer,
  BatchInput,
  BatchInteractionStatus,
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
// Batch validation
// ---------------------------------------------------------------------------

/**
 * Validate a batch of Questions. Returns an error string or null.
 *
 * Rules:
 * - Must have at least BATCH_MIN questions
 * - Must have at most BATCH_MAX questions
 * - All Question IDs must be unique (case-insensitive)
 * - All Question labels must be unique (case-insensitive)
 * - Each Question must individually pass validateQuestion
 */
export function validateBatch(batch: BatchInput): string | null {
  const { questions } = batch;

  if (!questions || !Array.isArray(questions)) {
    return "questions must be an array";
  }

  if (questions.length < BATCH_MIN) {
    return `Batch must contain at least ${BATCH_MIN} questions (got ${questions.length})`;
  }

  if (questions.length > BATCH_MAX) {
    return `Batch must contain at most ${BATCH_MAX} questions (got ${questions.length})`;
  }

  // Check for duplicate IDs (case-insensitive)
  const ids = questions.map((q) => q.id?.trim().toLowerCase()).filter(Boolean);
  const uniqueIds = new Set(ids);
  if (uniqueIds.size !== ids.length) {
    return "Duplicate question IDs are not allowed";
  }

  // Check for duplicate labels (case-insensitive)
  // Labels are computed from the question text if not provided
  const labels = questions.map((q) => {
    const rawLabel = q.label?.trim();
    if (rawLabel) return rawLabel.toLowerCase();
    const text = q.text?.trim() ?? "";
    return (text.length > 20 ? text.slice(0, 20) + "\u2026" : text).toLowerCase();
  });
  const uniqueLabels = new Set(labels);
  if (uniqueLabels.size !== labels.length) {
    return "Duplicate question labels are not allowed";
  }

  // Validate each question individually
  for (const q of questions) {
    const err = validateQuestion(q);
    if (err) return err;
  }

  return null;
}

/**
 * Normalize a batch of Questions. Preserves original order.
 * Does not validate — call {@link validateBatch} first.
 */
export function normalizeBatch(batch: BatchInput): NormalizedQuestion[] {
  return batch.questions.map(normalizeQuestion);
}

/**
 * Build a BatchResult from answers and normalized questions.
 */
export function buildBatchResult(
  status: BatchInteractionStatus,
  answers: BatchAnswer[],
  questions: NormalizedQuestion[],
): BatchResult {
  return { status, answers, questions };
}

// ---------------------------------------------------------------------------
// Answer construction
// ---------------------------------------------------------------------------

/** Input for building an answered result. */
export interface AnswerInput {
  selectedOption?: NormalizedOption;
  customText?: string;
  selectedValues?: string[];
}

/**
 * Build an answered status for a single Question.
 */
export function buildAnsweredResult(
  question: NormalizedQuestion,
  input: AnswerInput,
): Answer {
  if (question.mode === "multi-select" && input.selectedValues) {
    // Multi-select: find labels matching the selected values
    const selectedOptions = question.options.filter((o) =>
      input.selectedValues!.includes(o.value),
    );
    return {
      questionId: question.id,
      status: "answered",
      label: selectedOptions.map((o) => o.label).join(", "),
      value: input.selectedValues[0],
      values: input.selectedValues,
      wasCustom: false,
    };
  }

  if (input.customText !== undefined) {
    return {
      questionId: question.id,
      status: "answered",
      label: input.customText,
      value: normalizeValue(input.customText),
      wasCustom: true,
    };
  }

  if (input.selectedOption) {
    return {
      questionId: question.id,
      status: "answered",
      label: input.selectedOption.label,
      value: input.selectedOption.value,
      wasCustom: false,
    };
  }

  // Should not be called without input — return skipped as fallback
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

/**
 * Validate the full batch tool input parameters.
 * Returns an error string or null.
 */
export function validateBatchToolInput(input: {
  questions?: QuestionInput[];
}): string | null {
  if (!input.questions || !Array.isArray(input.questions)) {
    return "questions must be an array";
  }
  return validateBatch({ questions: input.questions });
}
