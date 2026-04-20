import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
    truncate,
    extractAssistantSummary,
    extractToolSummary,
    mapStopReasonToPriority,
    formatElapsed,
    resolveClickUrl,
    buildNtfyActions,
    shouldSendKeepalive,
    buildNtfyBody,
    formatUsage,
    wrapForTmux,
    notify,
    type AssistantMessage,
    type AgentMessage,
} from "../index.js";

// --- truncate ---

describe("truncate", () => {
    it("returns the string unchanged when under the limit", () => {
        assert.equal(truncate("hello", 10), "hello");
    });

    it("returns the string unchanged when at the limit", () => {
        assert.equal(truncate("hello", 5), "hello");
    });

    it("truncates and appends ellipsis", () => {
        assert.equal(truncate("hello world", 8), "hello w…");
    });

    it("handles empty string", () => {
        assert.equal(truncate("", 5), "");
    });
});

// --- wrapForTmux ---

describe("wrapForTmux", () => {
    it("returns sequence unchanged when TMUX is not set", () => {
        delete process.env.TMUX;
        const seq = "\x1b]777;notify;title;body\x07";
        assert.equal(wrapForTmux(seq), seq);
    });

    it("wraps sequence in tmux DCS passthrough when TMUX is set", () => {
        process.env.TMUX = "/tmp/tmux-100/default,1234,0";
        const seq = "\x1b]777;notify;title;body\x07";
        const result = wrapForTmux(seq);
        // Should start with DCS tmux; and end with ST
        assert.ok(result.startsWith("\x1bPtmux;"), "should start with DCS tmux;");
        assert.ok(result.endsWith("\x1b\\"), "should end with ST");
    });
});

// --- extractAssistantSummary ---

describe("extractAssistantSummary", () => {
    it("returns fallback when no assistant messages", () => {
        assert.equal(extractAssistantSummary([]), "Ready for input");
    });

    it("returns fallback when assistant has no text content", () => {
        const msgs: AgentMessage[] = [
            {
                role: "assistant",
                content: [{ type: "toolCall", toolName: "bash" }],
            },
        ];
        assert.equal(extractAssistantSummary(msgs), "Ready for input");
    });

    it("extracts text from the last assistant message", () => {
        const msgs: AgentMessage[] = [
            {
                role: "assistant",
                content: [{ type: "text", text: "First response" }],
            } as AssistantMessage,
            {
                role: "assistant",
                content: [{ type: "text", text: "Second response" }],
            } as AssistantMessage,
        ];
        assert.equal(extractAssistantSummary(msgs), "Second response");
    });

    it("truncates long text", () => {
        const longText = "a".repeat(300);
        const msgs: AgentMessage[] = [
            {
                role: "assistant",
                content: [{ type: "text", text: longText }],
            } as AssistantMessage,
        ];
        assert.equal(extractAssistantSummary(msgs), "a".repeat(199) + "…");
    });

    it("skips empty text blocks and uses the first non-empty one", () => {
        const msgs: AgentMessage[] = [
            {
                role: "assistant",
                content: [
                    { type: "text", text: "  " },
                    { type: "text", text: "meaningful content" },
                ],
            } as unknown as AgentMessage,
        ];
        assert.equal(extractAssistantSummary(msgs), "meaningful content");
    });
});

// --- extractToolSummary ---

