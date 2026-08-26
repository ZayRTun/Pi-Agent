# OpenCode Attention for Pi

A Pi extension that mirrors OpenCode's built-in TUI attention behavior on macOS.

## Enable

The extension is auto-discovered from `~/.pi/agent/extensions/`. Add this to
`~/.pi/agent/settings.json`:

```json
{
  "attention": {
    "enabled": true,
    "notifications": true,
    "sound": true,
    "volume": 0.4,
    "sound_pack": "opencode.default"
  }
}
```

`enabled` defaults to `false`, matching OpenCode. The extension reads the
optional `attention` object from global and trusted project settings, with
project values overriding global values.

## Behavior

- Main session settlement plays the `done` sound and sends an OSC 777 desktop
  notification.
- Terminal errors play the `error` sound and suppress the following done event.
- `rpiv-ask-user-question` prompts play the `question` sound and send a desktop
  notification when the questionnaire blocks for input.
- `subagent` tool completions (from the custom extension at
  `~/.pi/agent/extensions/subagent/`) play the `subagent_done` sound without a
  desktop notification; a failed or aborted task plays the `error` sound,
  matching OpenCode.
- Non-macOS platforms currently do nothing.

The bundled sounds are the OpenCode default assets:

| Event | Asset |
|---|---|
| Default / done | `bip-bop-01.mp3` |
| Question | `bip-bop-03.mp3` |
| Permission | `staplebops-06.mp3` |
| Error | `nope-03.mp3` |
| Subagent done | `yup-01.mp3` |

Custom sound paths can be supplied under `attention.sounds` using the keys
`default`, `question`, `permission`, `error`, `done`, and `subagent_done`.
Relative paths are resolved from the settings file containing the override.

Desktop notification delivery uses OSC 777 (or Kitty OSC 99 when running
inside Kitty). Sound playback uses macOS `/usr/bin/afplay`.
