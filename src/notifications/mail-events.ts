/**
 * MCP Events over webhooks, as ChatGPT implements them
 * (https://developers.openai.com/plugins/build/mcp-events).
 *
 * Two events: `email.received` for any new Inbox message the agent may read,
 * and `email.reply_received` for a new Inbox message in the thread of a given
 * Message-ID. The Inbox is polled while subscriptions exist. Events are not
 * replayable, so every cursor is null. Subscriptions persist across restarts
 * until they expire.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import { existsSync, readFileSync } from "fs";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { EmailMessage } from "../types/index.js";
import { writeOwnerOnlyJsonAtomically } from "../utils/atomic-json.js";
import { logger } from "../utils/logger.js";
import { WebhookDispatcher } from "./webhooks.js";

const DAY_MS = 86_400_000;
const MIN_TTL_MS = 60_000;
const POLL_MS = 30_000;
const RETRY_DELAYS_MS = [10_000, 60_000, 300_000];
const FORBIDDEN = -32024;
const CALLBACK_ENDPOINT_ERROR = -32015;

type Args = Record<string, string>;

/** Bare Message-ID, without angle brackets. */
const bare = (id: string) => id.trim().replace(/^<|>$/g, "");

const EVENTS: Record<string, {
  description: string;
  /** Required string arguments and their descriptions. */
  args: Args;
  matches: (email: EmailMessage, args: Args) => boolean;
}> = {
  "email.received": {
    description: "A new email arrived in the inbox.",
    args: {},
    matches: () => true,
  },
  "email.reply_received": {
    description: "A reply arrived in the thread of the given email.",
    args: { messageId: "Message-ID of the email to watch, as send_email or reply_to_email return it." },
    matches: (email, args) =>
      [email.inReplyTo, ...(email.references ?? [])].some(id => id !== undefined && bare(id) === bare(args.messageId)),
  },
};

const payloadSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "Inbox email ID, for get_email_by_id." },
    messageId: { type: "string", description: "RFC 5322 Message-ID." },
    from: { type: "string" },
    subject: { type: "string" },
    preview: { type: "string", description: "Start of the body text." },
  },
  required: ["id", "from", "subject", "preview"],
  additionalProperties: false,
};

interface Subscription {
  id: string;
  clientId: string;
  name: string;
  args: Args;
  url: string;
  secret: string;
  expiresAt: number;
}

export interface MailEventsDeps {
  /** File that keeps subscriptions across restarts. */
  path: string;
  /** The newest Inbox messages agents may see, newest first. */
  readInbox: () => Promise<EmailMessage[]>;
  /** Whether the OAuth client may read the Inbox right now. */
  mayRead: (clientId: string) => boolean;
  webhooks?: WebhookDispatcher;
  sleep?: (ms: number) => Promise<void>;
}

const invalid = (message: string) => new McpError(ErrorCode.InvalidParams, message);
const digest = (...parts: string[]) => createHash("sha256").update(parts.join("\n")).digest("base64url").slice(0, 22);
const emailKey = (email: EmailMessage) => email.messageId ?? `uid:${email.id}`;

function validSecret(secret: unknown): secret is string {
  if (typeof secret !== "string" || !secret.startsWith("whsec_")) return false;
  const encoded = secret.slice("whsec_".length);
  const key = Buffer.from(encoded, "base64");
  return key.toString("base64") === encoded && key.length >= 24 && key.length <= 64;
}

function validUrl(url: unknown): url is string {
  try {
    const parsed = new URL(String(url));
    return parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.hash;
  } catch {
    return false;
  }
}

function sameText(a: unknown, b: string): boolean {
  const left = Buffer.from(String(a));
  const right = Buffer.from(b);
  return typeof a === "string" && left.length === right.length && timingSafeEqual(left, right);
}

