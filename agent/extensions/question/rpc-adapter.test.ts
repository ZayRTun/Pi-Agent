/**
 * Tests for the RPC adapter: runtime parity for Batch interaction.
 *
 * Verifies that RPC mode collects Batch Questions sequentially through
 * native dialog adapters, preserves ordering, handles Skip controls as
 * domain-level skipped statuses, and cancels atomically.
 */

import { describe, expect, it, vi } from "vitest";
import type { NormalizedQuestion } from "./types.js";
import { normalizeBatch, normalizeQuestion } from "./interaction.js";
import { runRpcBatch, runRpcQuestion } from "./rpc-adapter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeQuestion(
  overrides: Partial<NormalizedQuestion> & { id: string; text: string },
): NormalizedQuestion {
  return {
    label: overrides.text.slice(0, 20),
    mode: "text",
    options: [],
    allowOther: false,
    ...overrides,
  };
}

function makeSelectQuestion(
  id: string,
  text: string,
  options: { label: string; value: string }[],
  allowOther = true,
): NormalizedQuestion {
  return {
    id,
    text,
    label: text.slice(0, 20),
    mode: "single-select",
    options,
    allowOther,
  };
}

function makeMultiSelectQuestion(
  id: string,
  text: string,
  options: { label: string; value: string }[],
  allowOther = false,
): NormalizedQuestion {
  return {
    id,
    text,
    label: text.slice(0, 20),
    mode: "multi-select",
    options,
    allowOther,
  };
}

/**
 * Create a mock RpcContext with controllable return values for each
 * dialog method. Values are consumed sequentially per method.
 */
function mockRpcContext(overrides: {
  selectReturns?: (string | undefined)[];
  inputReturns?: (string | undefined)[];
  confirmReturns?: boolean[];
} = {}) {
  let selectIdx = 0;
  let inputIdx = 0;
  let confirmIdx = 0;

  const selectReturns = overrides.selectReturns ?? [];
  const inputReturns = overrides.inputReturns ?? [];
  const confirmReturns = overrides.confirmReturns ?? [];

  return {
    ui: {
      select: vi.fn(async () => {
        if (selectIdx < selectReturns.length) return selectReturns[selectIdx++];
        return undefined;
      }),
      input: vi.fn(async () => {
        if (inputIdx < inputReturns.length) return inputReturns[inputIdx++];
        return undefined;
      }),
      confirm: vi.fn(async () => {
        if (confirmIdx < confirmReturns.length)
          return confirmReturns[confirmIdx++];
        return false;
      }),
    },
    mode: "rpc",
  };
}

// ---------------------------------------------------------------------------
// Single Question — text mode
// ---------------------------------------------------------------------------

