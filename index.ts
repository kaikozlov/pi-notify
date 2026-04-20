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

export function wrapForTmux(sequence: string): string {
    if (!process.env.TMUX) return sequence;

    // tmux passthrough: wrap in DCS and escape inner ESC bytes.
    const escaped = sequence.split("\x1b").join("\x1b\x1b");
    return `\x1bPtmux;${escaped}\x1b\\`;
}

// --- Terminal notification functions (side-effectful, mocked in tests) ---

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
/**
 * Resolve the click URL from env vars and optional CWD.
 *
 * Priority:
 * 1. PI_NOTIFY_NTFY_CLICK (explicit URL)
 * 2. PI_NOTIFY_NTFY_CLICK_SCHEME + cwd (auto-generated IDE URI)
 */
export function resolveClickUrl(cwd?: string): string | undefined {
    const explicit = process.env.PI_NOTIFY_NTFY_CLICK?.trim();
    if (explicit) return explicit;

    const scheme = process.env.PI_NOTIFY_NTFY_CLICK_SCHEME?.trim();
    if (!scheme || !cwd) return undefined;

    // Support both shorthand and full scheme names
    const schemes: Record<string, string> = {
        vscode: "vscode://file/",
        cursor: "cursor://file/",
        zed: "zed://file",
    };

    const prefix = schemes[scheme];
    if (prefix) return `${prefix}${cwd}`;

    // Treat as custom URL template — replace {cwd} placeholder
    return scheme.replace("{cwd}", cwd);
}

/**
 * Build the ntfy Actions header value.
 * Supports multiple action buttons (ntfy allows up to 3).
 */
export function buildNtfyActions(cwd?: string): string | undefined {
    const actions: Array<{ action: string; label: string; url: string }> = [];

    // Primary: Open in IDE
    const clickUrl = resolveClickUrl(cwd);
    if (clickUrl) {
        actions.push({ action: "view", label: "Open in IDE", url: clickUrl });
    }

    // Optional: View git changes (SCM panel)
    const scheme = process.env.PI_NOTIFY_NTFY_CLICK_SCHEME?.trim();
    if (cwd && scheme) {
        const schemes: Record<string, string> = {
            vscode: "vscode://vscode.scm",
            cursor: "cursor://cursor.scm",
        };
        const scmUrl = schemes[scheme];
        if (scmUrl) {
            actions.push({ action: "view", label: "View Changes", url: scmUrl });
        }
    }

    if (actions.length === 0) return undefined;

    // ntfy Actions header format: JSON array
    return JSON.stringify(actions);
}

/**
 * Resolve template tokens in the ntfy URL.
 * Supported tokens: {project} (basename of cwd), {cwd} (full path)
 *
 * Example: https://ntfy.sh/pi-{project} → https://ntfy.sh/pi-pi-notify
 */
export function resolveNtfyUrl(rawUrl: string, cwd?: string): string {
    if (!cwd) return rawUrl;

    const project = cwd.split("/").pop() ?? "";
    return rawUrl
        .replace("{project}", project)
        .replace("{cwd}", cwd);
}

