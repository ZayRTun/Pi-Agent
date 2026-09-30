# Using TypeSafe Jev to make this Pi agent more efficient

**Status:** Decision-ready research and design report. No code changed.
**Date:** 2026-02 (working session)
**Scope:** `/Users/zayar/.pi` (agent config, extensions, local packages) plus the installed Pi core and official TypeSafe documentation.

**Evidence labels used throughout:**

- **[V]** Verified fact — read directly from a cited file, package, or official doc.
- **[I]** Inference — reasoned from verified facts about this implementation; not yet measured.
- **[P]** Proposed design — requires validation before any production use.

---

## 1. Executive verdict

**Jev can plausibly improve this Pi agent, but not through the integration that exists today, and not by much until instrumentation proves where the waste is.**

The strongest evidence, in order:

1. **The waste taxonomy in this repo is currently unmeasured.** Pi records rich per-message token/cost data in session files [V], but there is no tool-call-level telemetry, no loop detection, and no repetition detection anywhere in Pi core or the local extensions [V]. We cannot yet say how often loops, premature completion, or redundant reconnaissance actually occur. Any Jev design built before that baseline exists would be tuned against guesses.

2. **The highest-value Jev uses are *extension-side*, not tool-side.** The current integration exposes `typesafe_evaluate` as an agent-callable tool [V]. That path spends main-model tokens to *decide to ask* Jev, then spends more tokens reading the answer — it can easily be net-negative. The designs that save tokens are ones where deterministic extension code calls Jev at lifecycle hooks (`tool_call`, `tool_result`, `agent_end`) and the judgment either (a) blocks an action with a short injected reason, or (b) runs in shadow mode and never enters the model's context at all.

3. **The best-grounded external evidence is the skill-suggestion shape.** The official cookbook shows one batched Jev request cutting an agent's wrong tool-selection rate 2.3× and needless loads 2.4× (16.8%→7.3% and 9.8%→4.0%) [V — docs.typesafe.ai cookbooks/skill_suggestion]. The direct analogues here are sub-agent selection, issue triage, and skill routing — all bounded Choice problems.

4. **Jev is cheap per call but not free in aggregate.** $0.042 per million input tokens, output free [V — docs.typesafe.ai/models]. A 500-token judgment costs ~$0.00002 — negligible per call. But a guard that fires on every tool call in a 300-tool-call run is 300 network hops, ~0.25 s each, plus a **hard 20-attempts-per-client-instance cap** in the installed pi-typesafe 0.6.1 [V — dist/client.js]. Any serious integration needs its own client instance with explicit budgets, or it will silently stop judging mid-run.

**Recommendation:** Do not deploy Jev into the agent loop yet. Run (1) a small instrumentation extension to establish the waste baseline, then (2) shadow-mode evaluations of the three experiments in §7, then (3) at most one production experiment — the loop/stall guard — behind explicit opt-in.

---

## 2. Current-state architecture

### 2.1 This repo (`/Users/zayar/.pi`)

| Component | Path | Role |
|---|---|---|
| Root guidance | `AGENTS.md` | Points at issue tracker (`ZayRTun/Pi-Agent` via `gh`), triage labels, domain docs [V] |
| Glossary | `CONTEXT.md` | Canonical vocabulary for questioning, **Sub-agent**, **Delegation**, Run States (Running/Succeeded/Failed/Aborted) [V] |
| ADR | `docs/adr/0001-stateless-question-interaction-boundary.md` | Question interactions stay stateless; **callers own workflow state** [V]. Any Jev-driven workflow must respect this: Jev judgments are inputs to a caller's policy, never a stateful interviewer. |
| Issue tracker | `docs/agents/issue-tracker.md` | GitHub issues as spec surface; triage labels `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`; wayfinder map + child tickets with `Blocked by:` parsing [V] |
| Sub-agent extension | `agent/extensions/subagent/` (`index.ts` 1595 lines, `agents.ts`) | Discovers Markdown agents; single/parallel/chain Delegation; usage aggregation; timeouts; chain-context cap with truncation notice [V — see README and code] |
| Agents | `agent/agents/{scout,researcher,reviewer,worker}.md` | Four workflow roles with strict tool allowlists; model/thinking inherited unless declared; `allowSubagents` defaults false [V] |
| Other extensions | `auto-session-name.ts` (`input` event, session naming), `custom-header.ts` (`session_start`, TUI component), `opencode-attention/` (sound on stop/error) [V] |
| Settings | `agent/settings.json` | Default model `commandcode/z-ai/glm-5.3-flash`, thinking `high`, compaction enabled [V] |

### 2.2 Pi core lifecycle (installed at `~/.nvm/.../@earendil-works/pi-coding-agent`)

Verified against installed docs and compiled sources [V]:

- **Turn loop** (`pi-agent-core/dist/agent-loop.js:77`, `runLoop`): prepare next turn (compaction can run here) → poll steering → diff tool loadout (`toolsAdded`/`toolsRemoved`) → one LLM call → execute tool calls (parallel preflight, concurrent execution) → repeat until no tool calls and no follow-ups. A tool batch with `terminate` ends the loop.
- **Extension hooks relevant to Jev placement** (`docs/extensions.md`):
  - `tool_call` — **can block** (`{ block: true, reason?, terminate? }`) and **mutates `event.input`** before execution.
  - `tool_result` — can rewrite the result before it enters context.
  - `before_agent_start` — can set `systemPromptOptions.selectedTools` (per-run tool loadout).
  - `context` — can rewrite the message list before each LLM call.
  - `agent_end` / `turn_end` — fired at completion boundaries.
  - `session_before_compact` / `session_compact` — compaction interception.
- **Compaction** (`docs/compaction.md`): triggers when `contextTokens > contextWindow − reserveTokens` (default 16384); keeps `keepRecentTokens` (default 20000) verbatim; the summary is an **LLM call whose usage is counted in session totals**.
- **Token accounting** (`docs/session-format.md`): per-assistant-message `usage` with input/output/cacheRead/cacheWrite/reasoning/totalTokens and per-component cost; `ToolResultMessage.usage` records nested LLM work (e.g. a tool that runs its own model); `usage` entries with a `kind` (e.g. cache warm) for non-context spend; compaction usage included in totals.
- **Loop/progress safeguards: none.** No max-turn counter, no repetition detection, no progress heuristic in `runLoop` [V — direct code read]. The only automatic stops are provider-retry limits (default 3 retries, backoff), user abort, `stopReason: "length"`, and a `terminate` tool batch.

### 2.3 Sub-agent mechanics

[V — `agent/extensions/subagent/index.ts` and its README]

- Tasks are sent over stdin; **task text is not copied from the parent session** — the caller must pass all needed context. This is already a strong anti-token-leak design.
- Chain mode caps the `{previous}` context; overflow is truncated and flagged (`[Output from step N (agent), B bytes]`, `, truncated to fit the chain context cap`).
- Per-task output cap truncates results into the parent context.
- Usage is aggregated per task and per run (input/output/cache/tokens/cost) and rendered; subagent runs land in `run-history.jsonl`.
- Parallel results with 0/N successes return `isError`; the parent decides what to do — there is no automatic retry or re-delegation.

### 2.4 Existing TypeSafe integration

[V — `agent/npm/node_modules/pi-typesafe` @ 0.6.1, `@typesafe-ai/sdk` @ 0.6.0]

- `pi-typesafe` 0.6.1 (installed 2025-09 per `package.json`; depends on `@typesafe-ai/sdk ^0.6.0`). **Current as of writing** — but it is a fast-moving independent package; re-verify before building.
- Registers the `typesafe_evaluate` tool at session start; **disabled until `/typesafe enable`** (or `PI_TYPESAFE_ENABLED=1`) [V — README, dist/extension.js:64-108].
- Per-request limits: 32 questions, 64 KiB JSON, 15 s timeout, no automatic retries [V — dist/schema.js, dist/client.js].
- **Per-session cap: 20 attempts per client instance; the client is reset on every `session_start`** [V — dist/client.js:20, dist/extension.js:37-45]. Daily caps via `PI_TYPESAFE_MAX_REQUESTS_PER_DAY` / `MAX_INPUT_TOKENS_PER_DAY` / `MAX_USD_PER_DAY`; a reached cap raises a `budget` error *before* submission.
- API surface beyond the tool: `ask`, `evaluateAll` (one state, unlimited questions, chunked fan-out), `evaluateMany` (many states, bounded concurrency, never throws), auth state reporting (`authState`/`describeAuth` — an enabled-but-keyless install looks identical to a working one), a persisted usage ledger, and **`pi-typesafe/calibrate`** — a labelled-case tuning kit (AUC, threshold sweep, precision/recall floors, missed/flagged listings) [V — dist/index.d.ts, dist/calibrate.d.ts]. The calibrate module is directly reusable for the evaluation plan in §8.
- Key stored at `agent/pi-typesafe/auth.json` (owner-only); usage ledger at `agent/pi-typesafe/usage.json`. In this environment `PI_TYPESAFE_ENABLED` is unset and the tool is available in-session (enabled interactively) [V].
- What is sent to TypeSafe: **only the `state` and `questions` the caller submits**, to `api.typesafe.ai` only; Jev is not trained on customer requests; enterprise ZDR available [V — package README, docs.typesafe.ai/models].

### 2.5 Jev facts that constrain every design below

[V — docs.typesafe.ai: /models, /api, /confidence, /model-jaggedness/jev-1.13, /cookbooks/skill_suggestion]

- Model `jev-1.13.0` (alias `jev-latest`); $42 per billion input tokens ($0.042/Mtok); **output tokens free**; 250k tok/s and 1200 req/min rate limits; 64k-token request budget, of which `state` + longest question ≤ 32k.
- Answers are typed: Noul (P(yes), no confidence field), Choice (option + full probability distribution + confidence), Score (position on ordered levels + distribution + confidence). Confidence is derived from distribution shape; "I don't know" is expressed as low confidence, and the three-range pattern (act / proceed-with-caution / do-not-act) is the documented default.
- Batching: all questions in one request run in parallel against one copy of `state`; the parallel-questions cookbook measures batching as **12.2× cheaper and 10.0× faster** than separate calls with unchanged answers.
- Known jaggedness of jev-1.13: literal reading of instructions; unreliable counting and numeric/date math (do it in code); accuracy degrades with large irrelevant state ("context rot"); susceptible to adversarial content in state; **no structural invariants** (a Noul and its negation may not sum to 1; a Noul threshold does not transfer to a Choice); not a text generator.
- The skill-suggestion cookbook result (2.3×/2.4× fewer wrong/needless selections on a 182-skill roster, 488 requests) is the closest published analogue to agent routing decisions.