describe("runRpcQuestion — text mode", () => {
  it("returns answered with typed text", async () => {
    const q = makeQuestion({ id: "q1", text: "What is your name?" });
    // select: "Type your answer…", input: "Alice"
    const ctx = mockRpcContext({
      selectReturns: ["Type your answer\u2026"],
      inputReturns: ["Alice"],
    });
    const result = await runRpcQuestion(q, ctx as any);

    expect(result.status).toBe("answered");
    expect(result.answers).toHaveLength(1);
    expect(result.answers[0].status).toBe("answered");
    expect(result.answers[0].label).toBe("Alice");
    expect(result.answers[0].wasCustom).toBe(true);
    expect(result.question?.id).toBe("q1");
  });

  it("returns skipped when Skip is selected", async () => {
    const q = makeQuestion({ id: "q1", text: "Name?" });
    const ctx = mockRpcContext({ selectReturns: ["Skip"] });
    const result = await runRpcQuestion(q, ctx as any);

    expect(result.status).toBe("answered");
    expect(result.answers).toHaveLength(1);
    expect(result.answers[0].status).toBe("skipped");
    expect(result.answers[0].questionId).toBe("q1");
  });

  it("returns cancelled when user cancels the initial select", async () => {
    const q = makeQuestion({ id: "q1", text: "Name?" });
    const ctx = mockRpcContext({ selectReturns: [undefined] });
    const result = await runRpcQuestion(q, ctx as any);

    expect(result.status).toBe("cancelled");
    expect(result.answers).toEqual([]);
  });

  it("returns cancelled when user cancels the text input", async () => {
    const q = makeQuestion({ id: "q1", text: "Name?" });
    const ctx = mockRpcContext({
      selectReturns: ["Type your answer\u2026"],
      inputReturns: [undefined],
    });
    const result = await runRpcQuestion(q, ctx as any);

    expect(result.status).toBe("cancelled");
    expect(result.answers).toEqual([]);
  });

  it("returns cancelled when user submits empty text", async () => {
    const q = makeQuestion({ id: "q1", text: "Name?" });
    const ctx = mockRpcContext({
      selectReturns: ["Type your answer\u2026"],
      inputReturns: ["   "],
    });
    const result = await runRpcQuestion(q, ctx as any);

    expect(result.status).toBe("cancelled");
    expect(result.answers).toEqual([]);
  });

  it("presents Type your answer and Skip as the only select options", async () => {
    const q = makeQuestion({ id: "q1", text: "Name?" });
    const ctx = mockRpcContext({ selectReturns: ["Skip"] });
    await runRpcQuestion(q, ctx as any);

    const selectCall = ctx.ui.select.mock.calls[0];
    const optionLabels = selectCall[1];
    expect(optionLabels).toEqual(["Type your answer\u2026", "Skip"]);
  });
});

// ---------------------------------------------------------------------------
// Single Question — single-select mode
// ---------------------------------------------------------------------------

describe("runRpcQuestion — single-select mode", () => {
  it("returns answered with selected option", async () => {
    const q = makeSelectQuestion("q1", "Pick color", [
      { label: "Red", value: "red" },
      { label: "Blue", value: "blue" },
    ]);
    const ctx = mockRpcContext({ selectReturns: ["Red"] });
    const result = await runRpcQuestion(q, ctx as any);

    expect(result.status).toBe("answered");
    expect(result.answers).toHaveLength(1);
    expect(result.answers[0].status).toBe("answered");
    expect(result.answers[0].label).toBe("Red");
    expect(result.answers[0].value).toBe("red");
    expect(result.question?.id).toBe("q1");
  });

  it("returns skipped when Skip is selected", async () => {
    const q = makeSelectQuestion("q1", "Pick color", [
      { label: "Red", value: "red" },
      { label: "Blue", value: "blue" },
    ]);
    const ctx = mockRpcContext({ selectReturns: ["Skip"] });
    const result = await runRpcQuestion(q, ctx as any);

    expect(result.status).toBe("answered");
    expect(result.answers).toHaveLength(1);
    expect(result.answers[0].status).toBe("skipped");
    expect(result.answers[0].questionId).toBe("q1");
  });

  it("returns cancelled when user cancels selection", async () => {
    const q = makeSelectQuestion("q1", "Pick color", [
      { label: "Red", value: "red" },
    ]);
    const ctx = mockRpcContext({ selectReturns: [undefined] });
    const result = await runRpcQuestion(q, ctx as any);

    expect(result.status).toBe("cancelled");
    expect(result.answers).toEqual([]);
  });

  it("returns answered with custom text when Type something is selected", async () => {
    const q = makeSelectQuestion("q1", "Pick color", [
      { label: "Red", value: "red" },
    ]);
    const ctx = mockRpcContext({
      selectReturns: ["Type something\u2026"],
      inputReturns: ["Custom"],
    });
    const result = await runRpcQuestion(q, ctx as any);

    expect(result.status).toBe("answered");
    expect(result.answers[0].label).toBe("Custom");
    expect(result.answers[0].wasCustom).toBe(true);
  });

  it("select options include original options, Type something, and Skip", async () => {
    const q = makeSelectQuestion("q1", "Pick", [
      { label: "A", value: "a" },
      { label: "B", value: "b" },
    ]);
    const ctx = mockRpcContext({ selectReturns: ["A"] });
    await runRpcQuestion(q, ctx as any);

    const optionLabels = ctx.ui.select.mock.calls[0][1];
    expect(optionLabels).toEqual(["A", "B", "Type something\u2026", "Skip"]);
  });

  it("Skip is not one of the original domain options", async () => {
    const q = makeSelectQuestion("q1", "Pick", [
      { label: "A", value: "a" },
    ]);
    const ctx = mockRpcContext({ selectReturns: ["A"] });
    await runRpcQuestion(q, ctx as any);

    const optionLabels = ctx.ui.select.mock.calls[0][1];
    const skipIndex = optionLabels.indexOf("Skip");
    const originalEnd = optionLabels.indexOf("Type something\u2026");
    // Skip comes after Type something, which comes after original options
    expect(skipIndex).toBeGreaterThan(originalEnd);
  });
});

