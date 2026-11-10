import { withBackgroundAccountMailMutation } from "./mailbox-mutation-deadline.js";
/** Durable post-SMTP work. Retrying this queue never sends mail. */
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { SimpleIMAPService } from "./simple-imap-service.js";
import { withFileLock } from "../utils/file-lock.js";
import { accessLabelFolder } from "../security/label-access.js";
import { logger } from "../utils/logger.js";

interface LabelJob { messageId: string; folder: string }
export interface OutgoingLabeler {
  prepare(messageId: string): Promise<void>;
  stop(): void;
}

export class OutgoingLabelQueue implements OutgoingLabeler {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private stopped = false;
  constructor(
    private readonly path: string,
    private readonly imap: SimpleIMAPService,
    private readonly getLabel: () => unknown,
    private readonly connect: () => Promise<void>,
  ) {
    if (existsSync(path)) this.start();
  }

  private read(): LabelJob[] {
    if (!existsSync(this.path)) return [];
    const jobs: unknown = JSON.parse(readFileSync(this.path, "utf8"));
    if (!Array.isArray(jobs) || !jobs.every(j => j && typeof j.messageId === "string"
      && /^<[a-f0-9-]+@mailpouch.local>$/.test(j.messageId)
      && typeof j.folder === "string" && accessLabelFolder(j.folder.slice(7)) === j.folder)) {
      throw new Error("Invalid outgoing label queue; sending blocked until repaired.");
    }
    return jobs;
  }

  private update(change: (jobs: LabelJob[]) => LabelJob[]): void {
    withFileLock(this.path, () => {
      const jobs = change(this.read());
      const temp = `${this.path}.${randomUUID()}.tmp`;
      writeFileSync(temp, JSON.stringify(jobs), { mode: 0o600 });
      renameSync(temp, this.path);
    });
  }

  async prepare(messageId: string): Promise<void> {
    const folder = accessLabelFolder(this.getLabel());
    if (!folder) return;
    if (this.stopped) throw new Error("Outgoing label queue is retired.");
    await this.connect();
    const folders = await this.imap.syncFolders();
    if (!folders.some(f => f.path === folder)) throw new Error("Create the configured AI access label in Proton before sending.");
    if (this.stopped) throw new Error("Outgoing label queue is retired.");
    this.update(jobs => {
      if (jobs.length >= 10_000) throw new Error("Outgoing label queue is full; resolve labeling failures before sending.");
      return [...jobs, { messageId, folder }];
    });
    this.start();
  }

  private start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => { void this.processPending().catch(error => {
      logger.warn("Outgoing labeling pending; will retry without resending", "OutgoingLabels", error);
    }); }, 10_000);
    this.timer.unref();
  }

  /** Public for deterministic tests and explicit reconciliation. */
  async processPending(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      const jobs = this.read();
      if (!jobs.length) return;
      await this.connect();
      const folders = await this.imap.syncFolders();
      const sent = folders.find(f => f.specialUse === "\\Sent")?.path
        ?? folders.find(f => f.path === "Sent")?.path;
      if (!sent) throw new Error("Cannot resolve the Sent mailbox for outgoing labels.");
      for (const job of jobs) {
        if (this.stopped) return;
        // Header SEARCH is a substring match; require exact Message-ID too.
        const find = async (folder: string) => (await this.imap.searchEmails({
          folder, header: { field: "Message-ID", value: job.messageId }, limit: 200,
        }, true)).filter(m => m.messageId === job.messageId);
        if (!(await find(job.folder)).length) {
          const messages = await find(sent);
          // Sent can lag SMTP acceptance. Keep the job across restarts.
          if (!messages.length) continue;
          for (const message of messages) {
            if (this.stopped) return;
            await withBackgroundAccountMailMutation({
              tool: "outgoing_label",
              transports: [{ scope: this.imap, abort: () => this.imap.abortPrimaryMutationTransport("Outgoing labeling cancelled") }],
            }, () => this.imap.copyEmailToFolder(message.id, job.folder, sent));
          }
          if (!(await find(job.folder)).length) continue;
        }
        this.update(current => current.filter(j => j.messageId !== job.messageId));
      }
    } finally { this.running = false; }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