function notifyNtfy(title: string, body: string, options?: { priority?: string; cwd?: string; tags?: string }): void {
    const rawNtfyUrl = process.env.PI_NOTIFY_NTFY?.trim();
    if (!rawNtfyUrl) return;

    try {
        const ntfyUrl = resolveNtfyUrl(rawNtfyUrl, options?.cwd);
        const url = new URL(ntfyUrl);
        const headers: Record<string, string> = {
            "Title": title,
            "Priority": options?.priority ?? process.env.PI_NOTIFY_NTFY_PRIORITY?.trim() ?? "default",
            "Tags": options?.tags ?? process.env.PI_NOTIFY_NTFY_TAGS?.trim() ?? "white_check_mark",
            "Markdown": "yes",
        };

        // Build action buttons from env and CWD
        const actionsHeader = buildNtfyActions(options?.cwd);
        if (actionsHeader) {
            headers["Actions"] = actionsHeader;
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

        const req = reqFn(url, { method: "POST", headers }, (res: import("node:http").IncomingMessage) => {
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
export function truncate(str: string, max: number): string {
    if (str.length <= max) return str;
    return str.slice(0, max - 1) + "…";
}

/**
 * Extract the text content from the last assistant message in the agent response.
 * Falls back to a generic message if none is found.
 */
export interface TextContentBlock {
    type: "text";
    text: string;
}

export interface AssistantMessage {
    role: "assistant";
    content: (TextContentBlock | { type: string; [key: string]: unknown })[];
    usage: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        totalTokens: number;
        cost?: {
            total: number;
        };
    };
    stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
    errorMessage?: string;
    timestamp: number;
}

export interface ToolCallContentBlock {
    type: "toolCall";
    id: string;
    name: string;
    arguments: Record<string, any>;
}

export interface AgentMessage {
    role: string;
    content?: unknown;
    [key: string]: unknown;
}

/**
 * Map stopReason to ntfy priority.
 */
export function mapStopReasonToPriority(stopReason: string): string {
    switch (stopReason) {
        case "error": return "urgent";
        case "toolUse": return "high";
        case "length": return "high";
        case "aborted": return "min";
        default: return "default";
    }
}

/**
 * Walk messages and tally tool calls by name.
 * Returns a summary like "🔧 edit(3) read(5) bash(1)"
 */
export function extractToolSummary(messages: AgentMessage[]): string {
    const counts = new Map<string, number>();

    for (const msg of messages) {
        if (msg.role !== "assistant") continue;
        const content = Array.isArray(msg.content) ? msg.content : [];
        for (const block of content) {
            if (
                block && typeof block === "object" &&
                "type" in block && block.type === "toolCall" &&
                "name" in block && typeof block.name === "string"
            ) {
                counts.set(block.name, (counts.get(block.name) ?? 0) + 1);
            }
        }
    }

    if (counts.size === 0) return "";

    // Sort by count descending, then alphabetically
    const entries = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const parts = entries.map(([name, count]) => `${name}(${count})`);
    return `🔧 ${parts.join(" ")}`;
}

export function extractAssistantSummary(messages: AgentMessage[]): string {
    // Walk messages in reverse to find the last assistant message
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i] as AssistantMessage;
        if (msg.role !== "assistant") continue;

        const content = Array.isArray(msg.content) ? msg.content : [];
        // Collect all text blocks (skip thinking, toolCall, etc.)
        const textParts: string[] = [];
        for (const block of content) {
            if ("type" in block && block.type === "text" && "text" in block && block.text.trim()) {
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

/**
 * Format token usage and cost into a compact string for notifications.
 * Example: "⚙️ 1,247 tokens • $0.003"
 */
export function formatUsage(usage: AssistantMessage["usage"]): string {
    const tokens = usage.totalTokens;
    const formatted = tokens.toLocaleString();
    const cost = usage.cost?.total;
    if (cost !== undefined && cost > 0) {
        const costStr = `$${cost.toFixed(4)}`.replace(/\.?0+$/, "");
        return `⚙️ ${formatted} tokens • ${costStr}`;
    }
    return `⚙️ ${formatted} tokens`;
}

/**
 * Format elapsed milliseconds into a human-readable string.
 * Example: "⏱ Completed in 2m 34s"
 */
export function formatElapsed(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    const parts: string[] = [];
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0 || hours > 0) parts.push(`${minutes}m`);
    parts.push(`${seconds}s`);

    return `⏱ Completed in ${parts.join(" ")}`;
}

/**
 * Build a markdown-formatted body for ntfy push notifications.
 * ntfy renders markdown when the `Markdown: yes` header is set.
 */
export interface NtfyBodyOptions {
    sessionName?: string;
    usage?: AssistantMessage["usage"];
    toolSummary?: string;
    elapsedMs?: number;
    errorMessage?: string;
}

export function buildNtfyBody(summary: string, options?: NtfyBodyOptions): string {
    const parts: string[] = [];

    if (options?.sessionName) {
        parts.push(`**${options.sessionName}**`);
        parts.push("");
    }

    parts.push(summary);

    if (options?.usage) {
        parts.push("");
        parts.push(formatUsage(options.usage));
    }

    if (options?.toolSummary) {
        parts.push("");
        parts.push(options.toolSummary);
    }

    if (options?.elapsedMs !== undefined && options.elapsedMs > 0) {
        parts.push("");
        parts.push(formatElapsed(options.elapsedMs));
    }

    if (options?.errorMessage) {
        parts.push("");
        parts.push(`⚠️ ${options.errorMessage}`);
    }

    return parts.join("\n");
}

export function notify(title: string, body: string, sessionName?: string, ntfyOptions?: NtfyBodyOptions & { stopReason?: string; cwd?: string }): void {
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

    // Detect error state
    const isError = ntfyOptions?.stopReason === "error" || Boolean(ntfyOptions?.errorMessage);

    // ntfy: markdown-formatted body with session context.
    const ntfyBody = buildNtfyBody(body, { sessionName, ...ntfyOptions });
    // Use explicit env var priority if set, otherwise derive from stopReason
    const ntfyPriority = process.env.PI_NOTIFY_NTFY_PRIORITY?.trim()
        ?? (ntfyOptions?.stopReason ? mapStopReasonToPriority(ntfyOptions.stopReason) : undefined);
    // Error notifications get special title, tags
    const ntfyTitle = isError ? "⚠️ Pi Error" : "Pi";
    const ntfyTags = isError ? "rotating_light" : undefined;
    notifyNtfy(ntfyTitle, ntfyBody, { priority: ntfyPriority, cwd: ntfyOptions?.cwd, tags: ntfyTags });
}

// Module-level tracker for agent start time and keep-alive
let agentStartTime: number | undefined;
let lastKeepaliveTime: number | undefined;
let keepaliveSessionName: string | undefined;
let keepaliveCwd: string | undefined;

/**
 * Check if a keep-alive notification should be sent based on elapsed time.
 */
export function shouldSendKeepalive(
    now: number,
    lastTime: number | undefined,
    intervalMs: number,
): boolean {
    if (intervalMs <= 0) return false;
    if (lastTime === undefined) return false;
    return now - lastTime >= intervalMs;
}

export default function (pi: ExtensionAPI) {
    pi.on("agent_start", async () => {
        agentStartTime = Date.now();
        lastKeepaliveTime = Date.now();
        keepaliveSessionName = pi.getSessionName() ?? undefined;
    });

    pi.on("turn_end", async (event, ctx) => {
        // Only for interactive sessions
        if (!ctx.hasUI) return;

        const keepaliveMin = parseInt(process.env.PI_NOTIFY_NTFY_KEEPALIVE?.trim() ?? "0", 10);
        if (keepaliveMin <= 0) return;

        const now = Date.now();
        const intervalMs = keepaliveMin * 60 * 1000;

        if (!shouldSendKeepalive(now, lastKeepaliveTime, intervalMs)) return;

        // Update tracker before sending
        lastKeepaliveTime = now;
        keepaliveCwd = ctx.cwd;

        const elapsedMs = agentStartTime ? now - agentStartTime : undefined;
        const toolSummary = extractToolSummary([event.message as AgentMessage]);
        const turnInfo = `Turn ${event.turnIndex + 1}`;

        const body = buildNtfyBody(`Still working... (${turnInfo})`, {
            sessionName: keepaliveSessionName,
            toolSummary: toolSummary || undefined,
            elapsedMs,
        });

        notifyNtfy("Pi 🏃", body, { priority: "min", cwd: keepaliveCwd });
    });

    pi.on("agent_end", async (event, ctx) => {
        // Only notify for interactive sessions (skip print mode / JSON mode)
        if (!ctx.hasUI) return;

        const sessionName = pi.getSessionName();
        const title = sessionName ? `Pi — ${sessionName}` : "Pi";

        // Skip notification if the user cancelled (Escape / manual abort) — they're present
        const lastAssistant = event.messages
            .filter((m: AgentMessage) => m.role === "assistant")
            .pop() as AssistantMessage | undefined;
        if (lastAssistant?.stopReason === "aborted") return;

        const summary = extractAssistantSummary(event.messages);
        const toolSummary = extractToolSummary(event.messages);

        const elapsedMs = agentStartTime ? Date.now() - agentStartTime : undefined;

        notify(title, summary, sessionName ?? undefined, {
            usage: lastAssistant?.usage,
            toolSummary: toolSummary || undefined,
            stopReason: lastAssistant?.stopReason,
            elapsedMs,
            cwd: ctx.cwd,
            errorMessage: lastAssistant?.errorMessage,
        });
    });
}
