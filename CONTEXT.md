# Interactive Agent Questioning

This context defines the language for collecting user input during agent workflows such as grilling and wayfinding without moving workflow state into the interaction mechanism.

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
