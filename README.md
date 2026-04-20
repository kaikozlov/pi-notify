# pi-notify

A [Pi](https://github.com/mariozechner/pi-coding-agent) extension that sends a notification when the agent finishes and is waiting for input.

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

## `/notify` command

Control which notification channels are active at runtime. The mode resets to `all` when Pi restarts.

```
/notify          Show current mode and usage
/notify off      Silence everything
/notify local    Terminal only (OSC), no push
/notify ntfy     Push only, no terminal bell
/notify all      Both terminal + push (default)
```

Useful when you're actively pairing with Pi and don't need notifications, or when you only want push alerts on your phone.

## Push Notifications via ntfy.sh

[ntfy.sh](https://ntfy.sh) is a free, open-source push notification service. It lets you receive Pi notifications on your phone (or any device) even when you're not looking at the terminal.

### Quick start

1. Install the [ntfy app](https://ntfy.sh) on your phone (iOS/Android)
2. Subscribe to a topic in the app (e.g. `pi-notify-myname`)
3. Set the environment variable:

```bash
export PI_NOTIFY_NTFY="https://ntfy.sh/pi-notify-myname"
```

That's it! When Pi finishes, you'll get a push notification on your phone.

> **Tip:** Use a hard-to-guess topic name (or use a private ntfy server) since topic names are publicly accessible.

### Notification body

ntfy notifications are rendered as **markdown** in the mobile apps and web UI. The body includes:

```
**My Session Name**

I've refactored the auth module to use JWT tokens. Changes include...

⚙️ 1,247 tokens • $0.003

🔧 bash(2) edit(3) read(5)

⏱ Completed in 2m 34s
```

- **Bold session name** — from Pi's session name
- **Response summary** — first paragraph of Pi's last message
- **Token usage & cost** — input/output tokens and estimated cost
- **Tool call summary** — which tools were used and how many times
- **Elapsed time** — how long the agent ran

### Smart priority

The notification priority is automatically set based on how the agent finished:

| Agent result              | ntfy Priority | On your phone           |
| ------------------------- | ------------- | ----------------------- |
| Clean finish (`stop`)     | `default`     | Normal notification     |
| Wants to continue         | `high`        | Prominent alert         |
| Hit max output tokens     | `high`        | Prominent alert         |
| Something went wrong      | `urgent`      | Immediate + sound       |
| Cancelled by user         | *(skipped)*   | No notification sent    |

Set `PI_NOTIFY_NTFY_PRIORITY` to override this behavior with a fixed priority.

### Error notifications

When the agent stops with an error, the notification gets special treatment:

- **Title:** `⚠️ Pi Error`
- **Priority:** `urgent`
- **Tag:** 🔴 `rotating_light`
- **Body:** includes the error message with ⚠️ prefix

### Click actions

Tapping a notification can open the project in your IDE. Set a click scheme:

```bash
# Shorthand — auto-generates IDE URI from the project directory
export PI_NOTIFY_NTFY_CLICK_SCHEME="vscode"   # vscode://file/{cwd}
export PI_NOTIFY_NTFY_CLICK_SCHEME="cursor"   # cursor://file/{cwd}
export PI_NOTIFY_NTFY_CLICK_SCHEME="zed"      # zed://file{cwd}

# Or a custom URL template
export PI_NOTIFY_NTFY_CLICK_SCHEME="myapp://open?path={cwd}"
```

For VS Code and Cursor, a **"View Changes"** button is also added that opens the SCM panel.

Alternatively, set an explicit URL (no template resolution):

```bash
export PI_NOTIFY_NTFY_CLICK="https://your-ci-dashboard.com"
```

### Per-project topics

Use template tokens in your topic URL to get separate notification channels per project:

```bash
# {project} resolves to the directory basename
export PI_NOTIFY_NTFY="https://ntfy.sh/pi-{project}"
# → https://ntfy.sh/pi-my-app  (when working in ~/dev/my-app)

# {cwd} resolves to the full working directory
export PI_NOTIFY_NTFY="https://ntfy.sh/work-{project}"
# → https://ntfy.sh/work-pi-notify  (when working in ~/dev/pi-notify)
```

This lets you subscribe to different topics per project in the ntfy app, so you can mute or prioritize them independently.

### Keep-alive notifications

For long-running tasks, optionally send periodic "still working" notifications so you know Pi hasn't stalled:

```bash
# Minimum minutes between keep-alive notifications (0 = disabled, default)
export PI_NOTIFY_NTFY_KEEPALIVE="5"
```

Keep-alive notifications use `min` priority (no vibration/sound) and include the current turn number and elapsed time.

### Authentication

For protected topics, set a token or basic auth:

```bash
# Access token (recommended)
export PI_NOTIFY_NTFY_TOKEN="tk_abcdef123456"

# Or basic auth
export PI_NOTIFY_NTFY_USER="myuser"
export PI_NOTIFY_NTFY_PASS="mypass"
```

### Self-hosted ntfy server

```bash
export PI_NOTIFY_NTFY="https://ntfy.myserver.com/my-topic"
```

## Configuration Reference

| Variable | Default | Description |
|---|---|---|
| `PI_NOTIFY_NTFY` | *(none)* | ntfy topic URL. Required for push notifications. Supports `{project}` and `{cwd}` templates. |
| `PI_NOTIFY_NTFY_TOKEN` | *(none)* | Bearer token for ntfy auth |
| `PI_NOTIFY_NTFY_USER` | *(none)* | Basic auth username |
| `PI_NOTIFY_NTFY_PASS` | *(none)* | Basic auth password |
| `PI_NOTIFY_NTFY_PRIORITY` | auto | Override auto-detected priority. Values: `min`, `low`, `default`, `high`, `urgent` |
| `PI_NOTIFY_NTFY_TAGS` | `white_check_mark` | Emoji tags for notifications (comma-separated) |
| `PI_NOTIFY_NTFY_CLICK` | *(none)* | Explicit click URL (takes priority over `CLICK_SCHEME`) |
| `PI_NOTIFY_NTFY_CLICK_SCHEME` | *(none)* | IDE scheme shorthand: `vscode`, `cursor`, `zed`, or a custom `{cwd}` template |
| `PI_NOTIFY_NTFY_KEEPALIVE` | `0` | Minutes between keep-alive notifications during long tasks (`0` = disabled) |
| `PI_NOTIFY_SOUND_CMD` | *(none)* | Shell command to run on each notification (detached, non-blocking) |

All `PI_NOTIFY_*` variables are optional. Set `PI_NOTIFY_NTFY` to enable push notifications; everything else is opt-in enhancement.

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
