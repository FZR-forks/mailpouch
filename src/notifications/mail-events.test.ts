import { createHmac, randomBytes } from "crypto";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it, vi } from "vitest";
import type { EmailMessage } from "../types/index.js";
import { MailEvents } from "./mail-events.js";
import { WebhookDispatcher } from "./webhooks.js";

const key = randomBytes(32);
const secret = `whsec_${key.toString("base64")}`;
const url = "https://receiver.example.com/mcp-events/callback_1";

interface Sent { headers: Record<string, string>; body: Record<string, any>; raw: string }

/** A callback that echoes challenges and answers events with `status`. */
function harness(options: { inbox?: EmailMessage[]; mayRead?: boolean; status?: number; echo?: boolean } = {}) {
  const sent: Sent[] = [];
  const state = { inbox: options.inbox ?? [], mayRead: options.mayRead ?? true, status: options.status ?? 202 };
  const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const raw = String(init?.body);
    const body = JSON.parse(raw);
    sent.push({ headers: init?.headers as Record<string, string>, body, raw });
    if (body.type === "verification") {
      return new Response(JSON.stringify({ challenge: options.echo === false ? "wrong" : body.challenge }), { status: 200 });
    }
    return new Response(null, { status: state.status });
  });
  const path = join(mkdtempSync(join(tmpdir(), "mail-events-")), "subs.json");
  const make = () => new MailEvents({
    path,
    readInbox: async () => state.inbox,
    mayRead: () => state.mayRead,
    webhooks: new WebhookDispatcher({ fetcher, resolveHostname: async () => [{ address: "93.184.216.34", family: 4 }] }),
    sleep: async () => {},
  });
  return { sent, state, events: make(), make };
}

const email = (id: string, extra: Partial<EmailMessage> = {}): EmailMessage => ({
  id, from: "Ada <ada@example.com>", to: [], subject: `Subject ${id}`, body: "", bodyPreview: `Body ${id}`,
  isHtml: false, date: new Date(), folder: "INBOX", isRead: false, isStarred: false, hasAttachment: false,
  messageId: `<${id}@example.com>`, ...extra,
});

const subscribe = (events: MailEvents, name: string, args: Record<string, string> = {}) =>
  events.handle("events/subscribe", { name, arguments: args, delivery: { mode: "webhook", url, secret }, cursor: null }, "client-1");

/** Let fire-and-forget deliveries finish. */
const settle = () => new Promise(resolve => setTimeout(resolve, 10));

function signedWithKey(sent: Sent): boolean {
  const { headers, raw } = sent;
  const expected = createHmac("sha256", key)
    .update(`${headers["webhook-id"]}.${headers["webhook-timestamp"]}.${raw}`).digest("base64");
  return headers["webhook-signature"] === `v1,${expected}`;
}