---

## 3. Token-waste and decision-failure taxonomy

Grounded in the architecture above. Frequencies are **unmeasured** — that is the point of §9 step 1.

| # | Failure mode | Where it can happen in Pi today | Evidence status |
|---|---|---|---|
| W1 | **Repeating substantially equivalent tool calls** (same command, same read, same search) | Nothing detects it: no repetition check in `runLoop`, no `tool_call` middleware installed [V] | Mechanism verified possible; frequency unmeasured [I] |
| W2 | **Re-reading unchanged files** | `read` has no memoization; a fresh read after any edit cycle re-enters full file text | [I] |
| W3 | **Repeated failures with the same strategy** (rerunning a failing test/build unchanged) | No failed-attempt memory; provider retry logic covers transport errors only, not behavioral loops [V] | [I] |
| W4 | **Excessive reconnaissance** (broad greps, dumping large files, reading the whole repo "to be safe") | Scout/worker prompts already instruct targeted reads [V], but enforcement is prompt-only | [I] |
| W5 | **Continuing after the task is complete** (failure to stop; "one more check" loops) | No completion gate; loop ends only when the model stops emitting tool calls [V] | [I] |
| W6 | **Premature completion** (claims done without verification) | No evidence check at `agent_end`; worker prompt *asks* for verification but nothing enforces it [V] | [I] |
| W7 | **Wrong tool / wrong sub-agent selection** (delegating to researcher what scout should do; using web_search for a local fact) | Selection is prompt-driven from tool descriptions and agent descriptions; no router | [I]; published analogue exists [V — skill_suggestion] |
| W8 | **Unnecessary Delegation** (main session could do it in one call; sub-agent spins up a full session) | Delegation is always the model's choice; sub-agent sessions have their own full system prompt + orientation cost | [I] |
| W9 | **Poorly supported decisions** (conclusions without citations, completion without test evidence) | Reviewer prompt requires evidence [V]; nothing checks other agents' claims | [I] |
| W10 | **Irrelevant context entering the model** (oversized tool results, search dumps) | Sub-agent outputs are capped [V]; built-in tool results are not filtered; `context` event could filter but nothing does | [I] |
| W11 | **Compaction churn** (summarizing content that was never needed, or paying summary tokens repeatedly) | Compaction is threshold-triggered with an LLM summary whose usage counts [V] | Mechanism verified; frequency depends on W10 |
| W12 | **A small semantic question costing a full reasoning turn** ("is this file relevant? let me read it and think…") | The only in-context judgment path today is the model itself, or the `typesafe_evaluate` tool — which still costs main-model tokens to invoke and read | [V — tool exists]; frequency [I] |

**Minimum instrumentation to establish a baseline** (needed before any Jev tuning):

1. A `tool_call`/`tool_execution_end` logger extension recording per call: session id, turn index, tool name, normalized-argument hash, result-size class, outcome (ok/error/blocked), duration, and the assistant message id. This makes W1/W3/W4 measurable by hash-repetition analysis.
2. Per-run rollups (extend what `run-history.jsonl` already does — it currently records only agent/status/duration with **no tokens or cost** [V]) adding input/output/cache tokens, cost, turns, and tool-call count from the aggregated usage the subagent extension already computes [V].
3. A labelling pass: sample ~30 finished sessions, hand-label occurrences of W1–W10. This yields the labelled dataset the calibrate kit needs (`ScoredSample { label, score, id }` [V — dist/calibrate.d.ts]).

---

## 4. Opportunity analysis

Each candidate: current failure mode → Jev decision → state → primitive → policy → economics. "In-context" = the judgment's outcome reaches the model's context (costs output tokens next turn + input tokens thereafter); "extension-side" = it never does.

### O1. Loop / stall guard (W1, W3)