export class MailEvents {
  private readonly subs = new Map<string, Subscription>();
  /** Callback URLs verified per client, until the stored time. */
  private readonly verified = new Map<string, number>();
  /** Highest Inbox UID already handled; unset until the first poll takes a baseline. */
  private lastUid?: number;
  private polling = false;
  private timer?: ReturnType<typeof setInterval>;
  private readonly webhooks: WebhookDispatcher;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: MailEventsDeps) {
    this.webhooks = deps.webhooks ?? new WebhookDispatcher();
    this.sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    if (!existsSync(deps.path)) return;
    try {
      for (const sub of JSON.parse(readFileSync(deps.path, "utf-8")) as Subscription[]) this.subs.set(sub.id, sub);
    } catch (err) {
      logger.warn("Could not read MCP event subscriptions", "MailEvents", err);
    }
  }

  start(): void {
    this.timer ??= setInterval(() => void this.poll(), POLL_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Answer an `events/*` request from an authenticated OAuth client. */
  async handle(method: string, params: Record<string, unknown> = {}, clientId?: string): Promise<Record<string, unknown>> {
    if (method === "events/list") return { events: Object.entries(EVENTS).map(([name, event]) => this.describe(name, event)) };
    if (method !== "events/subscribe" && method !== "events/unsubscribe") {
      throw new McpError(ErrorCode.MethodNotFound, `Method not found: ${method}`);
    }
    if (!clientId) throw new McpError(FORBIDDEN, "Events need an OAuth client");
    const { name, args } = this.eventOf(params);
    const delivery = (params.delivery ?? {}) as Record<string, unknown>;
    if (delivery.mode !== "webhook" || !validUrl(delivery.url)) {
      throw invalid("delivery must be a webhook with an https URL");
    }
    const id = `sub_${digest(clientId, delivery.url, name, JSON.stringify(Object.entries(args).sort()))}`;
    if (method === "events/unsubscribe") {
      if (this.subs.delete(id)) this.save();
      return {};
    }
    if (!validSecret(delivery.secret)) throw invalid("delivery.secret must be whsec_ and base64 of 24 to 64 bytes");
    if (!this.deps.mayRead(clientId)) throw new McpError(FORBIDDEN, "This agent may not read the inbox");
    const ttlMs = typeof params.ttlMs === "number" ? Math.max(Math.min(params.ttlMs, DAY_MS), MIN_TTL_MS) : DAY_MS;
    const sub: Subscription = { id, clientId, name, args, url: delivery.url, secret: delivery.secret, expiresAt: Date.now() + ttlMs };
    await this.verify(sub);
    this.subs.set(id, sub);
    this.save();
    // Take the Inbox baseline now, so mail arriving from here on counts as new.
    if (this.lastUid === undefined) void this.poll();
    return { id, refreshBefore: new Date(sub.expiresAt).toISOString(), cursor: null, truncated: false };
  }

  /** Check the Inbox once and send each new message to the subscriptions it matches. */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const now = Date.now();
      const expired = [...this.subs.values()].filter(sub => sub.expiresAt <= now);
      for (const sub of expired) this.subs.delete(sub.id);
      if (expired.length) this.save();
      if (!this.subs.size) {
        this.lastUid = undefined;
        return;
      }
      // UIDs only grow, so mail moved out of the Inbox never makes older mail look new.
      const emails = await this.deps.readInbox();
      const last = this.lastUid;
      const fresh = last === undefined ? [] : emails.filter(email => Number(email.id) > last);
      this.lastUid = Math.max(last ?? 0, ...emails.map(email => Number(email.id)));
      for (const email of fresh.reverse()) {
        for (const sub of this.subs.values()) {
          if (EVENTS[sub.name]?.matches(email, sub.args) && this.deps.mayRead(sub.clientId)) void this.deliver(sub.id, email);
        }
      }
    } catch (err) {
      logger.debug("Inbox check for MCP events failed", "MailEvents", err);
    } finally {
      this.polling = false;
    }
  }

  private describe(name: string, event: (typeof EVENTS)[string]) {
    return {
      name,
      description: event.description,
      delivery: ["webhook"],
      inputSchema: {
        type: "object",
        properties: Object.fromEntries(Object.entries(event.args).map(([key, description]) => [key, { type: "string", description }])),
        required: Object.keys(event.args),
        additionalProperties: false,
      },
      payloadSchema,
    };
  }

  private eventOf(params: Record<string, unknown>): { name: string; args: Args } {
    const name = String(params.name);
    const event = Object.hasOwn(EVENTS, name) ? EVENTS[name] : undefined;
    if (!event) throw invalid(`Unknown event: ${name}`);
    const args = (params.arguments ?? {}) as Args;
    const keys = Object.keys(event.args);
    if (typeof args !== "object" || Object.keys(args).sort().join() !== keys.sort().join()
      || keys.some(key => typeof args[key] !== "string" || !args[key].trim())) {
      throw invalid(`${name} takes ${keys.length ? keys.join(", ") : "no arguments"}`);
    }
    return { name, args };
  }

  /** Send a signed challenge; the callback must echo it before it gets events. */
  private async verify(sub: Subscription): Promise<void> {
    const cacheKey = `${sub.clientId} ${sub.url}`;
    if ((this.verified.get(cacheKey) ?? 0) > Date.now()) return;
    const challenge = randomBytes(24).toString("base64url");
    let reason = "challenge_failed";
    try {
      const res = await this.post(sub, `msg_${randomBytes(12).toString("base64url")}`, JSON.stringify({ type: "verification", challenge }), 4096);
      let echoed: unknown;
      try { echoed = (JSON.parse(res.body) as { challenge?: unknown }).challenge; } catch { /* not JSON */ }
      if (res.ok && sameText(echoed, challenge)) {
        this.verified.set(cacheKey, Date.now() + DAY_MS);
        return;
      }
      if (!res.ok) reason = `http_${res.status}`;
    } catch (err) {
      reason = (err as Error).message === "attempt_timeout" ? "timeout" : "unreachable";
    }
    throw new McpError(CALLBACK_ENDPOINT_ERROR, "Callback verification failed", { reason });
  }

  private async deliver(subId: string, email: EmailMessage): Promise<void> {
    const initial = this.subs.get(subId)!;
    const eventId = `evt_${digest(subId, emailKey(email))}`;
    const body = JSON.stringify({
      eventId,
      name: initial.name,
      timestamp: new Date().toISOString(),
      data: { id: email.id, messageId: email.messageId, from: email.from, subject: email.subject, preview: email.bodyPreview ?? "" },
      cursor: null,
    });
    for (let attempt = 0; ; attempt++) {
      // Refreshes may change the secret; an unsubscribe, expiry or lost access ends the retries.
      const sub = this.subs.get(subId);
      if (!sub || sub.expiresAt <= Date.now() || !this.deps.mayRead(sub.clientId)) return;
      const status = await this.post(sub, eventId, body).then(res => res.status, () => 0);
      if (status >= 200 && status < 300) return;
      if (status === 410) {
        this.subs.delete(subId);
        this.save();
        return;
      }
      const permanent = status >= 400 && status < 500 && status !== 408 && status !== 429;
      if (permanent || attempt >= RETRY_DELAYS_MS.length) {
        logger.warn(`MCP event ${eventId} was not delivered (last status ${status || "none"})`, "MailEvents");
        return;
      }
      await this.sleep(RETRY_DELAYS_MS[attempt]);
    }
  }

  /** POST with Standard Webhooks signing headers. */
  private post(sub: Subscription, webhookId: string, body: string, maxResponseBytes = 0) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const key = Buffer.from(sub.secret.slice("whsec_".length), "base64");
    const signature = createHmac("sha256", key).update(`${webhookId}.${timestamp}.${body}`).digest("base64");
    return this.webhooks.post(sub.url, {
      "Content-Type": "application/json",
      "webhook-id": webhookId,
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${signature}`,
      "X-MCP-Subscription-Id": sub.id,
    }, body, maxResponseBytes);
  }

  private save(): void {
    try {
      writeOwnerOnlyJsonAtomically(this.deps.path, [...this.subs.values()]);
    } catch (err) {
      logger.warn("Could not save MCP event subscriptions", "MailEvents", err);
    }
  }
}
