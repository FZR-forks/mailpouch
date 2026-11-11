/**
 * Background reply labeling. A message whose In-Reply-To/References names an
 * approved message becomes approved too, so replies to the agent's mail (and
 * to mail the owner labeled) stay visible without Proton's sticky labels and
 * without the agent doing anything.
 *
 * Safety rules:
 * - A Message-ID only anchors replies when every message carrying it is
 *   approved, so a sender reusing another thread's Message-ID cannot pull
 *   unrelated mail into scope.
 * - A message that was ever observed with the label is never re-labeled: if
 *   the owner removed the label, that decision stands.
 * - Spam and Trash are never labeled.
 */
import { existsSync, readFileSync } from "node:fs";
import type { SimpleIMAPService, MailboxMessageIdentity } from "./simple-imap-service.js";
import { withBackgroundAccountMailMutation } from "./mailbox-mutation-deadline.js";
import { withFileLock } from "../utils/file-lock.js";
import { writeOwnerOnlyJsonAtomically } from "../utils/atomic-json.js";
import { logger } from "../utils/logger.js";

const SCAN_INTERVAL_MS = 30_000;
/** Reply chains longer than this within one scan finish on the next scan. */
const MAX_CHAIN_PASSES = 10;

interface ReplyLabelState { version: 1; labels: Record<string, string[]> }

export class ReplyLabeler {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private stopped = false;

  /** Watch one account's mailbox; scans do nothing while the policy is off or IMAP is idle. */
  constructor(
    private readonly path: string,
    private readonly imap: SimpleIMAPService,
    private readonly getLabelFolder: () => string | undefined,
    private readonly intervalMs = SCAN_INTERVAL_MS,
  ) {}

