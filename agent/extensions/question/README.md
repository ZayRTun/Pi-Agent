# Question Interaction Extension

A stateless Pi extension that provides structured user input collection through the `ask_user_question` and `ask_user_questions` tools. Designed for use by future skill authors without modifying packaged skills.

## Installation

The extension lives at `~/.pi/agent/extensions/question/` and is auto-discovered by Pi.

## Public Types

All shared types are exported from the extension entry point for use in tests and integrations:

```typescript
import type {
  // Input types
  QuestionInput,
  QuestionOption,
  BatchInput,
  BatchQuestionInput,
  // Output types
  Answer,
  BatchAnswer,
  QuestionResult,
  BatchResult,
  // Normalized types
  NormalizedQuestion,
  NormalizedOption,
  // Status types
  QuestionAnswerStatus,
  InteractionStatus,
  BatchInteractionStatus,
  // Constants
  BATCH_MIN,
  BATCH_MAX,
} from "~/.pi/agent/extensions/question/index.js";
```

## Tools

### `ask_user_question`

Ask the user one question and collect their answer. Supports four input modes:

| Mode | When to use | Options required |
|------|-------------|------------------|
| **free-text** | Short clarifications, names, descriptions | No |
| **single-select** | Choose one option from a list | Yes |
| **multi-select** | Choose several options from a list | Yes + `mode: "multi-select"` |
| **custom "Other"** | Option-based question with a free-text escape hatch | Yes + `allowOther: true` (default for select modes) |

#### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | ✅ | Unique identifier for this question |
| `text` | string | ✅ | The question text displayed to the user |
| `label` | string | ❌ | Short navigation label (defaults to truncated text) |
| `mode` | string | ❌ | Input mode: `"text"`, `"single-select"`, or `"multi-select"`. Inferred from options when omitted. |
| `options` | array | ❌ | Available options. Each has `label` (required) and `value` (optional, derived from label). |
| `allowOther` | boolean | ❌ | Allow custom "Other" text input. Default: `false` for text, `true` for select modes. |

#### Mode Inference

When `mode` is omitted, it is inferred from `options`:

- **No options** → `"text"` (free-text input)
- **Options present** → `"single-select"`
- **Options present + `mode: "multi-select"`** → `"multi-select"`
- **`mode: "multi-select"` without options** → Error (invalid)

#### Result Contract

```json
{
  "status": "answered" | "cancelled" | "unavailable",
  "answers": [
    {
      "questionId": "q1",
      "status": "answered" | "skipped",
      "label": "User's selected label or typed text",
      "value": "machine-value",
      "values": ["val1", "val2"],
      "wasCustom": false
    }
  ],
  "question": {
    "id": "q1",
    "text": "The original question",
    "label": "Navigation label",
    "mode": "single-select",
    "options": [...],
    "allowOther": true
  }
}
```

### `ask_user_questions`

Ask the user two to twelve independent questions and collect their answers in a single batch interaction. Supports mixed input modes across questions.

#### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `questions` | array | ✅ | Two to twelve Question objects. Each has `id`, `text`, and optional `label`, `mode`, `options`, `allowOther`. |

#### Batch Validation

Invalid batches are rejected as tool errors:
- Fewer than 2 or more than 12 questions
- Duplicate question IDs (case-insensitive)
- Duplicate question labels (case-insensitive)
- Any individual question fails validation

#### Batch Result Contract

```json
{
  "status": "answered" | "cancelled" | "unavailable",
  "answers": [
    {
      "questionId": "q1",
      "status": "answered" | "skipped",
      "label": "User's selected label or typed text",
      "value": "machine-value",
      "values": ["val1", "val2"],
      "wasCustom": false
    }
  ],
  "questions": [
    { "id": "q1", "text": "...", "label": "...", "mode": "...", "options": [...], "allowOther": true }
  ]
}
```

The `answers` array preserves the original Question order. Cancelled batches return empty answers. Each answer has `status: "answered"` or `status: "skipped"`.

## Outcome Types

| Status | Meaning |
|--------|---------|
| `answered` | User selected an option or typed custom text |
| `cancelled` | User pressed Escape to cancel |
| `unavailable` | No compatible UI (JSON/print modes) |

For answered questions, each `Answer` has:

