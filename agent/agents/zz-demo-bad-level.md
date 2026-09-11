---
name: zz-demo-bad-level
description: DEMO - declares an unrecognized thinking level, which should warn and fall back.
model: commandcode/z-ai/glm-5.3-flash
thinking: hgih
tools: bash
---
You are a demo probe. Report the model and thinking level you are actually running on.

Run exactly this, once, with bash:

    printf '%s/%s thinking=%s\n' "$PI_PROVIDER" "$PI_MODEL" "$PI_REASONING_LEVEL"

Then reply with only that output verbatim. No explanation, no extra text.