  /** Start periodic scans without keeping a shutting-down process alive. */
  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => { void this.scan().catch(error => {
      logger.warn("Reply labeling scan failed; will retry", "ReplyLabels", error);
    }); }, this.intervalMs);
    this.timer.unref();
  }

  /** Stop scanning when the account is retired or credentials are wiped. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Persisted state; corrupt state stops labeling rather than forgetting the owner's removals. */
  private readState(): ReplyLabelState {
    if (!existsSync(this.path)) return { version: 1, labels: {} };
    const state = JSON.parse(readFileSync(this.path, "utf8")) as ReplyLabelState | null;
    if (state?.version !== 1 || !state.labels || typeof state.labels !== "object"
        || Object.values(state.labels).some(ids => !Array.isArray(ids) || ids.some(id => typeof id !== "string"))) {
      throw new Error("Reply labeling state is unreadable");
    }
    return state;
  }

  /** Every identity ever observed with `label`. */
  private known(label: string): Set<string> {
    return new Set(this.readState().labels[label] ?? []);
  }

  /** Durably record approved identities, merging with concurrent writers. */
  private remember(label: string, identities: Iterable<string>): void {
    withFileLock(this.path, () => {
      const state = this.readState();
      const current = new Set(state.labels[label] ?? []);
      const before = current.size;
      for (const id of identities) current.add(id);
      if (current.size === before) return;
      state.labels[label] = [...current];
      writeOwnerOnlyJsonAtomically(this.path, state);
    });
  }

  /** One matching pass. Returns how many replies were labeled. */
  async scan(): Promise<number> {
    if (this.running || this.stopped) return 0;
    let label: string | undefined;
    try { label = this.getLabelFolder(); } catch { return 0; } // Unreadable policy: never widen access.
    if (!label || !this.imap.isActive()) return 0;
    this.running = true;
    try {
      return await this.labelReplies(label);
    } finally { this.running = false; }
  }

  private async labelReplies(label: string): Promise<number> {
    const mailboxes = await this.imap.selectableMailboxes();
    const isExcluded = (f: { path: string; specialUse?: string }) =>
      f.specialUse === "\\Junk" || f.specialUse === "\\Trash" || f.path === "Spam" || f.path === "Trash";
    // Bridge lists All Mail without the \All flag, so match its name too.
    const allMail = mailboxes.find(f => f.specialUse === "\\All" || f.path === "All Mail");
    const sources = allMail ? [allMail.path] : mailboxes
      .filter(f => !f.path.startsWith("Labels/") && !isExcluded(f) && f.specialUse !== "\\Drafts")
      .map(f => f.path);

    const approvedNow = async () => new Set((await this.imap.readMailboxEntries(label)).entries
      .flatMap(entry => entry.internalId ? [entry.internalId] : []));
    const labelEntries = (await this.imap.readMailboxEntries(label)).entries;
    const approved = new Set(labelEntries.flatMap(entry => entry.internalId ? [entry.internalId] : []));
    if (approved.size) this.remember(label, approved);
    const everApproved = this.known(label);

    // Every mailbox must be read: a skipped one could hide an unapproved
    // carrier of an anchor's Message-ID, so any read failure aborts the scan.
    const candidates: Array<{ folder: string; entries: MailboxMessageIdentity[] }> = [];
    for (const path of sources) candidates.push({ folder: path, entries: await this.imap.readNewMailboxEntries(path) });
    // Live membership: a reply restored from Spam/Trash must stop being excluded.
    const excludedEntries: MailboxMessageIdentity[] = [];
    for (const f of mailboxes.filter(isExcluded)) excludedEntries.push(...(await this.imap.readMailboxEntries(f.path)).entries);
    const excluded = new Set(excludedEntries.flatMap(entry => entry.internalId ? [entry.internalId] : []));

    // Every carrier of each Message-ID, including Spam/Trash. A carrier without
    // a Bridge identity can never be approved, so it keeps that ID unusable.
    const carriers = new Map<string, Set<string>>();
    for (const entry of [labelEntries, ...candidates.map(c => c.entries), excludedEntries].flat()) {
      if (!entry.messageId) continue;
      const set = carriers.get(entry.messageId) ?? new Set<string>();
      set.add(entry.internalId ?? "\u0000unidentified");
      carriers.set(entry.messageId, set);
    }
    const anchoredBy = (entry: MailboxMessageIdentity, approvedSet: ReadonlySet<string>) => entry.parents.some(messageId => {
      const set = carriers.get(messageId);
      return !!set?.size && [...set].every(identity => approvedSet.has(identity));
    });

    // Plan in reply-chain order: a reply is planned only after its parent.
    const toLabel: Array<{ folder: string; entry: MailboxMessageIdentity; identity: string }> = [];
    for (let pass = 0, changed = true; changed && pass < MAX_CHAIN_PASSES; pass++) {
      changed = false;
      for (const { folder, entries } of candidates) {
        for (const entry of entries) {
          const identity = entry.internalId;
          if (!identity || approved.has(identity) || everApproved.has(identity) || excluded.has(identity)) continue;
          if (!anchoredBy(entry, approved)) continue;
          approved.add(identity);
          toLabel.push({ folder, entry, identity });
          changed = true;
        }
      }
    }

    let labeled = 0;
    for (const { folder, entry, identity } of toLabel) {
      if (this.stopped) break;
      // Re-authorize against the live policy and label right before each COPY,
      // so an anchor revoked during the scan approves nothing further.
      if (!anchoredBy(entry, await approvedNow()) || this.known(label).has(identity)) continue;
      let policy: string | undefined;
      try { policy = this.getLabelFolder(); } catch { break; }
      if (policy !== label) break;
      // Record the attempt before exposing the reply, so a later removal always
      // sticks. A COPY's outcome can be unknown, so a failed attempt is never
      // retried: at worst that reply stays hidden until the owner labels it.
      this.remember(label, [identity]);
      try {
        await withBackgroundAccountMailMutation({
          tool: "reply_label",
          transports: [{ scope: this.imap, abort: () => this.imap.abortPrimaryMutationTransport("Reply labeling cancelled") }],
        }, () => this.imap.copyVerifiedToFolder(entry.uid, label, folder, headers => headers.internalId === identity));
        labeled++;
      } catch (error) {
        logger.warn("Could not label a reply to approved mail; label it manually if it should be visible", "ReplyLabels", error);
      }
    }
    if (labeled) logger.info(`Labeled ${labeled} repl${labeled === 1 ? "y" : "ies"} to approved mail`, "ReplyLabels");
    return labeled;
  }
}