| Field | Description |
|-------|-------------|
| `status` | `"answered"` or `"skipped"` |
| `label` | Display label of the selected option, or typed text |
| `value` | Machine value of the selected option |
| `values` | All selected machine values (multi-select only) |
| `wasCustom` | `true` when the answer came from "Other" text input |

## Runtime Behavior

### TUI Mode

**Single Question:**

Interactive terminal UI with:

- **Free-text**: Text input with Enter to submit
- **Single-select**: Arrow key navigation, Enter to select
- **Multi-select**: Arrow keys + Space to toggle, Enter to confirm all selections
- **"Other" option**: Opens inline text editor; Escape returns to options
- **Skip**: Separate control below options; not an ordinary option
- **Cancellation**: Escape from the options view cancels the interaction
- **Nested Escape**: First Escape exits text editing, second Escape cancels the interaction

**Batch Questions:**

Interactive terminal UI with tabbed/stepper navigation:

- **Tab layout** (≤ 6 questions): Horizontal tabs with status icons (● answered, ○ unanswered)
- **Stepper layout** (> 6 questions): Compact stepper bar with labels
- **Number keys**: Press 1–9 to select an option by number
- **s/S key**: Skip the current question
- **Tab/Shift+Tab or Arrow Left/Right**: Navigate between questions
- **Space**: Submit multi-select selections
- **Enter**: Submit when all questions are answered or skipped
- **Escape**: Cancel the entire batch (discards all draft answers)
- **Draft preservation**: Answers are stored while navigating; revisit any question to change your answer

### RPC Mode

Uses native dialog adapters:

- Free-text → `ctx.ui.input()`
- Single-select → `ctx.ui.select()` with option labels
- Multi-select → Sequential `ctx.ui.confirm()` per option
- Skip → Explicit "Skip" option in select dialogs or first confirm prompt in multi-select

### JSON/Print Modes

Both tools return `unavailable` immediately without waiting for input.

## Serialization

All Question interactions (single and batch) are serialized through a shared lock. If a Question interaction is already in progress, a second invocation throws an error rather than competing for the UI.

## Validation

The tool rejects invalid input as a tool error (not as cancellation or unavailable):

- Empty or missing question `id`
- Empty or missing question `text`
- `mode: "multi-select"` without options
- `mode: "single-select"` without options
- Options with empty labels
- Duplicate option labels (case-insensitive)
- Duplicate option values (case-insensitive, including derived values)

## Statelessness

The extension is stateless. It does not:

- Persist draft answers
- Own session state
- Track question rounds or decisions
- Detect skill names
- Modify packaged skills

**Workflow state remains owned by the calling skill.** The calling workflow (grilling, wayfinder, etc.) owns all question round state, decisions, and documentation. The extension only facilitates transient UI exchanges.

## Tool Metadata

The tools provide generic guidance through `promptSnippet` and `promptGuidelines`:

- When to use `ask_user_question` / `ask_user_questions` (structured user input)
- When not to use them (skill-internal workflow questions)
- How to use options for select/multi-select modes

The extension does not reference grilling, wayfinder, or any specific skill name. It is designed to be reusable by any skill author.

## Integration Guide

To use this extension in a new skill:

1. The tools `ask_user_question` and `ask_user_questions` are auto-registered.
2. Import shared types from the extension for type-safe results.
3. All results follow the same contract: `status`, `answers`, and `question`/`questions`.
4. Handle `cancelled` and `unavailable` outcomes gracefully — they are valid terminal states.
5. `skipped` answers within a batch do not cancel the batch; only explicit Escape cancels.

## Testing

Run tests from the extension directory:

```bash
cd ~/.pi/agent/extensions/question
npm test
```

Tests cover the shared interaction boundary: mode inference, normalization, validation, answer construction, result formatting, and RPC adapter runtime parity. They do not test TUI rendering or private component state.

## File Structure

```
question/
├── index.ts              # Extension entry point, tool registration, type exports
├── types.ts              # Shared type contracts
├── interaction.ts        # Mode inference, normalization, validation, batch validation
├── question-tui.ts       # TUI component for single-question interactive mode
├── batch-tui.ts          # TUI component for batch-question interactive mode
├── rpc-adapter.ts        # RPC adapter using native dialogs
├── interaction.test.ts   # Tests at the interaction boundary
├── rpc-adapter.test.ts   # Tests for RPC adapter runtime parity
├── package.json          # Dev dependencies (vitest)
└── README.md             # This file
```
