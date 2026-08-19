/**
 * Tests for the shared Question interaction boundary.
 *
 * These tests verify observable behavior through public functions:
 * mode inference, normalization, validation, answer construction,
 * and result formatting. They do not test TUI rendering or
 * private component state.
 */

import { describe, expect, it } from "vitest";
import type { QuestionInput } from "./types.js";
import {
  buildAnsweredResult,
  buildResult,
  buildSkippedResult,
  inferMode,
  normalizeOption,
  normalizeQuestion,
  normalizeValue,
  validateQuestion,
  validateToolInput,
} from "./interaction.js";

// ---------------------------------------------------------------------------
// normalizeValue
// ---------------------------------------------------------------------------

describe("normalizeValue", () => {
  it("trims and lowercases", () => {
    expect(normalizeValue("  Hello World  ")).toBe("hello-world");
  });

  it("replaces whitespace with hyphens", () => {
    expect(normalizeValue("multiple   spaces")).toBe("multiple-spaces");
  });

  it("strips non-alphanumeric characters", () => {
    expect(normalizeValue("What's the $price?")).toBe("whats-the-price");
  });

  it("collapses consecutive hyphens", () => {
    expect(normalizeValue("a---b")).toBe("a-b");
  });

  it("strips leading/trailing hyphens", () => {
    expect(normalizeValue("-hello-")).toBe("hello");
  });

  it("handles empty string", () => {
    expect(normalizeValue("")).toBe("");
  });

  it("handles unicode and special chars", () => {
    expect(normalizeValue("café résumé")).toBe("caf-rsum");
  });
});

// ---------------------------------------------------------------------------
// inferMode
// ---------------------------------------------------------------------------

describe("inferMode", () => {
  it("infers text mode when no options", () => {
    const q: QuestionInput = { id: "q1", text: "What is your name?" };
    expect(inferMode(q)).toEqual({ mode: "text" });
  });

  it("infers text mode when options is empty array", () => {
    const q: QuestionInput = { id: "q1", text: "Name?", options: [] };
    expect(inferMode(q)).toEqual({ mode: "text" });
  });

  it("infers single-select when options present, no mode", () => {
    const q: QuestionInput = {
      id: "q1",
      text: "Pick one",
      options: [{ label: "A" }, { label: "B" }],
    };
    expect(inferMode(q)).toEqual({ mode: "single-select" });
  });

  it("infers multi-select when mode is multi-select and options present", () => {
    const q: QuestionInput = {
      id: "q1",
      text: "Pick many",
      mode: "multi-select",
      options: [{ label: "A" }, { label: "B" }],
    };
    expect(inferMode(q)).toEqual({ mode: "multi-select" });
  });

  it("returns error when multi-select without options", () => {
    const q: QuestionInput = {
      id: "q1",
      text: "Pick many",
      mode: "multi-select",
    };
    expect(inferMode(q)).toEqual({
      error: "multi-select mode requires at least one option",
    });
  });

  it("uses explicit single-select mode", () => {
    const q: QuestionInput = {
      id: "q1",
      text: "Pick one",
      mode: "single-select",
      options: [{ label: "A" }],
    };
    expect(inferMode(q)).toEqual({ mode: "single-select" });
  });

  it("ignores explicit text mode when options are present", () => {
    const q: QuestionInput = {
      id: "q1",
      text: "Pick",
      mode: "text",
      options: [{ label: "A" }],
    };
    // options override explicit text mode
    expect(inferMode(q)).toEqual({ mode: "single-select" });
  });
});

// ---------------------------------------------------------------------------
// normalizeOption
// ---------------------------------------------------------------------------

describe("normalizeOption", () => {
  it("preserves display label and derives value", () => {
    expect(normalizeOption({ label: "Option A" })).toEqual({
      label: "Option A",
      value: "option-a",
    });
  });

  it("trims explicit value", () => {
    expect(normalizeOption({ label: "Show", value: "  show-all  " })).toEqual({
      label: "Show",
      value: "show-all",
    });
  });

  it("trims label", () => {
    expect(normalizeOption({ label: "  spaced  " })).toEqual({
      label: "spaced",
      value: "spaced",
    });
  });
});

// ---------------------------------------------------------------------------
// validateQuestion
// ---------------------------------------------------------------------------

