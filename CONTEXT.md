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
_Avoid_: Question interaction
