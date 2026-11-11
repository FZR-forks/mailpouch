import { afterEach, describe, expect, it, vi } from "vitest";
import { executeMailTool } from "./mail-tool-execution.js";
import { MailboxMutationDeadlineError, runAccountMailMutation } from "./mailbox-mutation-deadline.js";
import { handlers } from "../tools/sending.js";
import type { ToolCallContext, ToolResult } from "../tools/types.js";

const sentId = "<delivered@example.com>";
const privateContent = "private original message content";
const ordinaryResult: ToolResult = { content: [{ type: "text", text: "Sent." }], structuredContent: { success: true, messageId: sentId } };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(tool: string) {
  const smtpScope = {};
  const sendEmail = vi.fn(() => runAccountMailMutation(smtpScope, async () => ({ success: true, messageId: sentId })));
  const setFlag = vi.fn().mockResolvedValue(true);
  const ctx = {
    args: { emailId: "42", folder: "INBOX", to: "recipient@example.com", subject: "New email", body: "Thanks" },
    imapService: {
      getEmailById: vi.fn().mockResolvedValue({
        id: "42", folder: "INBOX", from: "private-sender@example.com", to: ["owner@example.com"],
        subject: privateContent, body: privateContent, date: new Date("2026-01-01"), isHtml: false,
      }),
      setFlag,
    },
    smtpService: { sendEmail, sendTestEmail: sendEmail },
    config: { smtp: { username: "owner@example.com" } },
    getCallerAllowedFolders: () => undefined,
    actionOk: () => ordinaryResult,
    invalidateAnalytics: vi.fn(),
    MAX_SUBJECT_LENGTH: 998,
    MAX_BODY_LENGTH: 10_000,
  } as unknown as ToolCallContext;
  return {
    ctx, sendEmail, setFlag, smtpScope,
    invoke: (recordDelivery: (messageId?: string) => void) => {
      ctx.recordMailDelivery = recordDelivery;
      return handlers[tool](ctx);
    },
  };
}

function expectReceipt(result: ToolResult) {
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toEqual({
    success: true, messageId: sentId,
    reason: "Email delivery completed. Follow-up mailbox checks did not finish. Do not resend this message.",
  });
  expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
  for (const secret of [privateContent, "private-sender@example.com", "recipient@example.com"]) {
    expect(JSON.stringify(result)).not.toContain(secret);
  }
}

afterEach(() => { vi.useRealTimers(); });

describe("mail tool delivery outcomes and final validation", () => {
  it.each(["send_email", "send_test_email", "reply_to_email", "forward_email"])(
    "preserves a content-free %s receipt when final access validation rejects", async tool => {
      const { invoke, sendEmail } = fixture(tool);
      const result = await executeMailTool({ invoke, validate: async () => { throw new Error(privateContent); } });
      expectReceipt(result);
      expect(sendEmail).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps the ordinary response unchanged when all checks succeed", async () => {
    const { invoke } = fixture("reply_to_email");
    expect(await executeMailTool({ invoke, validate: async () => {} })).toBe(ordinaryResult);
  });

  it("never includes a discarded handler result or validation error in a delivery receipt", async () => {
    const result = await executeMailTool({
      invoke: async record => {
        record(sentId);
        return { content: [{ type: "text", text: privateContent }], structuredContent: { body: privateContent } };
      },
      validate: async () => { throw new Error(privateContent); },
    });
    expectReceipt(result);
  });

  it("reports confirmed delivery even if SMTP supplies no Message-ID", async () => {
    const result = await executeMailTool({
      invoke: async record => { record(); throw new Error(privateContent); },
      validate: async () => {},
    });
    expect(result.structuredContent).toMatchObject({ success: true, reason: expect.stringContaining("Do not resend") });
    expect(result.structuredContent).not.toHaveProperty("messageId");
  });

  it("discards read results without treating their Message-ID or success field as proof of delivery", async () => {
    const error = new Error("Mailbox temporarily unavailable");
    await expect(executeMailTool({ invoke: async () => ordinaryResult, validate: async () => { throw error; } })).rejects.toBe(error);
  });

  it("preserves failed and ambiguous send outcomes without creating successful receipts", async () => {
    const { invoke, sendEmail } = fixture("forward_email");
    sendEmail.mockResolvedValueOnce({ success: false, messageId: "" });
    const failed = await executeMailTool({ invoke, validate: async () => {} });
    expect(failed.isError).toBe(true);
    expect(failed.structuredContent).toBeUndefined();
    const ambiguous = new MailboxMutationDeadlineError("forward_email", "client cancellation", true);
    sendEmail.mockRejectedValueOnce(ambiguous);
    await expect(executeMailTool({ invoke, validate: async () => {} })).rejects.toBe(ambiguous);
  });

  it.each(["server deadline", "client cancellation"])("bounds final validation after delivery on %s", async stop => {
    vi.useFakeTimers();
    const { invoke, smtpScope } = fixture("reply_to_email");
    const entered = deferred();
    const validation = deferred();
    const controller = new AbortController();
    const running = executeMailTool({
      invoke,
      validate: async () => { entered.resolve(); await validation.promise; },
      deadline: { tool: "reply_to_email", signal: controller.signal, deadlineAt: Date.now() + 50, transports: [{ scope: smtpScope, abort: vi.fn() }] },
    });
    await entered.promise;
    if (stop === "server deadline") await vi.advanceTimersByTimeAsync(50);
    else controller.abort();
    expectReceipt(await running);
    validation.resolve();
  });

  it("retains delivery confirmation if the best-effort IMAP flag stalls before the handler returns", async () => {
    vi.useFakeTimers();
    const { invoke, smtpScope, setFlag } = fixture("forward_email");
    const entered = deferred();
    const flag = deferred();
    setFlag.mockImplementationOnce(async () => { entered.resolve(); await flag.promise; return true; });
    const running = executeMailTool({
      invoke, validate: async () => {},
      deadline: { tool: "forward_email", signal: new AbortController().signal, deadlineAt: Date.now() + 50, transports: [{ scope: smtpScope, abort: vi.fn() }] },
    });
    await entered.promise;
    await vi.advanceTimersByTimeAsync(50);
    expectReceipt(await running);
    flag.resolve();
  });

  it("keeps the final validation inside the deadline for mutations without a delivery receipt", async () => {
    vi.useFakeTimers();
    const scope = {};
    const entered = deferred();
    const validation = deferred();
    const running = executeMailTool({
      invoke: async () => runAccountMailMutation(scope, async () => ordinaryResult),
      validate: async () => { entered.resolve(); await validation.promise; },
      deadline: { tool: "star_email", signal: new AbortController().signal, deadlineAt: Date.now() + 50, transports: [{ scope, abort: vi.fn() }] },
    }).catch((error: unknown) => error);
    await entered.promise;
    await vi.advanceTimersByTimeAsync(50);
    const error = await running;
    expect(error).toBeInstanceOf(MailboxMutationDeadlineError);
    expect((error as MailboxMutationDeadlineError).outcomeUnknown).toBe(true);
    expect((error as Error).message).toContain("inspect the mailbox before retrying");
    validation.resolve();
  });
});
