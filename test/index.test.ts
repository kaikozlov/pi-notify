import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
    truncate,
    extractAssistantSummary,
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
