import { withBackgroundAccountMailMutation } from "./mailbox-mutation-deadline.js";
/** Durable post-SMTP work. Retrying this queue never sends mail. */
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { SimpleIMAPService } from "./simple-imap-service.js";
import { withFileLock } from "../utils/file-lock.js";
import { accessLabelFolder } from "../security/label-access.js";
import { logger } from "../utils/logger.js";

/**
 * Legacy jobs omit createdAt until their first reconciliation after upgrade.
 * `mailbox: "drafts"` marks an agent-saved draft; absent means a sent message.
 */
interface LabelJob { messageId: string; folder: string; mailbox?: "drafts"; createdAt?: number; needsAttentionAt?: number }
const MAX_JOB_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** A draft the owner deleted before labeling is not an operator problem; stop looking after a day. */
const MAX_DRAFT_JOB_AGE_MS = 24 * 60 * 60 * 1000;
export interface OutgoingLabeler {
  /** Queue labeling with `folder`; returns false (no labeling) unless it is still the active access label. */
  prepare(messageId: string, folder: string, mailbox?: "drafts"): Promise<boolean>;
  discard(messageId: string): void;
  stop(): void;
}

export class OutgoingLabelQueue implements OutgoingLabeler {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private stopped = false;
  /** Resume persisted account-owned labeling work without dispatching SMTP deliveries. */
  constructor(
    private readonly path: string,
    private readonly imap: SimpleIMAPService,
    private readonly getLabel: () => unknown,
    private readonly connect: () => Promise<void>,
  ) {
    if (existsSync(path)) this.start();
  }

  /** Validate persisted jobs without silently dropping malformed authorization data. */
  private read(): LabelJob[] {
    if (!existsSync(this.path)) return [];
    const jobs: unknown = JSON.parse(readFileSync(this.path, "utf8"));
    if (!Array.isArray(jobs) || !jobs.every(j => j && typeof j.messageId === "string"
      && /^<[a-f0-9-]+@[a-zA-Z0-9.-]+>$/.test(j.messageId)
      && typeof j.folder === "string" && accessLabelFolder(j.folder.slice(7)) === j.folder
      && (j.mailbox === undefined || j.mailbox === "drafts")
      && (j.createdAt === undefined || (typeof j.createdAt === "number" && Number.isFinite(j.createdAt) && j.createdAt >= 0))
      && (j.needsAttentionAt === undefined || (typeof j.needsAttentionAt === "number" && Number.isFinite(j.needsAttentionAt) && j.needsAttentionAt >= 0)))) {
      throw new Error("Invalid outgoing label queue; sending blocked until repaired.");
    }
    return jobs;
  }

  /** Atomically update the queue while preserving other processes' changes. */
  private update(change: (jobs: LabelJob[]) => LabelJob[]): void {
    withFileLock(this.path, () => {
      const jobs = change(this.read());
      const temp = `${this.path}.${randomUUID()}.tmp`;
      writeFileSync(temp, JSON.stringify(jobs), { mode: 0o600 });
      renameSync(temp, this.path);
    });
  }

  /** Preflight the label and durably queue its Message-ID before SMTP dispatch. */
  async prepare(messageId: string, folder: string, mailbox?: "drafts"): Promise<boolean> {
    // A request authorized under an earlier policy must not label with a stale one.
    if (accessLabelFolder(this.getLabel()) !== folder) return false;
    if (this.stopped) throw new Error("Outgoing label queue is retired.");
    await this.connect();
    const folders = await this.imap.syncFolders();
    if (!folders.some(f => f.path === folder)) {
      logger.error("Configured AI access label is missing; create it in Proton before sending", "OutgoingLabels");
      throw new Error("Mailbox unavailable. Ask the account owner to check mail settings.");
    }
    if (this.stopped) throw new Error("Outgoing label queue is retired.");
    this.update(jobs => {
      if (jobs.filter(job => job.needsAttentionAt === undefined).length >= 10_000) throw new Error("Outgoing label queue is full; resolve labeling failures before sending.");
      return [...jobs, { messageId, folder, ...(mailbox ? { mailbox } : {}), createdAt: Date.now() }];
    });
    this.start();
    return true;
  }

  /** Forget only attempts whose SMTP response definitively rejected delivery. */
  discard(messageId: string): void {
    this.update(jobs => jobs.filter(job => job.messageId !== messageId));
  }