describe("extractToolSummary", () => {
    it("returns empty string when no tool calls", () => {
        assert.equal(extractToolSummary([]), "");
    });

    it("returns empty string when assistant has only text", () => {
        const msgs: AgentMessage[] = [
            { role: "assistant", content: [{ type: "text", text: "hello" }] },
        ];
        assert.equal(extractToolSummary(msgs), "");
    });

    it("tallies tool calls across multiple messages", () => {
        const msgs: AgentMessage[] = [
            {
                role: "assistant",
                content: [
                    { type: "toolCall", id: "1", name: "bash", arguments: {} },
                    { type: "toolCall", id: "2", name: "read", arguments: {} },
                ],
            },
            {
                role: "assistant",
                content: [
                    { type: "toolCall", id: "3", name: "bash", arguments: {} },
                    { type: "toolCall", id: "4", name: "edit", arguments: {} },
                ],
            },
        ];
        const result = extractToolSummary(msgs);
        assert.equal(result, "🔧 bash(2) edit(1) read(1)");
    });

    it("sorts by count descending then alphabetically", () => {
        const msgs: AgentMessage[] = [
            {
                role: "assistant",
                content: [
                    { type: "toolCall", id: "1", name: "read", arguments: {} },
                    { type: "toolCall", id: "2", name: "read", arguments: {} },
                    { type: "toolCall", id: "3", name: "bash", arguments: {} },
                    { type: "toolCall", id: "4", name: "bash", arguments: {} },
                ],
            },
        ];
        const result = extractToolSummary(msgs);
        assert.equal(result, "🔧 bash(2) read(2)");
    });
});

// --- mapStopReasonToPriority ---

describe("mapStopReasonToPriority", () => {
    it("maps stop to default", () => {
        assert.equal(mapStopReasonToPriority("stop"), "default");
    });

    it("maps toolUse to high", () => {
        assert.equal(mapStopReasonToPriority("toolUse"), "high");
    });

    it("maps length to high", () => {
        assert.equal(mapStopReasonToPriority("length"), "high");
    });

    it("maps error to urgent", () => {
        assert.equal(mapStopReasonToPriority("error"), "urgent");
    });

    it("maps aborted to min", () => {
        assert.equal(mapStopReasonToPriority("aborted"), "min");
    });

    it("maps unknown to default", () => {
        assert.equal(mapStopReasonToPriority("unknown"), "default");
    });
});

// --- formatElapsed ---

describe("formatElapsed", () => {
    it("formats seconds only", () => {
        assert.equal(formatElapsed(5000), "⏱ Completed in 5s");
    });

    it("formats minutes and seconds", () => {
        assert.equal(formatElapsed(154000), "⏱ Completed in 2m 34s");
    });

    it("formats hours, minutes, and seconds", () => {
        assert.equal(formatElapsed(3723000), "⏱ Completed in 1h 2m 3s");
    });

    it("shows 0m when only hours present", () => {
        assert.equal(formatElapsed(3600000), "⏱ Completed in 1h 0m 0s");
    });

    it("formats sub-second as 0s", () => {
        assert.equal(formatElapsed(500), "⏱ Completed in 0s");
    });
});

// --- resolveClickUrl ---

describe("resolveClickUrl", () => {
    beforeEach(() => {
        delete process.env.PI_NOTIFY_NTFY_CLICK;
        delete process.env.PI_NOTIFY_NTFY_CLICK_SCHEME;
    });

    it("returns undefined when nothing configured", () => {
        assert.equal(resolveClickUrl("/home/user/project"), undefined);
    });

    it("returns explicit PI_NOTIFY_NTFY_CLICK when set", () => {
        process.env.PI_NOTIFY_NTFY_CLICK = "https://example.com";
        assert.equal(resolveClickUrl("/home/user/project"), "https://example.com");
    });

    it("generates vscode URI from scheme", () => {
        process.env.PI_NOTIFY_NTFY_CLICK_SCHEME = "vscode";
        assert.equal(resolveClickUrl("/home/user/project"), "vscode://file//home/user/project");
    });

    it("generates cursor URI from scheme", () => {
        process.env.PI_NOTIFY_NTFY_CLICK_SCHEME = "cursor";
        assert.equal(resolveClickUrl("/home/user/project"), "cursor://file//home/user/project");
    });

    it("generates zed URI from scheme", () => {
        process.env.PI_NOTIFY_NTFY_CLICK_SCHEME = "zed";
        assert.equal(resolveClickUrl("/home/user/project"), "zed://file/home/user/project");
    });

    it("resolves {cwd} in custom template", () => {
        process.env.PI_NOTIFY_NTFY_CLICK_SCHEME = "myapp://open?path={cwd}";
        assert.equal(resolveClickUrl("/home/user/project"), "myapp://open?path=/home/user/project");
    });

    it("prefers explicit CLICK over scheme", () => {
        process.env.PI_NOTIFY_NTFY_CLICK = "https://example.com";
        process.env.PI_NOTIFY_NTFY_CLICK_SCHEME = "vscode";
        assert.equal(resolveClickUrl("/home/user/project"), "https://example.com");
    });

    it("returns undefined when scheme set but no cwd", () => {
        process.env.PI_NOTIFY_NTFY_CLICK_SCHEME = "vscode";
        assert.equal(resolveClickUrl(), undefined);
    });
});

