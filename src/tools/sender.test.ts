import { describe, it, expect, vi } from "vitest";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { resolveSenderAddress, senderPattern, someSenderToolUsable, withSenderAddressHints, SENDER_TOOLS } from "./sender.js";
import * as sending from "./sending.js";
import * as drafts from "./drafts.js";
import type { ToolCallContext, ToolDef, ToolResult } from "./types.js";
import type { SenderAddressLookup } from "../services/bridge-addresses.js";

const ADDRESSES = ["me@proton.me", "work@example.com"];

function ctxWith(from: unknown, lookups: SenderAddressLookup[]): { ctx: ToolCallContext; senderAddresses: ReturnType<typeof vi.fn> } {
  const queue = [...lookups];
  const senderAddresses = vi.fn(async () => queue.length > 1 ? queue.shift()! : queue[0]);
  const ctx = {
    args: { from },
    config: { smtp: { username: "me@proton.me" } },
    senderAddresses,
  } as unknown as ToolCallContext;
  return { ctx, senderAddresses };
}

describe("resolveSenderAddress", () => {
  it("accepts a listed address, a +tag form, and the login without asking Bridge", async () => {
    const ok: SenderAddressLookup = { available: true, addresses: ADDRESSES, splitMode: false };
    expect(await resolveSenderAddress(ctxWith("Work@Example.com", [ok]).ctx)).toBe("Work@Example.com");
    expect(await resolveSenderAddress(ctxWith("work+news@example.com", [ok]).ctx)).toBe("work+news@example.com");
    const login = ctxWith("me@proton.me", [ok]);
    expect(await resolveSenderAddress(login.ctx)).toBe("me@proton.me");
    expect(login.senderAddresses).not.toHaveBeenCalled();
    expect(await resolveSenderAddress(ctxWith(undefined, [ok]).ctx)).toBeUndefined();
  });

  it("rejects an invented address, naming the real ones, after re-checking a fresh list", async () => {
    const ok: SenderAddressLookup = { available: true, addresses: ADDRESSES, splitMode: false };
    const { ctx, senderAddresses } = ctxWith("ceo@proton.me", [ok, ok]);
    const err = await resolveSenderAddress(ctx).catch(e => e);
    expect(err).toBeInstanceOf(McpError);
    expect(String(err.message)).toContain("me@proton.me, work@example.com");
    expect(senderAddresses).toHaveBeenLastCalledWith({ fresh: true });
  });

  it("accepts an address that only the fresh list knows about", async () => {
    const stale: SenderAddressLookup = { available: true, addresses: ADDRESSES, splitMode: false };
    const fresh: SenderAddressLookup = { available: true, addresses: [...ADDRESSES, "new@proton.me"], splitMode: false };
    expect(await resolveSenderAddress(ctxWith("new@proton.me", [stale, fresh]).ctx)).toBe("new@proton.me");
  });

  it("passes any valid address through when Bridge's list is unavailable", async () => {
    const off: SenderAddressLookup = { available: false, reason: "no --grpc" };
    expect(await resolveSenderAddress(ctxWith("other@proton.me", [off]).ctx)).toBe("other@proton.me");
    await expect(resolveSenderAddress(ctxWith("not an email", [off]).ctx)).rejects.toThrow(/valid email/);
  });
});

describe("someSenderToolUsable", () => {
  it("requires the same tool to be both enabled and granted", () => {
    const only = (name: string) => (tool: string) => tool === name;
    expect(someSenderToolUsable(only("send_email"), only("reply_to_email"))).toBe(false);
    expect(someSenderToolUsable(only("send_email"), only("send_email"))).toBe(true);
    expect(someSenderToolUsable(only("schedule_email"))).toBe(true);
    expect(someSenderToolUsable(only("send_test_email"))).toBe(false);
  });
});