describe("MailEvents", () => {
  it("lists the inbox and reply events for webhook delivery", async () => {
    const { events } = harness();
    const { events: list } = await events.handle("events/list") as { events: Array<Record<string, any>> };
    expect(list.map(e => e.name)).toEqual(["email.received", "email.reply_received"]);
    expect(list.every(e => e.delivery[0] === "webhook")).toBe(true);
    expect(list[1].inputSchema.required).toEqual(["messageId"]);
  });

  it("verifies the callback once and returns a stable subscription", async () => {
    const { events, sent } = harness();
    const first = await subscribe(events, "email.reply_received", { messageId: "<a@example.com>" });
    expect(first).toMatchObject({ id: expect.stringMatching(/^sub_[\w-]+$/), cursor: null, truncated: false });
    expect(Date.parse(String(first.refreshBefore))).toBeGreaterThan(Date.now());
    expect(sent).toHaveLength(1);
    expect(sent[0].body.type).toBe("verification");
    expect(sent[0].headers["X-MCP-Subscription-Id"]).toBe(first.id);
    expect(signedWithKey(sent[0])).toBe(true);

    const refreshed = await subscribe(events, "email.reply_received", { messageId: "<a@example.com>" });
    expect(refreshed.id).toBe(first.id);
    expect(sent).toHaveLength(1);
  });

  it("refuses a callback that does not echo the challenge", async () => {
    const { events } = harness({ echo: false });
    await expect(subscribe(events, "email.received")).rejects.toMatchObject({ code: -32015, data: { reason: "challenge_failed" } });
  });

  it("rejects bad secrets, plain HTTP, unknown events and wrong arguments", async () => {
    const { events } = harness();
    const call = (params: Record<string, unknown>) => events.handle("events/subscribe", {
      name: "email.received", arguments: {}, ...params, delivery: { mode: "webhook", url, secret, ...(params.delivery as object) },
    }, "client-1");
    await expect(call({ delivery: { secret: "whsec_c2hvcnQ=" } })).rejects.toMatchObject({ code: -32602 });
    await expect(call({ delivery: { url: "http://receiver.example.com/x" } })).rejects.toMatchObject({ code: -32602 });
    await expect(call({ name: "email.deleted" })).rejects.toMatchObject({ code: -32602 });
    await expect(call({ arguments: { folder: "Spam" } })).rejects.toMatchObject({ code: -32602 });
    await expect(call({ name: "email.reply_received" })).rejects.toMatchObject({ code: -32602 });
  });

  it("refuses agents that may not read the inbox", async () => {
    const { events } = harness({ mayRead: false });
    await expect(subscribe(events, "email.received")).rejects.toMatchObject({ code: -32024 });
  });

  it("sends new inbox mail, and replies only to the thread they answer", async () => {
    const { events, sent, state } = harness({ inbox: [email("1")] });
    const received = await subscribe(events, "email.received");
    const reply = await subscribe(events, "email.reply_received", { messageId: "sent@example.com" });
    await events.poll(); // baseline: message 1 was already there
    state.inbox = [
      email("3", { references: ["<other@example.com>", "<sent@example.com>"] }),
      email("2"),
      email("1"),
    ];
    await events.poll();
    await settle();

    const deliveries = sent.filter(s => !s.body.type);
    expect(deliveries.map(s => [s.headers["X-MCP-Subscription-Id"], s.body.data.id])).toEqual([
      [received.id, "2"], [received.id, "3"], [reply.id, "3"],
    ]);
    expect(deliveries[0].body).toMatchObject({
      eventId: expect.stringMatching(/^evt_[\w-]+$/), name: "email.received", cursor: null,
      data: { id: "2", messageId: "<2@example.com>", from: "Ada <ada@example.com>", subject: "Subject 2", preview: "Body 2" },
    });
    expect(deliveries[0].headers["webhook-id"]).toBe(deliveries[0].body.eventId);
    expect(deliveries.every(signedWithKey)).toBe(true);

    await events.poll();
    await settle();
    expect(sent.filter(s => !s.body.type)).toHaveLength(3);
  });

  it("does not treat older mail as new when newer mail leaves the inbox", async () => {
    const { events, sent, state } = harness({ inbox: [email("5"), email("4")] });
    await subscribe(events, "email.received");
    await events.poll();
    state.inbox = [email("4"), email("3")]; // 5 archived; 3 slides into the page
    await events.poll();
    await settle();
    expect(sent.filter(s => !s.body.type)).toHaveLength(0);
  });

  it("stops sending once the agent loses access", async () => {
    const { events, sent, state } = harness();
    await subscribe(events, "email.received");
    await events.poll();
    state.mayRead = false;
    state.inbox = [email("1")];
    await events.poll();
    await settle();
    expect(sent.filter(s => !s.body.type)).toHaveLength(0);
  });

  it("keeps subscriptions across restarts until unsubscribed", async () => {
    const { events, make, sent, state } = harness();
    await subscribe(events, "email.received");
    const deliveredAfterRestart = async () => {
      const restarted = make();
      state.inbox = [];
      await restarted.poll();
      state.inbox = [email(String(sent.length))];
      await restarted.poll();
      await settle();
      return restarted;
    };
    const restarted = await deliveredAfterRestart();
    expect(sent.filter(s => !s.body.type)).toHaveLength(1);

    await restarted.handle("events/unsubscribe", {
      name: "email.received", arguments: {}, delivery: { mode: "webhook", url },
    }, "client-1");
    await deliveredAfterRestart();
    expect(sent.filter(s => !s.body.type)).toHaveLength(1);
  });

  it("drops a subscription whose callback answers 410", async () => {
    const { events, state, sent } = harness({ status: 410 });
    await subscribe(events, "email.received");
    await events.poll();
    state.inbox = [email("1")];
    await events.poll();
    await settle();
    state.inbox = [email("2"), email("1")];
    await events.poll();
    await settle();
    expect(sent.filter(s => !s.body.type)).toHaveLength(1);
  });
});