// ---------------------------------------------------------------------------
// Single Question — multi-select mode
// ---------------------------------------------------------------------------

describe("runRpcQuestion — multi-select mode", () => {
  it("returns answered with selected values", async () => {
    const q = makeMultiSelectQuestion("q1", "Pick colors", [
      { label: "Red", value: "red" },
      { label: "Blue", value: "blue" },
      { label: "Green", value: "green" },
    ]);
    // Skip prompt → no, then Red→yes, Blue→no, Green→yes, custom→no
    const ctx = mockRpcContext({
      confirmReturns: [false, true, false, true, false],
    });
    const result = await runRpcQuestion(q, ctx as any);

    expect(result.status).toBe("answered");
    expect(result.answers).toHaveLength(1);
    expect(result.answers[0].status).toBe("answered");
    expect(result.answers[0].values).toEqual(["red", "green"]);
  });

  it("returns skipped when Skip prompt is accepted", async () => {
    const q = makeMultiSelectQuestion("q1", "Pick colors", [
      { label: "Red", value: "red" },
    ]);
    // Skip prompt → yes
    const ctx = mockRpcContext({ confirmReturns: [true] });
    const result = await runRpcQuestion(q, ctx as any);

    expect(result.status).toBe("answered");
    expect(result.answers).toHaveLength(1);
    expect(result.answers[0].status).toBe("skipped");
    expect(result.answers[0].questionId).toBe("q1");
  });

  it("returns cancelled when user declines Skip and selects nothing", async () => {
    const q = makeMultiSelectQuestion("q1", "Pick colors", [
      { label: "Red", value: "red" },
    ]);
    // Skip prompt → no, Red→no, custom→no
    const ctx = mockRpcContext({ confirmReturns: [false, false, false] });
    const result = await runRpcQuestion(q, ctx as any);

    expect(result.status).toBe("cancelled");
    expect(result.answers).toEqual([]);
  });

  it("Skip prompt is the first confirm call", async () => {
    const q = makeMultiSelectQuestion("q1", "Pick colors", [
      { label: "A", value: "a" },
    ]);
    const ctx = mockRpcContext({ confirmReturns: [true] });
    await runRpcQuestion(q, ctx as any);

    const firstConfirmCall = ctx.ui.confirm.mock.calls[0];
    expect(firstConfirmCall[0]).toBe(q.text);
    expect(firstConfirmCall[1]).toBe("Skip this question?");
  });

  it("Skip is never a regular option in the confirm sequence", async () => {
    const q = makeMultiSelectQuestion("q1", "Pick colors", [
      { label: "A", value: "a" },
      { label: "B", value: "b" },
    ]);
    const ctx = mockRpcContext({
      confirmReturns: [false, true, false, false],
    });
    await runRpcQuestion(q, ctx as any);

    // All confirm calls after the first (Skip prompt) should be about options
    const confirmCalls = ctx.ui.confirm.mock.calls;
    // Skip prompt, A prompt, B prompt, custom prompt
    expect(confirmCalls[0][1]).toBe("Skip this question?");
    expect(confirmCalls[1][1]).toBe('Select "A"?');
    expect(confirmCalls[2][1]).toBe('Select "B"?');
    // No "Skip" in the option prompts
    for (let i = 1; i < confirmCalls.length; i++) {
      expect(confirmCalls[i][1]).not.toContain("Skip");
    }
  });
});

