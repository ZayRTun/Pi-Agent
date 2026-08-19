# Issue tracker: GitHub

Issues and specs for this repo live as GitHub Issues in `ZayRTun/Pi-Agent`. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number,title,body,labels: [.labels[].name],comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`.
- **Apply or remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`.
- **Close**: `gh issue close <number> --comment "..."`.

The repository is inferred from the GitHub remote when commands run inside this clone.

## Pull requests as a triage surface

PRs are not a triage request surface for this repository.

## Wayfinding operations

Used by `/wayfinder`. The map is a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. Child tickets are GitHub issues linked to the map as sub-issues where supported; otherwise they include `Part of #<map>` in the body. Child tickets use `wayfinder:<type>` labels: `research`, `prototype`, `grilling`, or `task`.

Native issue dependencies are preferred for blocking. Where unavailable, use a `Blocked by: #<n>, #<n>` line near the top of the child body. A ticket is unblocked when every blocker is closed.

Claim a ticket with `gh issue edit <n> --add-assignee @me`. Resolve it by posting the answer, closing the issue, and appending a context pointer to the map's Decisions-so-far.