describe("withSenderAddressHints", () => {
  const defs: ToolDef[] = [...sending.defs, ...drafts.defs];

  it("adds the addresses as examples and a pattern to every sender tool", () => {
    const out = withSenderAddressHints(defs, ADDRESSES, { login: "me@proton.me", enumerate: true });
    const withFrom = out.filter(d => (d.inputSchema as { properties: Record<string, unknown> }).properties.from);
    expect(withFrom.map(d => d.name).sort()).toEqual([...SENDER_TOOLS].sort());
    for (const def of withFrom) {
      const from = (def.inputSchema as { properties: { from: { examples?: string[]; pattern?: string; description: string } } }).properties.from;
      expect(from.examples).toEqual(ADDRESSES);
      expect(from.pattern).toBe(senderPattern(ADDRESSES));
      expect(from.description).toContain("work@example.com");
    }
    // Other tools and the original definitions are untouched.
    expect(out.find(d => d.name === "send_test_email")).toBe(defs.find(d => d.name === "send_test_email"));
    expect((defs[0].inputSchema as { properties: { from: { pattern?: unknown } } }).properties.from.pattern).toBeUndefined();
  });

  it("builds a Unicode-safe pattern that accepts exactly the forms the server accepts", () => {
    const re = new RegExp(senderPattern(["me@proton.me", "first.last-x@my-domain.example"]), "u");
    for (const ok of ["me@proton.me", "ME@Proton.Me", "me+news@proton.me", "First.Last-X+a.b@My-Domain.example"]) {
      expect(re.test(ok)).toBe(true);
    }
    for (const bad of ["ceo@proton.me", "me@proton.mee", "mex@proton.me", "firstxlast-x@my-domain.example", "me+a@b@proton.me"]) {
      expect(re.test(bad)).toBe(false);
    }
  });

  it("describes without an enum for multi-account setups and always includes the login", () => {
    const out = withSenderAddressHints(defs, ["work@example.com"], { login: "me@proton.me", enumerate: false, accountLabel: "personal" });
    const from = (out.find(d => d.name === "send_email")!.inputSchema as { properties: { from: { pattern?: string; description: string } } }).properties.from;
    expect(from.pattern).toBeUndefined();
    expect(from.description).toContain("me@proton.me, work@example.com");
    expect(from.description).toContain("account personal");
  });
});

describe("sending tools with Bridge's address list", () => {
  const ok: SenderAddressLookup = { available: true, addresses: ["me@proton.me", "alias@example.com"], splitMode: false };
  const actionOk = (messageId?: string): ToolResult => ({ content: [{ type: "text", text: "Done." }], structuredContent: { success: true, messageId } });

  it("send_email refuses an invented sender before contacting SMTP", async () => {
    const sendEmail = vi.fn();
    const ctx = {
      args: { from: "invented@proton.me", to: "a@b.com", subject: "Hi", body: "Hello" },
      config: { smtp: { username: "me@proton.me" } },
      senderAddresses: async () => ok,
      smtpService: { sendEmail },
      actionOk, invalidateAnalytics: () => {}, MAX_SUBJECT_LENGTH: 998, MAX_BODY_LENGTH: 1e6,
    } as unknown as ToolCallContext;
    await expect(sending.handlers.send_email(ctx)).rejects.toThrow(/not a sender address/);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("reply-all leaves every own address out of CC", async () => {
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "<m@x>" });
    const ctx = {
      args: { emailId: "42", body: "Thanks", replyAll: true },
      config: { smtp: { username: "me@proton.me" } },
      senderAddresses: async () => ok,
      getCallerAllowedFolders: () => undefined,
      imapService: {
        getEmailById: async () => ({
          id: "42", from: "Alice <alice@x.com>", to: ["alias+news@example.com", "bob@x.com"], cc: ["ME@proton.me"],
          subject: "Hello", body: "", isHtml: false, date: new Date(), folder: "INBOX",
          isRead: true, isStarred: false, hasAttachment: false,
        }),
        setFlag: vi.fn().mockResolvedValue(true),
      },
      smtpService: { sendEmail },
      actionOk, invalidateAnalytics: () => {}, MAX_SUBJECT_LENGTH: 998, MAX_BODY_LENGTH: 1e6,
    } as unknown as ToolCallContext;
    await sending.handlers.reply_to_email(ctx);
    expect(sendEmail.mock.calls[0][0].cc).toBe("bob@x.com");
  });
});