// ---------------------------------------------------------------------------
// Batch RPC
// ---------------------------------------------------------------------------

describe("runRpcBatch", () => {
  it("collects answers sequentially preserving question order", async () => {
    const questions = [
      makeQuestion({ id: "q1", text: "First?" }),
      makeQuestion({ id: "q2", text: "Second?" }),
    ];
    // q1: Type → "Answer1", q2: Type → "Answer2"
    const ctx = mockRpcContext({
      selectReturns: [
        "Type your answer\u2026",
        "Type your answer\u2026",
      ],
      inputReturns: ["Answer1", "Answer2"],
    });
    const result = await runRpcBatch(questions, ctx as any);

    expect(result.status).toBe("answered");
    expect(result.answers).toHaveLength(2);
    expect(result.answers[0].questionId).toBe("q1");
    expect(result.answers[0].label).toBe("Answer1");
    expect(result.answers[1].questionId).toBe("q2");
    expect(result.answers[1].label).toBe("Answer2");
    expect(result.questions).toHaveLength(2);
    expect(result.questions[0].id).toBe("q1");
    expect(result.questions[1].id).toBe("q2");
  });

  it("returns cancelled when user cancels mid-batch", async () => {
    const questions = [
      makeQuestion({ id: "q1", text: "First?" }),
      makeQuestion({ id: "q2", text: "Second?" }),
    ];
    // q1: Type → "Answer1", q2: cancel (select returns undefined)
    const ctx = mockRpcContext({
      selectReturns: ["Type your answer\u2026", undefined],
      inputReturns: ["Answer1"],
    });
    const result = await runRpcBatch(questions, ctx as any);

    expect(result.status).toBe("cancelled");
    expect(result.answers).toEqual([]);
    expect(result.questions).toHaveLength(2);
  });

  it("cancels atomically — discards incomplete answers", async () => {
    const questions = [
      makeQuestion({ id: "q1", text: "First?" }),
      makeQuestion({ id: "q2", text: "Second?" }),
      makeQuestion({ id: "q3", text: "Third?" }),
    ];
    // q1: Type → "Answer1", q2: cancel
    const ctx = mockRpcContext({
      selectReturns: [
        "Type your answer\u2026",
        undefined,
        "Type your answer\u2026",
      ],
      inputReturns: ["Answer1", "Answer3"],
    });
    const result = await runRpcBatch(questions, ctx as any);

    // Cancellation is atomic — Answer1 should not appear
    expect(result.status).toBe("cancelled");
    expect(result.answers).toEqual([]);
  });

  it("preserves normalized questions in result", async () => {
    const questions = [
      makeSelectQuestion("q1", "Color?", [{ label: "Red", value: "red" }]),
      makeQuestion({ id: "q2", text: "Name?" }),
    ];
    // q1: select Red, q2: Type → "Alice"
    const ctx = mockRpcContext({
      selectReturns: ["Red", "Type your answer\u2026"],
      inputReturns: ["Alice"],
    });
    const result = await runRpcBatch(questions, ctx as any);

    expect(result.status).toBe("answered");
    expect(result.questions[0].mode).toBe("single-select");
    expect(result.questions[1].mode).toBe("text");
  });

  it("handles mixed modes in batch", async () => {
    const questions = [
      makeQuestion({ id: "q1", text: "Name?" }),
      makeSelectQuestion("q2", "Color?", [
        { label: "Red", value: "red" },
        { label: "Blue", value: "blue" },
      ]),
      makeMultiSelectQuestion("q3", "Tags?", [
        { label: "A", value: "a" },
        { label: "B", value: "b" },
      ]),
    ];

    // q1 (text): Type → "Alice"
    // q2 (select): "Red"
    // q3 (multi): Skip prompt → no, A→yes, B→no, custom→no
    const ctx = mockRpcContext({
      selectReturns: [
        "Type your answer\u2026", // q1 text
        "Red", // q2 select
      ],
      inputReturns: ["Alice"],
      confirmReturns: [false, true, false, false], // q3 multi
    });

    const result = await runRpcBatch(questions, ctx as any);

    expect(result.status).toBe("answered");
    expect(result.answers).toHaveLength(3);
    expect(result.answers[0].questionId).toBe("q1");
    expect(result.answers[0].label).toBe("Alice");
    expect(result.answers[1].questionId).toBe("q2");
    expect(result.answers[1].label).toBe("Red");
    expect(result.answers[2].questionId).toBe("q3");
    expect(result.answers[2].values).toEqual(["a"]);
  });

  it("skip in batch produces skipped status for that question", async () => {
    const questions = [
      makeQuestion({ id: "q1", text: "First?" }),
      makeQuestion({ id: "q2", text: "Second?" }),
    ];
    // q1: Skip, q2: Type → "Answer2"
    const ctx = mockRpcContext({
      selectReturns: ["Skip", "Type your answer\u2026"],
      inputReturns: ["Answer2"],
    });
    const result = await runRpcBatch(questions, ctx as any);

    expect(result.status).toBe("answered");
    expect(result.answers[0].status).toBe("skipped");
    expect(result.answers[0].questionId).toBe("q1");
    expect(result.answers[1].status).toBe("answered");
    expect(result.answers[1].label).toBe("Answer2");
  });

  it("skip in batch does not cancel the entire batch", async () => {
    const questions = [
      makeQuestion({ id: "q1", text: "First?" }),
      makeQuestion({ id: "q2", text: "Second?" }),
    ];
    // q1: Skip, q2: Type → "Answer2"
    const ctx = mockRpcContext({
      selectReturns: ["Skip", "Type your answer\u2026"],
      inputReturns: ["Answer2"],
    });
    const result = await runRpcBatch(questions, ctx as any);

    // Skip should NOT cancel the batch
    expect(result.status).toBe("answered");
    expect(result.answers).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Runtime parity — Skip controls
// ---------------------------------------------------------------------------

describe("Skip controls — runtime parity", () => {
  it("text Skip produces answered status with skipped answer", async () => {
    const q = makeQuestion({ id: "q1", text: "Name?" });
    const ctx = mockRpcContext({ selectReturns: ["Skip"] });
    const result = await runRpcQuestion(q, ctx as any);

    // Skip produces "answered" with a skipped answer, not "cancelled"
    expect(result.status).toBe("answered");
    expect(result.answers[0].status).toBe("skipped");
  });

  it("single-select Skip produces answered status with skipped answer", async () => {
    const q = makeSelectQuestion("q1", "Pick?", [{ label: "A", value: "a" }]);
    const ctx = mockRpcContext({ selectReturns: ["Skip"] });
    const result = await runRpcQuestion(q, ctx as any);

    expect(result.status).toBe("answered");
    expect(result.answers[0].status).toBe("skipped");
  });

  it("multi-select Skip produces answered status with skipped answer", async () => {
    const q = makeMultiSelectQuestion("q1", "Pick?", [
      { label: "A", value: "a" },
    ]);
    const ctx = mockRpcContext({ confirmReturns: [true] });
    const result = await runRpcQuestion(q, ctx as any);

    expect(result.status).toBe("answered");
    expect(result.answers[0].status).toBe("skipped");
  });

  it("Skip is never a regular domain option — it is a control", async () => {
    const q = makeSelectQuestion("q1", "Pick?", [
      { label: "A", value: "a" },
    ]);
    const ctx = mockRpcContext({ selectReturns: ["A"] });
    await runRpcQuestion(q, ctx as any);

    const optionLabels = ctx.ui.select.mock.calls[0][1];
    // "A" is the domain option; "Skip" is appended as a control
    expect(optionLabels[0]).toBe("A");
    expect(optionLabels).toContain("Skip");
    // Skip is not one of the original domain options
    expect(optionLabels.indexOf("Skip")).toBeGreaterThanOrEqual(
      optionLabels.length - 2,
    );
  });

  it("cancelled is never produced by Skip — only by user dismissal", async () => {
    const q = makeSelectQuestion("q1", "Pick?", [
      { label: "A", value: "a" },
    ]);
    const ctx = mockRpcContext({ selectReturns: ["Skip"] });
    const result = await runRpcQuestion(q, ctx as any);

    // Skip → answered with skipped, NOT cancelled
    expect(result.status).not.toBe("cancelled");
    expect(result.status).toBe("answered");
  });
});

// ---------------------------------------------------------------------------
// Ordering and result contract
// ---------------------------------------------------------------------------

describe("Result contract", () => {
  it("batch result preserves original question order in questions array", async () => {
    const questions = [
      makeQuestion({ id: "c", text: "Third?" }),
      makeQuestion({ id: "a", text: "First?" }),
      makeQuestion({ id: "b", text: "Second?" }),
    ];
    const ctx = mockRpcContext({
      selectReturns: [
        "Type your answer\u2026",
        "Type your answer\u2026",
        "Type your answer\u2026",
      ],
      inputReturns: ["C", "A", "B"],
    });
    const result = await runRpcBatch(questions, ctx as any);

    expect(result.questions.map((q) => q.id)).toEqual(["c", "a", "b"]);
    expect(result.answers.map((a) => a.questionId)).toEqual(["c", "a", "b"]);
  });

  it("batch answer matches question by questionId", async () => {
    const questions = [
      makeQuestion({ id: "q1", text: "Name?" }),
      makeSelectQuestion("q2", "Color?", [
        { label: "Red", value: "red" },
      ]),
    ];
    const ctx = mockRpcContext({
      selectReturns: ["Type your answer\u2026", "Red"],
      inputReturns: ["Alice"],
    });
    const result = await runRpcBatch(questions, ctx as any);

    expect(result.answers[0].questionId).toBe("q1");
    expect(result.answers[1].questionId).toBe("q2");
  });

  it("single question result includes normalized question", async () => {
    const raw = makeQuestion({ id: "q1", text: "  Name?  " });
    const q = normalizeQuestion(raw);
    const ctx = mockRpcContext({
      selectReturns: ["Type your answer\u2026"],
      inputReturns: ["Alice"],
    });
    const result = await runRpcQuestion(q, ctx as any);

    expect(result.question).toBeDefined();
    expect(result.question!.id).toBe("q1");
    expect(result.question!.text).toBe("Name?");
  });

  it("batch result includes all normalized questions", async () => {
    const questions = normalizeBatch({
      questions: [
        makeQuestion({ id: "q1", text: "  First?  " }),
        makeQuestion({ id: "q2", text: "Second?" }),
      ],
    });
    const ctx = mockRpcContext({
      selectReturns: [
        "Type your answer\u2026",
        "Type your answer\u2026",
      ],
      inputReturns: ["A", "B"],
    });
    const result = await runRpcBatch(questions, ctx as any);

    expect(result.questions).toHaveLength(2);
    expect(result.questions[0].text).toBe("First?");
    expect(result.questions[1].text).toBe("Second?");
  });
});
