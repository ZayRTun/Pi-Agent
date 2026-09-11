# Interactive Agent Questioning

This context defines the language for collecting user input during agent workflows such as grilling and wayfinding without moving workflow state into the interaction mechanism.

## Sub-agent Delegation

**Sub-agent**:
An agent session with its own isolated context, invoked to perform one task and return its result to the invoking session.
_Avoid_: Worker, child process (when referring to the concept rather than the mechanism)

**Delegation**:
Assigning a self-contained task to a Sub-agent instead of doing the work in the main session.
_Avoid_: Dispatch, spawning (when referring to the concept)

**Blocking delegation**:
A Delegation where the main session waits for the Sub-agent's result before continuing. The only supported form.
_Avoid_: Background run, async run

**Agent definition**:
The configuration that defines a Sub-agent: its name, description, tools, declared model, declared thinking level, and system prompt.
_Avoid_: Agent file, subagent config

**Declared** / **Inherited**:
A Sub-agent's model and thinking level are inherited from the invoking session unless the Agent definition declares them; a declared value is used as given. Inherited and declared are the only two sources.
_Avoid_: override, custom (as a noun)

## Run States

Every Delegation is in exactly one Run State at any moment.

**Running**:
The Sub-agent is still executing its task.

**Succeeded**:
The Sub-agent finished its task successfully.

**Failed**:
The Sub-agent finished unsuccessfully due to its own error.

**Aborted**:
The user deliberately stopped the Sub-agent before it finished. Distinct from Failed — stopping was chosen, not suffered.
_Avoid_: treating Aborted as Failed

## Questioning

**Question**:
One prompt requiring a user response.
_Avoid_: Question set, decision (unless it has actually resolved a design choice)

**Answer**:
The user's response to one Question, including selected options or free-form text.
_Avoid_: Decision

**Question round**:
All Questions that are currently answerable together in a grilling session's design tree. A round may be presented through a Batch interaction.
_Avoid_: Batch (when referring to the workflow concept)

**Decision**:
A clarified design choice produced by interpreting one or more Answers.
_Avoid_: Answer

**Question interaction**:
A transient UI exchange that presents one Question and returns an Answer; it does not own workflow state.
_Avoid_: Interview

**Batch interaction**:
A transient UI exchange that presents multiple independent Questions from one Question round and returns their ordered Answers together.
_Avoid_: Question round (when referring specifically to the UI mechanism)

**Interview/session**:
The larger stateful process that manages Questions, Answers, Decisions, and documentation; it is owned by the calling skill or workflow.

**Session name**:
A human-readable label for an interview/session, used to recognize and search for it later.
_Avoid_: title (when referring to the persistent session label rather than presentation text).

**Session intent**:
What the user primarily wants to accomplish in an interview/session; the session name should identify this rather than the session's eventual outcome. For automatic naming, it is represented by the opening request.

**Opening request**:
The first user request that establishes the session intent. Later turns may clarify or expand the work but do not replace the opening request for purposes of the session name.

**Effective model**:
The AI model actively used by a particular interview/session, as distinct from a configured default or a model mentioned in its history.

**Automatic session naming**:
The one-time creation of a session name from the opening request when an eligible session has no name. It must not replace an explicitly chosen session name.

**Eligible session**:
A new, resumed, forked, or cloned session that has no session name and has reached a successful completed turn. An unsuccessful turn does not consume eligibility, but a failed naming attempt is not retried.
_Avoid_: Question interaction