describe("validateQuestion", () => {
  it("rejects empty id", () => {
    const q: QuestionInput = { id: "", text: "Hello?" };
    expect(validateQuestion(q)).toBe("Question id must be a non-empty string");
  });

  it("rejects whitespace-only id", () => {
    const q: QuestionInput = { id: "   ", text: "Hello?" };
    expect(validateQuestion(q)).toBe("Question id must be a non-empty string");
  });

  it("rejects empty text", () => {
    const q: QuestionInput = { id: "q1", text: "" };
    expect(validateQuestion(q)).toBe("Question text must be a non-empty string");
  });

  it("rejects whitespace-only text", () => {
    const q: QuestionInput = { id: "q1", text: "   " };
    expect(validateQuestion(q)).toBe("Question text must be a non-empty string");
  });

  it("rejects multi-select without options", () => {
    const q: QuestionInput = {
      id: "q1",
      text: "Pick",
      mode: "multi-select",
    };
    expect(validateQuestion(q)).toBe(
      "multi-select mode requires at least one option",
    );
  });

  it("rejects single-select mode without options", () => {
    const q: QuestionInput = {
      id: "q1",
      text: "Pick",
      mode: "single-select",
    };
    expect(validateQuestion(q)).toBe('mode "single-select" requires options');
  });

  it("rejects option with empty label", () => {
    const q: QuestionInput = {
      id: "q1",
      text: "Pick",
      options: [{ label: "" }],
    };
    expect(validateQuestion(q)).toBe("Option label must be a non-empty string");
  });

  it("rejects duplicate option labels (case-insensitive)", () => {
    const q: QuestionInput = {
      id: "q1",
      text: "Pick",
      options: [{ label: "Foo" }, { label: "foo" }],
    };
    expect(validateQuestion(q)).toBe("Duplicate option labels are not allowed");
  });

  it("rejects duplicate option values (case-insensitive)", () => {
    const q: QuestionInput = {
      id: "q1",
      text: "Pick",
      options: [
        { label: "A", value: "same" },
        { label: "B", value: "SAME" },
      ],
    };
    expect(validateQuestion(q)).toBe(
      "Duplicate option values are not allowed",
    );
  });

  it("rejects duplicate derived values", () => {
    const q: QuestionInput = {
      id: "q1",
      text: "Pick",
      options: [
        { label: "Foo Bar" }, // derives to "foo-bar"
        { label: "Foo   Bar" }, // also derives to "foo-bar"
      ],
    };
    expect(validateQuestion(q)).toBe(
      "Duplicate option values are not allowed",
    );
  });

  it("accepts valid free-text question", () => {
    const q: QuestionInput = { id: "q1", text: "What is your name?" };
    expect(validateQuestion(q)).toBeNull();
  });

  it("accepts valid single-select question", () => {
    const q: QuestionInput = {
      id: "q1",
      text: "Pick a color",
      options: [{ label: "Red" }, { label: "Blue" }, { label: "Green" }],
    };
    expect(validateQuestion(q)).toBeNull();
  });

  it("accepts valid multi-select question", () => {
    const q: QuestionInput = {
      id: "q1",
      text: "Pick colors",
      mode: "multi-select",
      options: [{ label: "Red" }, { label: "Blue" }],
    };
    expect(validateQuestion(q)).toBeNull();
  });

  it("accepts options with explicit different values", () => {
    const q: QuestionInput = {
      id: "q1",
      text: "Pick",
      options: [
        { label: "Show All", value: "all" },
        { label: "Show None", value: "none" },
      ],
    };
    expect(validateQuestion(q)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// normalizeQuestion
// ---------------------------------------------------------------------------

describe("normalizeQuestion", () => {
  it("normalizes a free-text question", () => {
    const q: QuestionInput = { id: "q1", text: "  What is your name?  " };
    const n = normalizeQuestion(q);
    expect(n.id).toBe("q1");
    expect(n.text).toBe("What is your name?");
    expect(n.mode).toBe("text");
    expect(n.options).toEqual([]);
    expect(n.allowOther).toBe(false);
  });

  it("derives label from text when not provided", () => {
    const q: QuestionInput = { id: "q1", text: "Short?" };
    expect(normalizeQuestion(q).label).toBe("Short?");
  });

  it("truncates long label with ellipsis", () => {
    const q: QuestionInput = {
      id: "q1",
      text: "This is a very long question text that exceeds twenty characters",
    };
    expect(normalizeQuestion(q).label).toBe(
      "This is a very long …",
    );
  });

  it("uses explicit label when provided", () => {
    const q: QuestionInput = {
      id: "q1",
      text: "Pick a color",
      label: "Color",
    };
    expect(normalizeQuestion(q).label).toBe("Color");
  });

  it("normalizes options with derived values", () => {
    const q: QuestionInput = {
      id: "q1",
      text: "Pick",
      options: [{ label: "Option A" }, { label: "Option B" }],
    };
    const n = normalizeQuestion(q);
    expect(n.options).toEqual([
      { label: "Option A", value: "option-a" },
      { label: "Option B", value: "option-b" },
    ]);
  });

  it("sets allowOther true for select modes by default", () => {
    const q: QuestionInput = {
      id: "q1",
      text: "Pick",
      options: [{ label: "A" }],
    };
    expect(normalizeQuestion(q).allowOther).toBe(true);
  });

  it("sets allowOther false for text mode by default", () => {
    const q: QuestionInput = { id: "q1", text: "Name?" };
    expect(normalizeQuestion(q).allowOther).toBe(false);
  });

  it("respects explicit allowOther override", () => {
    const q: QuestionInput = {
      id: "q1",
      text: "Pick",
      options: [{ label: "A" }],
      allowOther: false,
    };
    expect(normalizeQuestion(q).allowOther).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildAnsweredResult
// ---------------------------------------------------------------------------

describe("buildAnsweredResult", () => {
  const singleSelect = normalizeQuestion({
    id: "q1",
    text: "Color?",
    options: [{ label: "Red" }, { label: "Blue" }],
  });

  it("builds answered result for selected option", () => {
    const answer = buildAnsweredResult(singleSelect, singleSelect.options[1]);
    expect(answer).toEqual({
      questionId: "q1",
      status: "answered",
      label: "Blue",
      value: "blue",
      wasCustom: false,
    });
  });

  it("builds answered result for custom text", () => {
    const answer = buildAnsweredResult(singleSelect, undefined, "Green");
    expect(answer).toEqual({
      questionId: "q1",
      status: "answered",
      label: "Green",
      value: "green",
      wasCustom: true,
    });
  });

  it("builds answered result for multi-select", () => {
    const multi = normalizeQuestion({
      id: "q2",
      text: "Colors?",
      mode: "multi-select",
      options: [{ label: "Red" }, { label: "Blue" }, { label: "Green" }],
    });
    const answer = buildAnsweredResult(
      multi,
      undefined,
      undefined,
      ["red", "green"],
    );
    expect(answer).toEqual({
      questionId: "q2",
      status: "answered",
      label: "Red, Green",
      value: "red",
      values: ["red", "green"],
      wasCustom: false,
    });
  });

  it("returns skipped when no input provided", () => {
    const answer = buildAnsweredResult(singleSelect);
    expect(answer.status).toBe("skipped");
  });
});

// ---------------------------------------------------------------------------
// buildSkippedResult
// ---------------------------------------------------------------------------

describe("buildSkippedResult", () => {
  it("builds skipped result", () => {
    const q = normalizeQuestion({
      id: "q1",
      text: "Color?",
      options: [{ label: "Red" }],
    });
    const answer = buildSkippedResult(q);
    expect(answer).toEqual({
      questionId: "q1",
      status: "skipped",
    });
  });
});

// ---------------------------------------------------------------------------
// buildResult
// ---------------------------------------------------------------------------

describe("buildResult", () => {
  it("builds answered result", () => {
    const q = normalizeQuestion({ id: "q1", text: "Name?" });
    const answer = buildAnsweredResult(q, undefined, "Alice");
    const result = buildResult("answered", [answer], q);
    expect(result.status).toBe("answered");
    expect(result.answers).toHaveLength(1);
    expect(result.question).toBeDefined();
    expect(result.question!.id).toBe("q1");
  });

  it("builds cancelled result without question", () => {
    const result = buildResult("cancelled", []);
    expect(result.status).toBe("cancelled");
    expect(result.answers).toEqual([]);
    expect(result.question).toBeUndefined();
  });

  it("builds unavailable result", () => {
    const result = buildResult("unavailable", []);
    expect(result.status).toBe("unavailable");
  });
});

// ---------------------------------------------------------------------------
// validateToolInput
// ---------------------------------------------------------------------------

describe("validateToolInput", () => {
  it("validates flat input shape", () => {
    expect(
      validateToolInput({ id: "", text: "Hello?" }),
    ).toBe("Question id must be a non-empty string");
  });

  it("validates nested input shape", () => {
    expect(
      validateToolInput({
        question: { id: "q1", text: "" },
      }),
    ).toBe("Question text must be a non-empty string");
  });

  it("accepts valid flat input", () => {
    expect(
      validateToolInput({ id: "q1", text: "Name?" }),
    ).toBeNull();
  });
});
