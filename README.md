# pi-notify

A [Pi](https://github.com/badlogic/pi-mono) extension that sends a notification when the agent finishes and is waiting for input.

Supports native terminal notifications **and** push notifications to your phone via [ntfy.sh](https://ntfy.sh).

![pi-notify demo](demo.gif)

## Compatibility

| Terminal                       | Support | Protocol                        |
| ------------------------------ | ------- | ------------------------------- |
| Ghostty                        | ✓       | OSC 777                         |
| iTerm2                         | ✓       | OSC 9                           |
| WezTerm                        | ✓       | OSC 777                         |
| rxvt-unicode                   | ✓       | OSC 777                         |
| Kitty                          | ✓       | OSC 99                          |
| tmux (inside a supported term) | ✓*      | tmux passthrough + OSC 777/99/9 |
| Windows Terminal               | ✓       | PowerShell toast                |
| Terminal.app                   | ✗       | —                               |
| Alacritty                      | ✗       | —                               |

\* tmux requires passthrough enabled in your tmux config:

```tmux
set -g allow-passthrough on
```

## Install

```bash
pi install npm:pi-notify
```

Or via git:

```bash
pi install git:github.com/ferologics/pi-notify
```

Restart Pi.

## How it works

When Pi's agent finishes (`agent_end` event), the extension sends a notification via the appropriate protocol:

- **OSC 777** (Ghostty, WezTerm, rxvt-unicode): Native escape sequence
- **OSC 9** (iTerm2): iTerm2 notification protocol, detected via `TERM_PROGRAM=iTerm.app`
- **OSC 99** (Kitty): Kitty's notification protocol, detected via `KITTY_WINDOW_ID`
- **tmux passthrough**: OSC sequences are wrapped automatically when `TMUX` is set
- **Windows toast** (Windows Terminal): PowerShell notification, detected via `WT_SESSION`

Clicking the terminal notification focuses the terminal window/tab.

## Push Notifications via ntfy.sh

[ntfy.sh](https://ntfy.sh) is a free, open-source push notification service. It lets you receive Pi notifications on your phone (or any device) even when you're not looking at the terminal.

### Setup

1. Install the [ntfy app](https://ntfy.sh) on your phone (iOS/Android)
2. Subscribe to a topic in the app (e.g. `pi-notify-myname`)
3. Set the environment variable:

```bash
export PI_NOTIFY_NTFY="https://ntfy.sh/pi-notify-myname"
```

That's it! When Pi finishes, you'll get a push notification on your phone.

> **Tip:** Use a hard-to-guess topic name (or use a private ntfy server) since topic names are publicly accessible.

### Self-hosted ntfy server

```bash
export PI_NOTIFY_NTFY="https://ntfy.myserver.com/my-topic"
```

### Authentication

For protected topics, set a token or basic auth:

```bash
# Access token (recommended)
export PI_NOTIFY_NTFY_TOKEN="tk_abcdef123456"

# Or basic auth
export PI_NOTIFY_NTFY_USER="myuser"
export PI_NOTIFY_NTFY_PASS="mypass"
```

### Optional settings

```bash
# Priority: min, low, default, high, urgent
export PI_NOTIFY_NTFY_PRIORITY="high"

# Emoji tags (comma-separated, see ntfy docs)
export PI_NOTIFY_NTFY_TAGS="robot,white_check_mark"

# Click action URL (opens when tapping the notification)
export PI_NOTIFY_NTFY_CLICK="https://your-ci-dashboard.com"
```

All `PI_NOTIFY_NTFY_*` variables are optional except `PI_NOTIFY_NTFY` itself. The push notification fires alongside the terminal notification — you get both.

### How it works

The extension sends a simple HTTP POST to your ntfy topic URL. The request body is the notification message, with `Title`, `Priority`, and `Tags` headers. It's fire-and-forget: errors are silently ignored so they never break the terminal notification.

## Optional: Custom sound hook

You can run a custom command whenever a notification is sent by setting `PI_NOTIFY_SOUND_CMD`.

This keeps the extension tiny and cross-platform: you choose the command for your OS.

> Note: This is an additional sound hook. It does not replace native terminal/system notification sounds.

### Example (macOS)

```fish
set -Ux PI_NOTIFY_SOUND_CMD 'afplay ~/Library/Sounds/Glass.aiff'
```

### Example (Linux)

```bash
export PI_NOTIFY_SOUND_CMD='paplay /usr/share/sounds/freedesktop/stereo/complete.oga'
```

### Example (Windows PowerShell)

```powershell
$env:PI_NOTIFY_SOUND_CMD = 'powershell -NoProfile -Command "[console]::beep(880,180)"'
```

The command is run in the background (`shell: true`, detached) so it won't block Pi.

## What's OSC 777/99/9?

OSC = Operating System Command, part of ANSI escape sequences. Terminals use these for things beyond text formatting (change title, colors, notifications, etc.).

`777` is the number rxvt-unicode picked for notifications. Ghostty and WezTerm adopted it. iTerm2 uses `9` instead, and Kitty uses `99` with a more extensible protocol.

## Known Limitations

- **tmux** works only with passthrough enabled (`set -g allow-passthrough on`).
- **zellij/screen** are still unsupported for OSC notifications.

## License

MIT