// --- buildNtfyActions ---

describe("buildNtfyActions", () => {
    beforeEach(() => {
        delete process.env.PI_NOTIFY_NTFY_CLICK;
        delete process.env.PI_NOTIFY_NTFY_CLICK_SCHEME;
    });

    it("returns undefined when nothing configured", () => {
        assert.equal(buildNtfyActions("/home/user/project"), undefined);
    });

    it("returns single action for explicit click URL", () => {
        process.env.PI_NOTIFY_NTFY_CLICK = "https://example.com";
        const actions = buildNtfyActions();
        assert.deepEqual(JSON.parse(actions!), [
            { action: "view", label: "Open in IDE", url: "https://example.com" },
        ]);
    });

    it("returns two actions for vscode scheme with cwd", () => {
        process.env.PI_NOTIFY_NTFY_CLICK_SCHEME = "vscode";
        const actions = buildNtfyActions("/home/user/project");
        const parsed = JSON.parse(actions!);
        assert.equal(parsed.length, 2);
        assert.equal(parsed[0].label, "Open in IDE");
        assert.equal(parsed[0].url, "vscode://file//home/user/project");
        assert.equal(parsed[1].label, "View Changes");
        assert.equal(parsed[1].url, "vscode://vscode.scm");
    });

    it("returns single action for zed scheme (no SCM URL)", () => {
        process.env.PI_NOTIFY_NTFY_CLICK_SCHEME = "zed";
        const actions = buildNtfyActions("/home/user/project");
        const parsed = JSON.parse(actions!);
        assert.equal(parsed.length, 1);
        assert.equal(parsed[0].url, "zed://file/home/user/project");
    });

    it("returns undefined when scheme set but no cwd", () => {
        process.env.PI_NOTIFY_NTFY_CLICK_SCHEME = "vscode";
        assert.equal(buildNtfyActions(), undefined);
    });
});

// --- shouldSendKeepalive ---

describe("shouldSendKeepalive", () => {
    it("returns false when interval is zero", () => {
        assert.equal(shouldSendKeepalive(10000, 0, 0), false);
    });

    it("returns false when interval is negative", () => {
        assert.equal(shouldSendKeepalive(10000, 0, -1), false);
    });

    it("returns false when lastTime is undefined", () => {
        assert.equal(shouldSendKeepalive(10000, undefined, 5000), false);
    });

    it("returns false when not enough time elapsed", () => {
        assert.equal(shouldSendKeepalive(10000, 6000, 5000), false);
    });

    it("returns true when enough time has elapsed", () => {
        assert.equal(shouldSendKeepalive(10000, 4000, 5000), true);
    });

    it("returns true when exactly at interval", () => {
        assert.equal(shouldSendKeepalive(10000, 5000, 5000), true);
    });
});

// --- formatUsage ---

describe("formatUsage", () => {
    it("formats tokens only when no cost", () => {
        assert.equal(
            formatUsage({ input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150 }),
            "⚙️ 150 tokens",
        );
    });

    it("formats tokens with cost", () => {
        assert.equal(
            formatUsage({ input: 1000, output: 247, cacheRead: 0, cacheWrite: 0, totalTokens: 1247, cost: { total: 0.003 } }),
            "⚙️ 1,247 tokens • $0.003",
        );
    });

    it("formats cost with more decimals for tiny amounts", () => {
        assert.equal(
            formatUsage({ input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { total: 0.0012 } }),
            "⚙️ 110 tokens • $0.0012",
        );
    });

    it("omits cost when zero", () => {
        assert.equal(
            formatUsage({ input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { total: 0 } }),
            "⚙️ 110 tokens",
        );
    });
});

