/**
 * Pi Notify Extension
 *
 * Sends a notification when Pi agent is done and waiting for input.
 * Supports multiple notification channels:
 *
 * Terminal protocols:
 * - OSC 777: Ghostty, WezTerm, rxvt-unicode
 * - OSC 9: iTerm2
 * - OSC 99: Kitty
 * - tmux passthrough wrapper for OSC notifications
 * - Windows toast: Windows Terminal (WSL)
 *
 * Push notifications:
 * - ntfy.sh: Send push notifications to your phone via PI_NOTIFY_NTFY
 *
 * Optional sound hook via PI_NOTIFY_SOUND_CMD
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

function windowsToastScript(title: string, body: string): string {
    const type = "Windows.UI.Notifications";
    const mgr = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
    const template = `[${type}.ToastTemplateType]::ToastText01`;
    const toast = `[${type}.ToastNotification]::new($xml)`;
    return [
        `${mgr} > $null`,
        `$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
        `$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${body}')) > $null`,
        `[${type}.ToastNotificationManager]::CreateToastNotifier('${title}').Show(${toast})`,
    ].join("; ");
}

function wrapForTmux(sequence: string): string {
    if (!process.env.TMUX) return sequence;

    // tmux passthrough: wrap in DCS and escape inner ESC bytes.
    const escaped = sequence.split("\x1b").join("\x1b\x1b");
    return `\x1bPtmux;${escaped}\x1b\\`;
}

function notifyOSC777(title: string, body: string): void {
    const sequence = `\x1b]777;notify;${title};${body}\x07`;
    process.stdout.write(wrapForTmux(sequence));
}

function notifyOSC9(message: string): void {
    const sequence = `\x1b]9;${message}\x07`;
    process.stdout.write(wrapForTmux(sequence));
}

function notifyOSC99(title: string, body: string): void {
    // Kitty OSC 99: i=notification id, d=0 means not done yet, p=body for second part
    const titleSequence = `\x1b]99;i=1:d=0;${title}\x1b\\`;
    const bodySequence = `\x1b]99;i=1:p=body;${body}\x1b\\`;
    process.stdout.write(wrapForTmux(titleSequence));
    process.stdout.write(wrapForTmux(bodySequence));
}

function notifyWindows(title: string, body: string): void {
    const { execFile } = require("node:child_process");
    execFile("powershell.exe", ["-NoProfile", "-Command", windowsToastScript(title, body)]);
}

/**
 * Send a push notification via ntfy.sh.
 *
 * Set PI_NOTIFY_NTFY to your topic URL, e.g.:
 *   https://ntfy.sh/my-secret-topic
 *   https://ntfy.myserver.com/my-topic
 *
 * Optionally set PI_NOTIFY_NTFY_TOKEN for access tokens:
 *   tk_abcdef123456
 *
 * The ntfy.sh API is a simple HTTP POST:
 *   - URL path = topic
 *   - Request body = message
 *   - Headers: Title, Priority, Tags, Actions
 */
function notifyNtfy(title: string, body: string): void {
    const ntfyUrl = process.env.PI_NOTIFY_NTFY?.trim();
    if (!ntfyUrl) return;

    try {
        const url = new URL(ntfyUrl);
        const headers: Record<string, string> = {
            "Title": title,
            "Priority": process.env.PI_NOTIFY_NTFY_PRIORITY?.trim() ?? "default",
            "Tags": process.env.PI_NOTIFY_NTFY_TAGS?.trim() ?? "white_check_mark",
        };

        // Optional click action: open the terminal / pi session
        const clickUrl = process.env.PI_NOTIFY_NTFY_CLICK?.trim();
        if (clickUrl) {
            headers["Actions"] = `view, Open, ${clickUrl}`;
        }

        // Optional auth token or basic auth
        const token = process.env.PI_NOTIFY_NTFY_TOKEN?.trim();
        const user = process.env.PI_NOTIFY_NTFY_USER?.trim();
        const pass = process.env.PI_NOTIFY_NTFY_PASS?.trim();
        if (token) {
            headers["Authorization"] = `Bearer ${token}`;
        } else if (user && pass) {
            const encoded = Buffer.from(`${user}:${pass}`).toString("base64");
            headers["Authorization"] = `Basic ${encoded}`;
        }

        const { request } = require("node:http");
        const { request: secureRequest } = require("node:https");
        const reqFn = url.protocol === "https:" ? secureRequest : request;

        const req = reqFn(url, { method: "POST", headers }, (res: any) => {
            // Consume response to free the connection
            res.resume();
        });

        req.on("error", () => {
            // Silently ignore ntfy errors — don't break the extension
        });

        req.write(body);
        req.end();
    } catch {
        // Silently ignore ntfy errors — don't break the extension
    }
}

function runSoundHook(): void {
    const command = process.env.PI_NOTIFY_SOUND_CMD?.trim();
    if (!command) return;

    try {
        const { spawn } = require("node:child_process");
        const child = spawn(command, {
            shell: true,
            detached: true,
            stdio: "ignore",
        });
        child.unref();
    } catch {
        // Ignore hook errors to avoid breaking notifications
    }
}

/**
 * Truncate a string to `max` characters, appending "…" if truncated.
 */
function truncate(str: string, max: number): string {
    if (str.length <= max) return str;
    return str.slice(0, max - 1) + "…";
}

/**
 * Extract the text content from the last assistant message in the agent response.
 * Falls back to a generic message if none is found.
 */
function extractAssistantSummary(messages: any[]): string {
    // Walk messages in reverse to find the last assistant message
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg?.role !== "assistant") continue;

        const content = Array.isArray(msg.content) ? msg.content : [];
        // Collect all text blocks (skip thinking, toolCall, etc.)
        const textParts: string[] = [];
        for (const block of content) {
            if (block?.type === "text" && block.text?.trim()) {
                textParts.push(block.text.trim());
            }
        }

        if (textParts.length > 0) {
            // Grab the first meaningful paragraph (first text block), up to ~200 chars
            const summary = textParts[0];
            return truncate(summary, 200);
        }
    }
    return "Ready for input";
}

function notify(title: string, body: string, sessionName?: string): void {
    const isIterm2 = process.env.TERM_PROGRAM === "iTerm.app" || Boolean(process.env.ITERM_SESSION_ID);

    if (process.env.WT_SESSION) {
        notifyWindows(title, body);
    } else if (process.env.KITTY_WINDOW_ID) {
        notifyOSC99(title, body);
    } else if (isIterm2) {
        notifyOSC9(`${title}: ${body}`);
    } else {
        notifyOSC777(title, body);
    }

    runSoundHook();

    // ntfy: put session context in the body for richer phone notifications.
    // HTTP headers must be ASCII, so keep the header title simple.
    const ntfyBody = sessionName ? `${sessionName}\n\n${body}` : body;
    notifyNtfy("Pi", ntfyBody);
}

export default function (pi: ExtensionAPI) {
    pi.on("agent_end", async (event) => {
        const sessionName = pi.getSessionName();
        const title = sessionName ? `Pi — ${sessionName}` : "Pi";

        const summary = extractAssistantSummary(event.messages);

        notify(title, summary, sessionName ?? undefined);
    });
}
