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
 * Uses ntfy.sh JSON publish format (POST to root URL with topic in body).
 * This avoids HTTP header encoding issues with Unicode characters (e.g. —, ⚠️).
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
 * Build ntfy action buttons for JSON publish format.
 * Returns an array of action objects (ntfy allows up to 3).
 */
export function buildNtfyActionsJson(cwd?: string): Array<{ action: string; label: string; url: string }> {
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

    return actions;
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
        const parsed = new URL(ntfyUrl);

        // Build the topic from the URL path
        const topic = parsed.pathname.slice(1); // strip leading /

        // Map priority string to ntfy numeric priority (JSON format uses numbers)
        const priorityStr = options?.priority ?? process.env.PI_NOTIFY_NTFY_PRIORITY?.trim() ?? "default";
        const priorityMap: Record<string, number> = { min: 1, low: 2, default: 3, high: 4, urgent: 5 };
        const priority = priorityMap[priorityStr] ?? 3;

        // Build action buttons
        const actions = buildNtfyActionsJson(options?.cwd);

        // Build JSON body per ntfy docs: POST to root URL with topic in body
        const jsonBody: Record<string, unknown> = {
            topic,
            message: body,
            title,
            priority,
            tags: [options?.tags ?? process.env.PI_NOTIFY_NTFY_TAGS?.trim() ?? "white_check_mark"],
            markdown: true,
        };
        if (actions.length > 0) {
            jsonBody.actions = actions;
        }

        // Build headers — only Content-Type and optional auth
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
        };

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

        // POST to root URL (ntfy JSON format requires posting to root, not topic path)
        const rootUrl = new URL(parsed.origin + "/");
        const { request } = require("node:http");
        const { request: secureRequest } = require("node:https");
        const reqFn = rootUrl.protocol === "https:" ? secureRequest : request;

        const req = reqFn(rootUrl, { method: "POST", headers }, (res: import("node:http").IncomingMessage) => {
            res.resume();
        });

        req.on("error", () => {
            // Silently ignore ntfy errors — don't break the extension
        });

        req.write(JSON.stringify(jsonBody));
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
 * Format elapsed milliseconds into a compact human-readable string.
 * Example: "⏱ 2m 34s"
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

    return `⏱ ${parts.join(" ")}`;
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

    // Consolidate metadata (usage, tools, elapsed) into a single compact line
    const metaParts: string[] = [];
    if (options?.usage) {
        metaParts.push(formatUsage(options.usage));
    }
    if (options?.toolSummary) {
        metaParts.push(options.toolSummary);
    }
    if (options?.elapsedMs !== undefined && options.elapsedMs > 0) {
        metaParts.push(formatElapsed(options.elapsedMs));
    }
    if (metaParts.length > 0) {
        parts.push("");
        parts.push(metaParts.join(" · "));
    }

    if (options?.errorMessage) {
        parts.push("");
        parts.push(`⚠️ ${options.errorMessage}`);
    }

    return parts.join("\n");
}

/**
 * Notification mode: which channels are active.
 * - "all": both terminal + ntfy push (default)
 * - "local": terminal only
 * - "ntfy": push only
 * - "off": silence everything
 */
export type NotificationMode = "off" | "local" | "ntfy" | "all";

const VALID_MODES: NotificationMode[] = ["off", "local", "ntfy", "all"];

/** Module-level notification mode state. Reset on restart. */
let notifyMode: NotificationMode = "all";

export function getNotifyMode(): NotificationMode {
    return notifyMode;
}

export function setNotifyMode(mode: NotificationMode): void {
    if (!VALID_MODES.includes(mode)) return;
    notifyMode = mode;
}

/**
 * Mode labels for display.
 */
const MODE_LABELS: Record<NotificationMode, string> = {
    off: "🔕 Off — no notifications",
    local: "💻 Local — terminal only",
    ntfy: "📱 ntfy — push only",
    all: "🔔 All — terminal + push",
};

function modeHelpText(): string {
    const lines = VALID_MODES.map((m) => `  /notify ${m}  ${m === notifyMode ? "← current" : ""}`);
    return `Notification mode: ${MODE_LABELS[notifyMode]}\n\nUsage:\n${lines.join("\n")}`;
}

function notifyTerminal(title: string, body: string): void {
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
}

export function notify(title: string, body: string, sessionName?: string, ntfyOptions?: NtfyBodyOptions & { stopReason?: string; cwd?: string }): void {
    const mode = notifyMode;
    const sendLocal = mode === "all" || mode === "local";
    const sendPush = mode === "all" || mode === "ntfy";

    if (sendLocal) {
        notifyTerminal(title, body);
        runSoundHook();
    }

    if (!sendPush) return;

    // Detect error state
    const isError = ntfyOptions?.stopReason === "error" || Boolean(ntfyOptions?.errorMessage);

    // ntfy: markdown-formatted body with session context.
    const ntfyBody = buildNtfyBody(body, { sessionName, ...ntfyOptions });
    // Use explicit env var priority if set, otherwise derive from stopReason
    const ntfyPriority = process.env.PI_NOTIFY_NTFY_PRIORITY?.trim()
        ?? (ntfyOptions?.stopReason ? mapStopReasonToPriority(ntfyOptions.stopReason) : undefined);
    // Error notifications get special title, tags
    const project = ntfyOptions?.cwd?.split("/").pop() ?? "";
    const ntfyTitle = isError
        ? (project ? `⚠️ Pi Error — ${project}` : "⚠️ Pi Error")
        : (project ? `Pi — ${project}` : "Pi");
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
    // Register /notify command
    pi.registerCommand("notify", {
        description: "Control notification mode: off, local, ntfy, all",
        getArgumentCompletions(prefix: string) {
            const matches = VALID_MODES.filter((m) => m.startsWith(prefix));
            return matches.map((m) => ({ value: m, label: m, description: MODE_LABELS[m] }));
        },
        async handler(args, ctx) {
            const mode = args.trim() as NotificationMode;

            if (!mode) {
                // No arg — show current mode and usage
                ctx.ui.notify(modeHelpText(), "info");
                return;
            }

            if (!VALID_MODES.includes(mode)) {
                ctx.ui.notify(
                    `Unknown mode "${mode}". Valid: ${VALID_MODES.join(", ")}`,
                    "error",
                );
                return;
            }

            notifyMode = mode;
            ctx.ui.notify(`Notifications: ${MODE_LABELS[mode]}`, "info");
        },
    });

    pi.on("agent_start", async () => {
        agentStartTime = Date.now();
        lastKeepaliveTime = Date.now();
        keepaliveSessionName = pi.getSessionName() ?? undefined;
    });

    pi.on("turn_end", async (event, ctx) => {
        // Only for interactive sessions and when push notifications are enabled
        if (!ctx.hasUI) return;
        const mode = notifyMode;
        if (mode !== "all" && mode !== "ntfy") return;

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

        const keepaliveProject = keepaliveCwd?.split("/").pop() ?? "";
        const keepaliveTitle = keepaliveProject ? `Pi 🏃 — ${keepaliveProject}` : "Pi 🏃";
        notifyNtfy(keepaliveTitle, body, { priority: "min", cwd: keepaliveCwd });
    });

    pi.on("agent_end", async (event, ctx) => {
        // Only notify for interactive sessions (skip print mode / JSON mode)
        if (!ctx.hasUI) return;

        const sessionName = pi.getSessionName();
        const project = ctx.cwd?.split("/").pop() ?? "";
        const title = sessionName
            ? `Pi — ${sessionName}`
            : project
                ? `Pi — ${project}`
                : "Pi";

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