// --- buildNtfyBody ---

describe("buildNtfyBody", () => {
    it("returns just summary when no options", () => {
        assert.equal(buildNtfyBody("Task complete"), "Task complete");
    });

    it("includes bold session name with summary", () => {
        const body = buildNtfyBody("Done refactoring", { sessionName: "Refactor auth" });
        assert.equal(body, "**Refactor auth**\n\nDone refactoring");
    });

    it("handles empty session name", () => {
        assert.equal(buildNtfyBody("Summary text", { sessionName: "" }), "Summary text");
    });

    it("includes usage line", () => {
        const body = buildNtfyBody("Done", {
            usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150 },
        });
        assert.equal(body, "Done\n\n⚙️ 150 tokens");
    });

    it("includes session name and usage together", () => {
        const body = buildNtfyBody("Done", {
            sessionName: "Refactor",
            usage: { input: 1000, output: 247, cacheRead: 0, cacheWrite: 0, totalTokens: 1247, cost: { total: 0.003 } },
        });
        assert.equal(body, "**Refactor**\n\nDone\n\n⚙️ 1,247 tokens • $0.003");
    });

    it("includes tool summary", () => {
        const body = buildNtfyBody("Done", {
            toolSummary: "🔧 bash(2) edit(1)",
        });
        assert.equal(body, "Done\n\n🔧 bash(2) edit(1)");
    });

    it("includes all metadata together", () => {
        const body = buildNtfyBody("Done", {
            sessionName: "Refactor",
            usage: { input: 1000, output: 247, cacheRead: 0, cacheWrite: 0, totalTokens: 1247, cost: { total: 0.003 } },
            toolSummary: "🔧 bash(2) edit(1)",
            elapsedMs: 154000,
        });
        assert.equal(body, "**Refactor**\n\nDone\n\n⚙️ 1,247 tokens • $0.003\n\n🔧 bash(2) edit(1)\n\n⏱ Completed in 2m 34s");
    });

    it("includes error message when present", () => {
        const body = buildNtfyBody("Failed", {
            errorMessage: "Rate limit exceeded",
        });
        assert.equal(body, "Failed\n\n⚠️ Rate limit exceeded");
    });
});

// --- notify ---

describe("notify", () => {
    beforeEach(() => {
        delete process.env.WT_SESSION;
        delete process.env.KITTY_WINDOW_ID;
        delete process.env.TERM_PROGRAM;
        delete process.env.ITERM_SESSION_ID;
        delete process.env.TMUX;
        delete process.env.PI_NOTIFY_NTFY;
        delete process.env.PI_NOTIFY_SOUND_CMD;
    });

    it("writes OSC 777 by default", (t) => {
        const written: string[] = [];
        const orig = process.stdout.write;
        process.stdout.write = (chunk: string) => { written.push(chunk); return true; };
        try {
            notify("Title", "Body");
            assert.ok(written.some((s) => s.includes("]777;")), "should write OSC 777");
        } finally {
            process.stdout.write = orig;
        }
    });

    it("writes OSC 9 for iTerm2", () => {
        process.env.TERM_PROGRAM = "iTerm.app";
        const written: string[] = [];
        const orig = process.stdout.write;
        process.stdout.write = (chunk: string) => { written.push(chunk); return true; };
        try {
            notify("Title", "Body");
            assert.ok(written.some((s) => s.includes("]9;")), "should write OSC 9");
        } finally {
            process.stdout.write = orig;
        }
    });

    it("writes OSC 99 for Kitty", () => {
        process.env.KITTY_WINDOW_ID = "1";
        const written: string[] = [];
        const orig = process.stdout.write;
        process.stdout.write = (chunk: string) => { written.push(chunk); return true; };
        try {
            notify("Title", "Body");
            assert.ok(written.some((s) => s.includes("]99;")), "should write OSC 99");
        } finally {
            process.stdout.write = orig;
        }
    });
});
