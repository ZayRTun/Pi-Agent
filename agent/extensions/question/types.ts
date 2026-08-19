/**
 * Shared types for the Question interaction extension.
 *
 * These types define the public contract between callers (skills/workflows)
 * and the extension. The extension is stateless: it never persists drafts,
 * owns session state, or reconstructs grilling/wayfinding state.
 */

// ---------------------------------------------------------------------------
// Input types — what a caller sends to the tool
// ---------------------------------------------------------------------------

/** A single option in a select-mode Question. */
export interface QuestionOption {
  /** Display label shown to the user. Preserved verbatim in results. */
  label: string;
  /**
   * Machine value returned in results. When omitted, derived from the
   * boundary-trimmed label via {@link normalizeValue}. Provided values
   * are boundary-trimmed.
   */
  value?: string;
}

/** One Question submitted to the singular tool. */
export interface QuestionInput {
  /** Unique identifier for this Question within a tool call. */
  id: string;
  /** The question text displayed to the user. Must be non-empty. */
  text: string;
  /**
   * Optional short display label for navigation contexts. When omitted,
   * derived from `text` (truncated to 20 chars).
   */
  label?: string;
  /**
   * Input mode. When omitted, inferred from `options`:
   * - empty/absent options → "text"
   * - non-empty options, multiSelect not set → "single-select"
   * - non-empty options, multiSelect true → "multi-select"
   * - multiSelect true without options is invalid
   */
  mode?: "text" | "single-select" | "multi-select";
  /** Available options. Triggers mode inference when present. */
  options?: QuestionOption[];
  /**
   * Allow the user to type a custom "Other" answer instead of choosing
   * an option. Default: false for text mode, true for select modes.
   */
  allowOther?: boolean;
}

// ---------------------------------------------------------------------------
// Output types — what the tool returns
// ---------------------------------------------------------------------------

/** Status of a single Question within a result. */
export type QuestionAnswerStatus = "answered" | "skipped";

/** The user's answer to one Question. */
export interface Answer {
  questionId: string;
  status: QuestionAnswerStatus;
  /** Display label of the selected option or typed text. */
  label?: string;
  /** Machine value of the selected option. */
  value?: string;
  /** All selected machine values for multi-select. */
  values?: string[];
  /** True when the answer came from custom "Other" text input. */
  wasCustom?: boolean;
}

/** Outcome of the overall Question interaction. */
export type InteractionStatus = "answered" | "cancelled" | "unavailable";

/** Structured result returned by the tool. */
export interface QuestionResult {
  status: InteractionStatus;
  answers: Answer[];
  /** The normalized Question that was presented. */
  question?: NormalizedQuestion;
}

/** The normalized Question presented to the user. */
export interface NormalizedQuestion {
  id: string;
  text: string;
  label: string;
  mode: "text" | "single-select" | "multi-select";
  options: NormalizedOption[];
  allowOther: boolean;
}

/** A fully normalized option. */
export interface NormalizedOption {
  label: string;
  value: string;
}

// ---------------------------------------------------------------------------
// Batch types — multi-question round
// ---------------------------------------------------------------------------

/** Minimum number of Questions in a Batch. */
export const BATCH_MIN = 2;
/** Maximum number of Questions in a Batch. */
export const BATCH_MAX = 12;

/** One Question within a Batch input. Same shape as singular input, aliased for semantic clarity. */
export type BatchQuestionInput = QuestionInput;

/** Batch input: two to twelve independent Questions. */
export interface BatchInput {
  /** Independent Questions with unique IDs and optional labels. */
  questions: BatchQuestionInput[];
}

/** Outcome of the overall Batch interaction. */
export type BatchInteractionStatus = "answered" | "cancelled" | "unavailable";

/** A single answer within a Batch result. Same shape as singular answer, aliased for semantic clarity. */
export type BatchAnswer = Answer;

/** Structured result returned by the batch tool. */
export interface BatchResult {
  status: BatchInteractionStatus;
  /** Answers in original Question order. Empty when cancelled/unavailable. */
  answers: BatchAnswer[];
  /** Normalized Questions in original order. */
  questions: NormalizedQuestion[];
}
