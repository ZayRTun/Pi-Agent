# Keep question interactions stateless and separate from workflow orchestration

The question extension will expose a single-Question interaction and a separate multi-Question batch interaction, while remaining stateless and independent of grilling or wayfinding concepts. This keeps UI mechanics reusable, lets callers own question dependencies and session state, and avoids modifying packaged skills or coupling the extension to their internal names; the trade-off is that callers must explicitly construct valid independent Question rounds.