  /** Run one reconciliation pass now, e.g. right after saving a draft. */
  async processNow(): Promise<void> {
    await this.processPending();
  }

  /** Reconcile in the background without keeping a shutting-down process alive. */
  private start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => { void this.processPending().catch(error => {
      logger.warn("Outgoing labeling pending; will retry without resending", "OutgoingLabels", error);
    }); }, 10_000);
    this.timer.unref();
  }

  /** Reconcile jobs independently and retain overdue work for operator recovery after 30 days. */
  async processPending(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      const now = Date.now();
      let jobs = this.read();
      // Retain old attempts for operator recovery instead of silently dropping
      // labeling work. Retired records no longer retry or consume active capacity.
      const draftExpired = (job: LabelJob) => job.mailbox === "drafts" && job.createdAt !== undefined
        && now - job.createdAt >= MAX_DRAFT_JOB_AGE_MS;
      if (jobs.some(draftExpired)) {
        logger.warn("Dropped labeling for agent drafts that no longer exist", "OutgoingLabels");
        this.update(current => current.filter(job => !draftExpired(job)));
        jobs = this.read();
      }
      if (jobs.some(job => job.needsAttentionAt === undefined
          && (job.createdAt === undefined || now - job.createdAt >= MAX_JOB_AGE_MS))) {
        const retired: string[] = [];
        this.update(current => current.map(job => {
          if (job.needsAttentionAt !== undefined) return job;
          const createdAt = job.createdAt ?? now;
          if (now - createdAt >= MAX_JOB_AGE_MS) {
            retired.push(job.messageId);
            return { ...job, createdAt, needsAttentionAt: now };
          }
          return { ...job, createdAt };
        }));
        if (retired.length) logger.error(
          `Outgoing labeling needs operator attention for ${retired.length} expired job(s); records retained in ${this.path}`,
          "OutgoingLabels",
        );
        jobs = this.read();
      }
      const pending = jobs.filter(job => job.needsAttentionAt === undefined);
      if (!pending.length) return;
      await this.connect();
      const folders = await this.imap.syncFolders();
      const sent = folders.find(f => f.specialUse === "\\Sent")?.path
        ?? folders.find(f => f.path === "Sent")?.path;
      if (!sent) throw new Error("Cannot resolve the Sent mailbox for outgoing labels.");
      const drafts = folders.find(f => f.specialUse === "\\Drafts")?.path
        ?? folders.find(f => f.path === "Drafts")?.path;
      let firstFailure: { error: unknown } | undefined;
      for (const job of pending) {
        if (this.stopped) return;
        try {
          // A draft may already have been sent from Proton; then its copy is in Sent.
          const sources = job.mailbox === "drafts" ? [...(drafts ? [drafts] : []), sent] : [sent];
          await this.processJob(job, sources);
        } catch (error) {
          firstFailure ??= { error };
        }
      }
      if (firstFailure) throw firstFailure.error;
    } finally { this.running = false; }
  }

  /** Resolve one exact queued message; missing or unconfirmed copies remain queued. */
  private async processJob(job: LabelJob, sources: string[]): Promise<void> {
    // Header SEARCH is a substring match; require exact Message-ID too.
    const find = async (folder: string) => (await this.imap.searchEmails({
      folder, header: { field: "Message-ID", value: job.messageId }, limit: 200,
    })).filter(m => m.messageId === job.messageId);
    if (!(await find(job.folder)).length) {
      let source: string | undefined;
      let messages: Awaited<ReturnType<typeof find>> = [];
      for (const candidate of sources) {
        messages = await find(candidate);
        if (messages.length) { source = candidate; break; }
      }
      if (!source) return; // Sent can lag SMTP acceptance.
      for (const message of messages) {
        if (this.stopped) return;
        await withBackgroundAccountMailMutation({
          tool: "outgoing_label",
          transports: [{ scope: this.imap, abort: () => this.imap.abortPrimaryMutationTransport("Outgoing labeling cancelled") }],
        }, () => this.imap.copyVerifiedToFolder(message.id, job.folder, source,
          headers => headers.messageId === job.messageId.toLowerCase()));
      }
      if (!(await find(job.folder)).length) return;
    }
    this.update(current => current.filter(j => j.messageId !== job.messageId));
  }

  /** Stop future retries when this account service is retired or credentials are wiped. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