- **Where:** `tool_call` event in a new extension; deterministic fingerprinting first, Jev only on the ambiguous case.
- **Deterministic layer (no Jev):** normalize tool name + arguments → hash; keep a ring buffer per session. An *exact* repeat of a call that returned an identical result is detectable in code. Counting, hashing, mtime comparison are exactly what Jev must not do [V — jaggedness: counting, math].
- **Jev's bounded decision:** after the deterministic layer flags a *near*-repeat (same tool, similar args, previous attempt errored or produced no state change): *"Attempt N of this action produced outcome X. Does the current attempt differ in a way likely to produce a different outcome — different arguments, different inputs, or an intervening state change — or is it repeating the same approach?"* → Noul (or 3-level Score: same-approach / refined-approach / new-strategy).
- **State sent:** tool name, previous 2 attempts' normalized args and result summaries (error class only), current args. Bounded to a few hundred tokens. No file contents, no code.
- **Policy (deterministic):** P(same-approach) ≥ 0.7 → block the call with reason `"Previous attempt with essentially the same approach failed; change strategy or report the blocker"` (the `tool_call` block path turns this into an error tool result the model must react to — no extra injected prose). 0.4–0.7 → allow but increment a counter; ≥3 medium-confidence repeats → block and suggest asking the user. < 0.4 → allow.
- **Confidence handling:** low-confidence Noul defaults to *allow* (fail-open: blocking a legitimate retry is worse than one redundant call).
- **Token-saving mechanism:** converts would-be loop turns (each re-reading large context at cache prices) into one short error result. A single prevented loop iteration saves a full main-model turn.
- **Cost added:** 1 Jev request per flagged near-repeat only (deterministic gate keeps this rare — expected a handful per problematic run, 0 in clean runs). Latency ~0.25–1 s at the moment of blocking only.
- **FP/FN:** FP (blocking a legitimate retry) — annoying but recoverable; the block reason tells the model to vary the approach. FN (allowing a loop) — status quo. Fail-open bias is deliberate.
- **Caching:** identical (tool, args-hash, prev-result-hash) tuples → cache the judgment for the session.
- **Privacy:** only tool names, argument hashes/shapes, and error classes leave the machine; not code content. Low risk.

### O2. Completion-evidence check (W6, partly W5)

- **Where:** `agent_end` (or the last `turn_end` before a no-tool-call response), fired only when a deterministic trigger says a completion claim occurred (regex over the final assistant text for task-completion language, or "session had ≥ N tool calls and ends with a summary").
- **Jev's bounded decision:** *"Does the session evidence support the claim that the requested task is complete — i.e., do the recorded verification results (tests run, commands executed, files changed) cover the stated acceptance criteria?"* → Noul, plus a second independent Noul: *"Does the evidence include at least one executed verification (test/build/lint) relevant to the changed code?"*
- **State sent:** the opening request (truncated), the final assistant summary, and a deterministic extraction of verification signals: tool-call names/exit codes for bash/test-like tools, list of edited files. Not the full transcript.
- **Primitive:** two Nouls in one batched request (independent dimensions — coverage and verification presence).
- **Policy:** both high (≥ 0.75) → nothing happens. Low on verification-presence → append one steering message: `"Verification evidence is missing or weak; run the relevant checks before reporting completion."` Low on coverage → steering message naming the uncovered criteria. **Shadow mode first** (§8): log the judgment, change nothing.
- **What it prevents:** W6 (premature completion). The follow-up turn it triggers is *purchased deliberately* — it should fire only on genuinely weak completions, or it becomes a token sink. This is why the deterministic trigger and a high threshold matter.
- **Cost added:** ≤ 1 request per session end; ~400–800 input tokens; latency hidden at session end.
- **FP/FN:** FP → one extra verification turn (annoying, bounded); FN → premature completion ships (status quo). Prefer recall here; a false alarm costs one turn, a missed false-"done" costs user trust.
- **Caching:** no — state is unique per session end.
- **Caveat:** Jev judging "does evidence support X" is a semantic check over a structured summary, which is in its wheelhouse (citation-check pattern [V — cookbooks/citation_check]); it is **not** checking code correctness, which stays with tests and the model.

### O3. Batched issue triage and ticket routing (W7, W12 — repo workflow, not the agent loop)

