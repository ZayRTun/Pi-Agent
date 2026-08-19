# Question Interaction Extension

A stateless Pi extension that provides structured user input collection through the `ask_user_question` tool.

## Installation

The extension lives at `~/.pi/agent/extensions/question/` and is auto-discovered by Pi.

## Tools

### `ask_user_question`

Ask the user one question and collect their answer. Supports four input modes:

| Mode | When to use | Options required |
|------|-------------|-----------------|
| **free-text** | Short clarifications, names, descriptions | No |
| **single-select** | Choose one option from a list | Yes |
| **multi-select** | Choose several options from a list | Yes + `mode: "multi-select"` |
| **custom "Other"** | Option-based question with a free-text escape hatch | Yes + `allowOther: true` (default for select modes) |

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | ✅ | Unique identifier for this question |
| `text` | string | ✅ | The question text displayed to the user |
| `label` | string | ❌ | Short navigation label (defaults to truncated text) |
| `mode` | string | ❌ | Input mode: `"text"`, `"single-select"`, or `"multi-select"`. Inferred from options when omitted. |
| `options` | array | ❌ | Available options. Each has `label` (required) and `value` (optional, derived from label). |
| `allowOther` | boolean | ❌ | Allow custom "Other" text input. Default: `false` for text, `true` for select modes. |

### Mode Inference

When `mode` is omitted, it is inferred from `options`:

- **No options** → `"text"` (free-text input)
- **Options present** → `"single-select"`
- **Options present + `mode: "multi-select"`** → `"multi-select"`
- **`mode: "multi-select"` without options** → Error (invalid)

### Result Contract

The tool returns a structured result:

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

### Outcome Types

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

Interactive terminal UI with:

- **Free-text**: Text input with Enter to submit
- **Single-select**: Arrow key navigation, Enter to select
- **Multi-select**: Arrow keys + Space to toggle, Enter to confirm all selections
- **"Other" option**: Opens inline text editor; Escape returns to options
- **Skip**: Separate control below options; not an ordinary option
- **Cancellation**: Escape from the options view cancels the interaction
- **Nested Escape**: First Escape exits text editing, second Escape cancels the interaction

### RPC Mode

Uses native dialog adapters:

- Free-text → `ctx.ui.input()`
- Single-select → `ctx.ui.select()` with option labels
- Multi-select → Sequential `ctx.ui.confirm()` per option
- Skip → Explicit "Skip" option in select dialogs

### JSON/Print Modes

Returns `unavailable` immediately without waiting for input.

## Serialization

All Question interactions are serialized through a shared lock. If a Question interaction is already in progress, a second invocation throws an error rather than competing for the UI.

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

Calling workflows (grilling, wayfinder, etc.) own all question round state, decisions, and documentation.

## Tool Metadata

The tool provides generic guidance through `promptSnippet` and `promptGuidelines`:

- When to use `ask_user_question` (structured user input)
- When not to use it (skill-internal workflow questions)
- How to use options for select/multi-select modes

The extension does not reference grilling, wayfinder, or any specific skill name.

## Testing

Run tests from the extension directory:

```bash
cd ~/.pi/agent/extensions/question
npm test
```

Tests cover the shared interaction boundary: mode inference, normalization, validation, answer construction, and result formatting. They do not test TUI rendering or private component state.

## File Structure

```
question/
├── index.ts          # Extension entry point, tool registration
├── types.ts          # Shared type contracts
├── interaction.ts    # Mode inference, normalization, validation
├── question-tui.ts   # TUI component for interactive mode
├── rpc-adapter.ts    # RPC adapter using native dialogs
├── interaction.test.ts  # Tests at the interaction boundary
├── package.json      # Dev dependencies (vitest)
└── README.md         # This file
```
