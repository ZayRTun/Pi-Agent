# Subagent extension

This extension discovers Markdown agents from `~/.pi/agent/agents/` and, when enabled, the nearest project `.pi/agents/` directory.

## Agent contract

Each agent file needs YAML frontmatter with `name` and `description`. Optional fields are:

- `tools` — a comma-separated list or YAML array. An explicit list is a strict Pi tool allowlist; malformed values cause that agent to be skipped.
- `model` — an optional `provider/model` override.
- `allowSubagents` — defaults to `false`. Set it only for a deliberate orchestrator; ordinary leaf agents cannot recursively call `subagent`.

The prompt body is appended to Pi's normal system prompt. Keep it focused on the agent's role, process, and handoff format. Tasks are intentionally not copied from the parent session, so callers must pass the spec, ticket, fixed point, artifact path, or other necessary context explicitly.

## Workflow roles

- `scout` — read-only repository reconnaissance for `/to-spec`, `/to-tickets`, and implementation planning.
- `researcher` — primary-source AFK research; writes one Markdown artifact only when the task requests one, then returns its exact path and citations.
- `reviewer` — read-only evidence-based diff review, with Standards and Spec axes kept separate for `/code-review`.
- `worker` — scoped implementation with test and commit/review handoff details for `/implement`.

Use `parallel` for independent reconnaissance or review axes. Use `chain` only when the next task needs the previous agent's concise output; chain context is capped before it is inserted into the next task.

## Safety behavior

Project-local agents require an already trusted project or interactive approval. Headless runs fail closed. On POSIX, child processes are terminated as a process group on cancellation (Windows uses the direct child process), and nested subagent calls are disabled by default.
