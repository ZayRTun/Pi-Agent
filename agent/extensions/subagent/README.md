# Subagent extension

This extension discovers Markdown agents from `~/.pi/agent/agents/` and, when enabled, the nearest project `.pi/agents/` directory.

## Agent contract

Each agent file needs YAML frontmatter with `name` and `description`. Optional fields are:

- `tools` — a comma-separated list or YAML array. An explicit list is a strict Pi tool allowlist; malformed values cause that agent to be skipped.
- `model` — an optional `provider/model` override.
- `thinking` — an optional level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Unrecognized values warn and are treated as absent.
- `allowSubagents` — defaults to `false`. Set it only for a deliberate orchestrator; ordinary leaf agents cannot recursively call `subagent`.
- `timeoutMinutes` — an optional per-agent timeout in minutes (clamped to 1–480, default 30). A call-level `timeoutMinutes` overrides it.

`model` and `thinking` are independent: each is used when declared and inherited from the invoking session otherwise, so declaring a model does not change the thinking level.

Tasks are sent to the child over stdin (never argv: no OS size limit, nothing visible in `ps`). Each delegation gets one temp dir holding the prompt/task files; the dir is deleted when the delegation finishes, and anything missed is reclaimed by the OS temp sweeper. Every delegation has a timeout (call-level `timeoutMinutes`, else the agent's `timeoutMinutes`, else 30 minutes); on timeout the child is sent SIGTERM, then SIGKILL after 5s, and the result reports `timed out after N minutes`. A parallel result with 0/N successes returns `isError: true`; partial successes still return success so the parent can use them.

The prompt body is appended to Pi's normal system prompt. Keep it focused on the agent's role, process, and handoff format. Tasks are intentionally not copied from the parent session, so callers must pass the spec, ticket, fixed point, artifact path, or other necessary context explicitly.

## Workflow roles

- `scout` — read-only repository reconnaissance for `/to-spec`, `/to-tickets`, and implementation planning.
- `researcher` — primary-source AFK research; writes one Markdown artifact only when the task requests one, then returns its exact path and citations.
- `reviewer` — read-only evidence-based diff review, with Standards and Spec axes kept separate for `/code-review`.
- `worker` — scoped implementation with test and commit/review handoff details for `/implement`.

Use `parallel` for independent reconnaissance or review axes. Use `chain` only when the next task needs the previous agent's concise output; chain context is capped before it is inserted into the next task.

Chain context is passed through the `{previous}` placeholder. The inserted text is labelled — `[Output from step N (agent), B bytes]: ...` — so the next agent can see where your instructions end and the prior output begins; a `, truncated to fit the chain context cap` note marks cut-off output. If a step after the first has no `{previous}`, the chain result carries a `[Chain warnings]` note naming the step and the dropped byte count (no warning when the prior output was empty, and no failure: some chains are just "do A, then do B"). Ask step 1 for machine-readable output (a full path, not a bare filename) and tell later steps to stop rather than guess when the context is ambiguous.

## Safety behavior

Project-local agents require an already trusted project or interactive approval. Headless runs fail closed. On POSIX, child processes are terminated as a process group on cancellation (Windows uses the direct child process), and nested subagent calls are disabled by default.