- **Where:** `gh`-based triage and wayfinder flows (`docs/agents/issue-tracker.md` [V]). Today an agent triaging N issues reads each into its own context (N × issue text × reasoning tokens) or delegates to a sub-agent that does the same.
- **Jev's bounded decision:** per issue in **one batched request** (`evaluateAll`): Choice over the five triage labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix` — a closed set that exactly fits Choice [V — triage-labels]); Noul `is_duplicate_of_existing` (with candidate titles in state); Noul `is_blocked` (supplementing the deterministic `Blocked by:` line parse, which stays in code [V]).
- **State:** issue title + body (truncated to ~1–2 k tokens each; Jev's 32k state budget and context-rot warning [V] cap how many issues fit per request — chunk in code).
- **Policy:** Jev output is a *pre-classification*, shown to the agent (or the human) as a shortlist with probabilities; the agent confirms borderline cases by reading only the flagged issues. High-confidence `ready-for-agent` issues skip full reads entirely.
- **Token-saving mechanism:** N issues classified for ~1–2 k tokens of Jev input each instead of N main-model turns each carrying the issue text plus reasoning; the model reads only the issues it must. This is the documented rerank/classify pattern [V — cookbooks/rerank_typesafe, classifying_rag_passages].
- **Eval-friendliness:** the best-labelled dataset available — triage labels already exist on real issues, and misclassification is caught at human review. Ideal first production use.
- **Privacy:** issue text goes to TypeSafe; this repo's issues are a public GitHub tracker (`ZayRTun/Pi-Agent`) [V], so exposure is low, but the data-notice behavior of `/typesafe enable` should still govern it.

### O4. Sub-agent selection and delegation gating (W7, W8)

- **Where:** at `tool_call` for the `subagent` tool (the extension can inspect and block/annotate the call [V — tool_call semantics]).
- **Jev's bounded decision:** Choice over the four declared agents (`scout`, `researcher`, `reviewer`, `worker`) + `none — do it in the main session`; state = the delegation task text + one-line agent descriptions.
- **Policy:** if the chosen agent disagrees with Jev's top pick *and* Jev confidence is high → allow but note the mismatch in the returned result header (advisory, shadow-style). If Jev picks `none` with high confidence → advisory note that main-session handling may be cheaper. Never block in v1.
- **Evidence basis:** the skill-suggestion result (2.3×/2.4× error reduction on a large roster) [V]; with a roster of four, expected gains are smaller but the delegation-or-not question (W8) is real.
- **Cost:** one Jev call per delegation attempt (delegations are already expensive operations, so the relative overhead is small).
- **Caution:** the skill cookbook also measured that a wrong suggestion is *worse* than none (it broke 7 requests the agent had right [V]) — hence advisory-only.

### O5. Failed-strategy steering at the sub-agent boundary (W3, W8)

- **Where:** the parent session after a Delegation returns Failed, or after 2+ Failed delegations of similar tasks.
- **Jev's bounded decision:** Noul — *"Are the two failed delegation tasks attempts at essentially the same approach?"* (state: both task texts, truncated).
- **Policy:** yes + high confidence → the parent is told (one line) to change strategy or consult the user instead of re-delegating. Deterministic fallback without Jev: two failures with hash-similar task text already triggers a warning.
- **Cost:** one small request per failed-delegation pair; rare.
- **Simpler sibling worth doing first:** the deterministic layer alone (task-text similarity via hash/shingles) may capture most of the value with zero Jev cost. Validate before adding the model.

### O6. Tool-result relevance filtering (W10)

- **Where:** `tool_result` middleware for search/fetch-type tools.
- **Jev decision:** Noul per result chunk — *"Does this result relate to the query/intent that motivated the call?"* → keep/drop/flag.
- **Why it is tempting and why it is ranked low:** context rot works in Jev's favor here (send only the question + chunk [V]), and the rerank cookbook shows real gains. But in Pi, tool results enter the prompt once and are then **cache-read** on subsequent turns [V — usage fields], so the marginal cost of keeping a mediocre result is cache-price input, not full price; and dropping a needed result can cost a full re-search turn. Net benefit is uncertain and the FP cost is high. Shadow-evaluate only.

### O7. Next-action / continue-vs-stop routing at step boundaries (wayfinder, AFK runs)

- **Jev decision:** Choice over {continue, delegate, ask-user, stop} given task state.
- **Why rejected as a router:** this is the workflow's core control decision — multi-step reasoning over goals, fog, and risk. The user's brief explicitly forbids delegating open-ended planning to Jev, and the jaggedness doc warns against indirection-heavy questions [V]. Only narrow sub-judgments (e.g., O2's completion check, O5's same-strategy check) are appropriate inside that larger process.

### O8. "Should I run tests now?" / verification timing

- **Rejected:** deterministic policy dominates — run focused tests after edits, full suite before finish (the worker prompt already encodes this [V]). A model judgment here duplicates a rule and adds latency. Per the brief: known rules stay in code.

### O9. Compaction content selection (W11)

- **Where:** `session_before_compact`.
- **Why rejected for now:** compaction already keeps recent tokens verbatim and cuts at valid points [V]; Jev scoring older entries for importance would require sending large entry text as state (the exact "large state full of irrelevant detail" failure mode [V]) and its output would shape a summary written by another model — an unverifiable benefit chain. Revisit only if telemetry shows compaction churn (W11) is frequent and summary quality measurably poor.

### O10. Thinking-level / model escalation decisions

- **Rejected:** escalation criteria (session type, task declaration, user flags) are knowable deterministically or belong to the user; a probabilistic gate on an expensive-model switch creates exactly the "unsafe confidence in an uncertain judgment" the brief warns about. The status quo (declared/inherited model per Agent definition [V — CONTEXT.md]) is explicit and auditable.

---

## 5. Prioritization rubric and opportunity matrix

Rubric (1–5 unless noted): **Freq** = expected frequency in real runs; **Save** = expected main-model tokens avoided; **Loops** = reduction in loops/failed turns; **Quality** = decision-quality gain; **Integ** = ease of integration into existing hooks; **Labels** = ease of collecting labelled eval cases; **Risk** = consequence of a wrong judgment (5 = mild); **Jev cost** = input tokens + latency added (5 = negligible); **Obs** = observability/debuggability of the decision.

| Opportunity | Freq | Save | Loops | Quality | Integ | Labels | Risk | Jev cost | Obs | Total /40 |
|---|---|---|---|---|---|---|---|---|---|---|
| O1 Loop/stall guard | 4 | 5 | 5 | 3 | 4 | 4 | 3 | 5 | 4 | **37** |
| O2 Completion-evidence check | 4 | 4 | 3 | 4 | 4 | 3 | 4 | 5 | 4 | **35** |
| O3 Issue triage / routing | 3 | 4 | 2 | 4 | 5 | 5 | 4 | 5 | 5 | **37** |
| O4 Sub-agent selection | 3 | 3 | 2 | 3 | 4 | 3 | 4 | 5 | 4 | 31 |
| O5 Failed-strategy steering | 2 | 3 | 4 | 3 | 4 | 3 | 4 | 5 | 4 | 32 |
| O6 Tool-result filtering | 4 | 3 | 1 | 3 | 3 | 2 | 2 | 3 | 3 | 24 |
| O7 Continue/stop router | 3 | 3 | 3 | 2 | 2 | 1 | 1 | 4 | 2 | 21 |
| O8 Test-timing | 3 | 1 | 1 | 2 | 5 | 2 | 4 | 5 | 3 | 26 |
| O9 Compaction selection | 2 | 2 | 1 | 2 | 3 | 1 | 2 | 2 | 2 | 17 |
| O10 Escalation gating | 2 | 2 | 1 | 2 | 3 | 1 | 1 | 4 | 2 | 18 |

**(O1, O3, O2)** lead; O5 is the best "determinism-first" candidate. O6–O10 rejected or deferred (§6).

---

## 6. Rejected-use-case list

| Rejected use | Why it should not use Jev |
|---|---|
| Permission / safety enforcement on tool calls | Explicitly deterministic: allowlists, trust gates, and the `tool_call` block path are code paths with audit needs [V]. A probabilistic allow is unsafe confidence. |
| Exact parsing, lookup, counting, hashing, mtime checks, `Blocked by:` line parsing | Code does it exactly; Jev is documented-unreliable at counting/numbers/dates [V — jaggedness]. |
| Workflow state ownership (question rounds, delegation run states, wayfinder map state) | ADR 0001 keeps interactions stateless with callers owning state [V]; Jev is a judgment function, not a state machine. |
| Retry and spending limits | Already implemented deterministically in pi-typesafe (caps, ledger, budget errors) [V]; duplicating with judgments would add nondeterminism to a safety mechanism. |
| Open-ended planning, debugging, multi-step reasoning | System Two work [V — jaggedness]; Jev degrades with indirection. Only narrow sub-judgments inside these processes qualify (O2, O5). |
| Continue-vs-stop / next-action routing as a router (O7) | The decision needs goals + history + risk; the model or the user owns it. A Jev router would be a second source of loops and its decisions are hard to evaluate objectively. |
| Test-timing decisions (O8) | Duplicates an existing deterministic policy; adds latency per edit with no judgment content. |
| Compaction entry selection (O9) | Sends large low-relevance state to a model with context rot; benefit chain unverifiable; compaction cost is already bounded and counted. |
| Escalation to a reasoning model (O10) | Consequence of a wrong call is expensive and asymmetric; criteria are better expressed as explicit user/project configuration. |
| Generating anything (commit messages, summaries) from Jev | Jev is not a generator; chaining Choices to generate is "very slow" and poor [V — jaggedness]. |
| `typesafe_evaluate` as a general in-context helper for trivial judgments | Each invocation costs main-model output tokens to compose + next-turn input to read; for anything code can compute, the tool path is strictly worse. Reserve it for genuinely semantic, agent-initiated judgments — and consider whether an extension hook is the better delivery path. |

---

## 7. Three recommended experiments

All three share the same shell: a new extension (or a pi-typesafe-consuming extension) with its **own `createTypeSafe` client** (explicit budgets — the shared tool's 20-attempt session cap must not be consumed by infrastructure [V]), `authState()` checked before claiming judgments are active [V — README's keyless-availability warning], and a `/guardian`-style enable command mirroring pi-typesafe's consent pattern.

### Experiment 1 — Loop/stall guard (O1)

- **Trigger:** `tool_call` on `bash`, `read`, `ffgrep`, `web_search`; deterministic near-repeat detection first (normalized-arg hash + prior outcome + state-change check: did any file the command touches change mtime?).
- **State:** `{ tool, attempts: [{argsSummary, outcomeClass}], currentArgsSummary }` — no code content, ≤ ~400 tokens.
- **Questions (one request, batched):**
  - `novel` (Noul): "Does the current attempt differ from the previous failed attempts in arguments, inputs, or an intervening state change, such that a different outcome is plausible?" criteria.true: "material difference present"; criteria.false: "essentially identical approach repeated".
- **Primitive:** Noul. **Policy:** P(same-approach) ≥ 0.7 → block with the reason above; else allow. Counter of medium-confidence repeats → block at 3rd.
- **Insufficient confidence:** allow (fail-open), increment counter.
- **Phases:** (a) deterministic-only guard, no Jev — measure; (b) shadow — Jev judges, logs, nothing blocks; compare against a hand-labelled sample; (c) opt-in enforcement.
- **Calibration:** labelled cases from the telemetry in §3 step 1 + calibrate kit (`auc`, `sweep`, precision/recall floors) [V — pi-typesafe/calibrate]. Do **not** copy thresholds from examples; sweep on Pi traces [per brief].
- **Rollback:** env flag off → extension inert; blocking is per-call and logged.
- **Expected effect:** prevents W1/W3 loops. A single prevented loop iteration saves one full main turn (order 10⁴–10⁵ cache-read tokens + seconds). Jev adds ~10² tokens per flagged event only.
- **Cacheability:** judgments cached by (tool, args-hash, prev-result-hash) per session.

### Experiment 2 — Completion-evidence check (O2)

- **Trigger:** `agent_end` after a session meeting deterministic criteria (≥ 5 tool calls AND final message matches completion-language patterns). Fires at most once per completion claim.
- **State:** `{ request: <opening request, truncated>, summary: <final assistant message>, verification: [{tool, argsSummary, exitCode}], filesChanged: [paths] }` — ≤ ~800 tokens.
- **Questions (one batched request):**
  - `verified` (Noul): "Do the recorded verification results include an executed check (test, build, lint) relevant to the changed files?"
  - `covers` (Noul): "Does the final summary's claim of completion match the recorded evidence for each part of the request?"
- **Primitive:** 2 Nouls. **Policy:** both ≥ 0.75 → nothing. Either low → append one steering message naming the gap (one extra turn, purchased deliberately). 0.5–0.75 → log only (shadow tier).
- **Insufficient confidence:** do not steer; log. Steering on a hunch is how this becomes a token sink.
- **Phases:** shadow first (log disagreement between Jev and actual user corrections over ≥ 20 sessions); then steering; enforcement never blocks completion — it only prompts.
- **Expected effect:** targets W6 (premature completion — the trust-killer) and W5. Main cost is +1 turn on genuinely incomplete work; savings are avoided user-repair cycles.
- **FP/FN:** FP = one wasted verification turn (cheap, visible); FN = premature done (expensive, silent) → bias thresholds toward recall for `verified`.

### Experiment 3 — Batched issue triage (O3)

- **Trigger:** a `/triage` skill/extension step that lists open `needs-triage` issues via `gh`, chunks them, and calls `evaluateAll` once per chunk.
- **State:** `{ issues: [{number, title, body(≤1.5k tokens)}] }` per chunk (respect 32k state budget [V]).
- **Questions per issue (batched in the same request):**
  - `label` (Choice): one of the five triage labels with descriptions from `docs/agents/triage-labels.md` [V], plus criteria text per label.
  - `needs_info` (Noul): "Is the report missing information a maintainer must request?" (independent dimension — per the brief, separate Noul rather than folded into the Choice).
  - `duplicate` (Noul): only when candidate duplicates are deterministically pre-gathered (title similarity in code).
- **Primitive:** Choice + Nouls. **Policy:** high-confidence labels applied as *suggestions* on the issue list; the agent (or human) confirms borderline and low-confidence rows by reading only those. Deterministic post-checks: label set validity, `Blocked by:` parsing stays in code.
- **Insufficient confidence:** route to the main model's normal read-and-decide path for that issue only.
- **Expected effect:** the clearest token arithmetic of the three: triaging 20 issues today costs ~20 main-model turns carrying full issue bodies; with pre-classification the model reads ~3–5. Jev cost: ~20–40 k input tokens ≈ **under $0.002** at $0.042/Mtok [V — models page], one or two requests, ~1–2 s.
- **Eval:** existing labels on closed issues form the labelled set immediately; measure top-1 label accuracy + calibration before any autonomous application.

---

## 8. Evaluation and calibration plan

**Token definition (per brief):** total input + output tokens across main session, sub-agent sessions, retries, compaction work, and Jev requests. Session files already provide the first four [V — per-message usage, ToolResultMessage.usage, compaction usage]; the Jev ledger provides the fifth [V — usage.json]. Cost is computed separately per model price (main model per its provider pricing; Jev input-only at $0.042/Mtok [V]).

**Baseline (before any Jev):**

- Build the instrumentation extension of §3 (tool-call log with arg hashes + outcomes; run rollups with tokens/cost).
- Task suite: 8–12 representative agentic-development tasks against this repo (one triage sweep, one research brief, one scoped implementation via `worker`, one review via `reviewer`, one deliberately ambiguous task, one deliberately blocked task). 3 runs each. Metrics per brief: completion rate, correctness/acceptance, user corrections, total tokens, main-model turns, tool-call count, repeated/redundant calls (hash-defined), strategy changes, sub-agent usage, wall-clock, Jev requests/tokens, estimated cost, premature-completion rate (labelled), failure-to-stop rate, escalation rate.
- Hand-label W1–W10 occurrences in the recorded traces → the labelled case library.

**Operational loop signal (candidate definition, to validate against traces):** *a tool call whose normalized (tool, args-hash) tuple occurred within the last k turns of the same session with an error or no observable state change (no mtime/git change among its declared targets), repeated now.* Validate by checking labelled loops the human annotator found that this definition misses (e.g., semantically equivalent but textually different commands) — that residue is precisely O1's Jev layer, and its size decides whether the Jev layer is worth it. If the deterministic signal already catches ≥ 80% of labelled loops, ship determinism-only.

**Calibration:** for each judgment, collect (label, probability) pairs into `ScoredSample`s and use `pi-typesafe/calibrate` — AUC, threshold sweep, and the lowest threshold meeting explicit precision/recall floors [V — dist/calibrate.d.ts]. Thresholds are set per judgment on Pi-derived cases, never copied from docs/examples [per brief + jaggedness warning that thresholds do not transfer across primitives].

**Shadow mode:** every experiment runs first with Jev judging and logging only (`{judgment, confidence, wouldHaveDone}`), workflow untouched. Agreement analysis: Jev vs deterministic policy vs main model's actual choice vs measured outcome — disagreements are the labelled data for threshold tuning and for deciding whether a judgment belongs in Jev at all.

**A/B:** baseline vs experiment arm on the task suite, ≥ 3 runs per task per arm, same models/thinking levels, randomized order, paired per-task comparison. Success criteria (per experiment, all must hold):
- Total tokens (as defined) ≤ baseline − 10% (E1), ≤ baseline (E2 — it buys a turn on purpose, so its metrics are premature-completion rate and user corrections), ≤ baseline − 25% (E3) *and* label accuracy ≥ 90% with no high-confidence mislabels.
- No regression in completion rate or correctness. Wall-clock not worse by > 5%.
- Jev cost per session < $0.01 and requests within the configured caps.

**Rollback criteria:** any correctness regression attributable to a blocked/steered action; loop-signal false-positive rate > 5% of tool calls; Jev unavailability changing behavior (guards must fail open and say so via `authState()` [V]).

**Offline replay:** the tool-call log doubles as a replay corpus — re-run guard logic over recorded traces without executing tools (deterministic layer fully replayable; Jev layer replayable against logged state snapshots).

---

## 9. Recommended architecture (decision ownership)

| Layer | Owns | Examples here |
|---|---|---|
| **Deterministic code** | Rules, counting, hashing, parsing, state machines, budgets, permissions, retries, workflow state, irreversible-action gates | arg-hash loop detection, `Blocked by:` parsing, triage label sets, spend caps, tool allowlists, compaction triggers |
| **Jev (System One)** | Narrow, typed semantic judgments over bounded state, each with an explicit policy consumer | "same failed approach?" (O1), "evidence supports completion?" (O2), "which triage label?" (O3), "right sub-agent?" (O4, advisory) |
| **Main reasoning model** | Open-ended planning, code generation, debugging, synthesis, anything needing multi-step reasoning or generation | everything the agent loop does today |
| **User** | Consent, irreversible actions, ambiguous goals, threshold sign-off, escalation | `/typesafe enable`-style consent per guard; final say on triage suggestions |

Placement in Pi: each guard is an extension consuming lifecycle hooks (`tool_call` to block/annotate, `agent_end` to steer at completion, skills for triage), each with its own `createTypeSafe` client (independent budget), its own consent command, fail-open behavior on Jev unavailability, and structured logging of every judgment (state hash, question ids, answer, confidence, policy outcome) for replay and debugging.

---

## 10. Incremental implementation roadmap

1. **Instrument (no Jev, no behavior change).** Tool-call logger + run rollups + labelled trace sample. Exit criteria: W1–W10 frequencies known on ≥ 30 sessions; loop-signal definition validated against hand labels.
2. **Determinism-only guards.** Exact-repeat blocking and failed-delegation warnings in code only. Measure. (If this captures most loop value, the Jev layer of O1 shrinks to the near-repeat residue.)
3. **Shadow Jev.** O1, O2 (and O4 advisory) run in log-only mode against the recorded corpus + live sessions; calibrate thresholds with the calibrate kit; run disagreement analysis.
4. **Smallest production experiment: E3 (issue triage).** Human-in-the-loop suggestions only, real labelled data, trivial rollback, sub-cent cost. Then E1 opt-in enforcement, then E2 steering.
5. **Re-evaluate each quarter** against a fresh trace sample; Jev versions move (pin `jev-1.13.0`, not `jev-latest`, once thresholds are tuned [V — models page]).

---

## 11. Open questions and assumptions

1. **How often do the failure modes actually occur here?** Entirely unmeasured (§3). The whole prioritization inverts if loops are rare but context bloat (W10) dominates — hence roadmap step 1 first.
2. **Cache economics assumption [I]:** this design assumes most repeated context is cache-read (cheap) rather than full-price input, which weakens pure context-trimming plays (O6) relative to loop-prevention plays (O1). Verify cache-hit rates from session files.
3. **pi-typesafe velocity:** 0.6.1 is an independent fast-moving package; the 20-attempt session cap and limits may change. Re-verify before building, and prefer the library API (`createTypeSafe`) over the tool path for infrastructure use.
4. **Jev availability/capacity:** the models page warns rate limits are adjusting dynamically [V]; guards must treat 429/529 as fail-open, and the calibrate kit must record errors as exclusions (it does [V]).
5. **Privacy sign-off:** O1/O2 send only shapes and hashes; O3 sends issue text (public tracker); anything sending code content would need explicit user opt-in — deliberately avoided in all three experiments.
6. **Does the user want advisory annotations in-context at all?** O4 injects nothing in v1; confirm preference before any in-context injection beyond E2's single steering message.
7. **Assumption [I]:** `run-history.jsonl`'s writer could not be located on disk (scout finding); its semantics were inferred from samples. Confirm before building rollups on top of it.
8. **Threshold transfer warning [V]:** Noul thresholds do not transfer to Choice probabilities, and negations are not complements — each judgment needs its own calibration, and questions must be worded to mean exactly what the policy tests.
