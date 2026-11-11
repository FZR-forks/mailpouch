import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReplyLabeler } from "./reply-labels.js";
import { parseIdentityHeaders } from "./simple-imap-service.js";
import type { MailboxIdentityEntry, SimpleIMAPService } from "./simple-imap-service.js";

const label = "Labels/AI-Accessible";
let dir: string;
let path: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "mailpouch-replies-")); path = join(dir, "replies.json"); });
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

type Message = { uid: string; internalId?: string; messageId?: string; parents?: string[] };
function setup(options: { allMail?: boolean; policy?: () => string | undefined; active?: boolean } = {}) {
  const sourceName = options.allMail === false ? "INBOX" : "All Mail";
  const mailboxes = new Map<string, Message[]>([[sourceName, []], [label, []], ["Spam", []], ["Trash", []]]);
  if (options.allMail === false) mailboxes.set("Sent", []);
  const entries = (path: string): MailboxIdentityEntry[] => (mailboxes.get(path) ?? [])
    .map(m => ({ uid: m.uid, internalId: m.internalId, messageId: m.messageId, parents: m.parents ?? [], unread: false }));
  const imap = {
    isActive: vi.fn(() => options.active ?? true),
    selectableMailboxes: vi.fn(async () => [
      ...(options.allMail === false
        ? [{ path: "INBOX" }, { path: "Sent", specialUse: "\\Sent" }]
        : [{ path: "All Mail", specialUse: "\\All" }]),
      { path: label }, { path: "Spam", specialUse: "\\Junk" }, { path: "Trash", specialUse: "\\Trash" },
    ]),
    readMailboxEntries: vi.fn(async (p: string) => ({ uidValidity: 1n, entries: entries(p) })),
    readNewMailboxEntries: vi.fn(async (p: string) => entries(p)),
    // Identity-proven COPY: the predicate sees the source message's real headers.
    copyVerifiedToFolder: vi.fn(async (uid: string, target: string, source: string, matches: (h: { internalId?: string; parents: string[] }) => boolean) => {
      const message = mailboxes.get(source)!.find(m => m.uid === uid);
      if (!message || !matches({ internalId: message.internalId, parents: message.parents ?? [] })) throw new Error("Mailbox changed during the request");
      mailboxes.get(target)!.push({ ...message, uid: String(500 + mailboxes.get(target)!.length) });
      return true;
    }),
    abortPrimaryMutationTransport: vi.fn(),
  };
  const labeler = new ReplyLabeler(path, imap as unknown as SimpleIMAPService, options.policy ?? (() => label));
  const source = mailboxes.get(sourceName)!;
  return { labeler, imap, mailboxes, source, sourceName };
}
const approve = (f: ReturnType<typeof setup>, message: Message) => {
  f.source.push(message);
  f.mailboxes.get(label)!.push({ ...message, uid: `L${message.uid}` });
};

describe("background reply labeling", () => {
  it("labels replies (and replies to replies) to approved mail, but not unrelated mail", async () => {
    const f = setup();
    approve(f, { uid: "1", internalId: "agent-sent", messageId: "<a@x>" });
    f.source.push(
      { uid: "2", internalId: "reply", messageId: "<b@y>", parents: ["<a@x>"] },
      { uid: "3", internalId: "reply-2", messageId: "<c@z>", parents: ["<b@y>", "<a@x>"] },
      { uid: "4", internalId: "unrelated", messageId: "<d@w>", parents: ["<other@w>"] },
    );
    expect(await f.labeler.scan()).toBe(2);
    expect(f.mailboxes.get(label)!.map(m => m.internalId).sort()).toEqual(["agent-sent", "reply", "reply-2"]);
    expect(f.imap.copyVerifiedToFolder).toHaveBeenCalledWith("2", label, "All Mail", expect.any(Function));
    expect(await f.labeler.scan()).toBe(0);
  });

  it("does not let a reused Message-ID anchor replies when any carrier is unapproved", async () => {
    const f = setup();
    approve(f, { uid: "1", internalId: "approved", messageId: "<shared@x>" });
    f.source.push(
      { uid: "2", internalId: "private-original", messageId: "<shared@x>" },
      { uid: "3", internalId: "private-reply", messageId: "<r@y>", parents: ["<shared@x>"] },
    );
    expect(await f.labeler.scan()).toBe(0);
    // An unapproved carrier in Trash or without a Bridge identity also blocks it.
    const g = setup();
    approve(g, { uid: "1", internalId: "approved", messageId: "<shared@x>" });
    g.mailboxes.get("Trash")!.push({ uid: "9", internalId: "trashed", messageId: "<shared@x>" });
    g.source.push({ uid: "3", internalId: "reply", messageId: "<r@y>", parents: ["<shared@x>"] });
    expect(await g.labeler.scan()).toBe(0);
    const h = setup();
    approve(h, { uid: "1", internalId: "approved", messageId: "<shared@x>" });
    h.source.push({ uid: "2", messageId: "<shared@x>" }, { uid: "3", internalId: "reply", messageId: "<r@y>", parents: ["<shared@x>"] });
    expect(await h.labeler.scan()).toBe(0);
  });

  it("never re-labels mail the owner removed the label from, across restarts", async () => {
    const f = setup();
    approve(f, { uid: "1", internalId: "original", messageId: "<a@x>" });
    f.source.push({ uid: "2", internalId: "reply", messageId: "<b@y>", parents: ["<a@x>"] });
    expect(await f.labeler.scan()).toBe(1);
    // Owner removes the label from the reply; also a manually labeled reply that is later removed.
    f.mailboxes.set(label, f.mailboxes.get(label)!.filter(m => m.internalId !== "reply"));
    const restarted = new ReplyLabeler(path, f.imap as unknown as SimpleIMAPService, () => label);
    expect(await restarted.scan()).toBe(0);
    expect(f.mailboxes.get(label)!.map(m => m.internalId)).toEqual(["original"]);
    expect(JSON.parse(readFileSync(path, "utf8")).labels[label].sort()).toEqual(["original", "reply"]);
  });

  it("never labels Spam or Trash", async () => {
    const f = setup();
    approve(f, { uid: "1", internalId: "original", messageId: "<a@x>" });
    // All Mail may include messages that are also in Spam.
    f.source.push({ uid: "2", internalId: "spammy", messageId: "<b@y>", parents: ["<a@x>"] });
    f.mailboxes.get("Spam")!.push({ uid: "7", internalId: "spammy", messageId: "<b@y>", parents: ["<a@x>"] });
    expect(await f.labeler.scan()).toBe(0);
  });

  it("scans ordinary folders when All Mail is hidden", async () => {
    const f = setup({ allMail: false });
    approve(f, { uid: "1", internalId: "original", messageId: "<a@x>" });
    f.mailboxes.get("Sent")!.push({ uid: "5", internalId: "owner-reply", messageId: "<b@y>", parents: ["<a@x>"] });
    expect(await f.labeler.scan()).toBe(1);
    expect(f.imap.copyVerifiedToFolder).toHaveBeenCalledWith("5", label, "Sent", expect.any(Function));
    expect(f.imap.readNewMailboxEntries).not.toHaveBeenCalledWith(label);
  });

  it("does nothing while the policy is off or unreadable, or IMAP is not connected", async () => {
    for (const options of [{ policy: () => undefined }, { policy: () => { throw new Error("unreadable"); } }, { active: false }]) {
      const f = setup(options);
      approve(f, { uid: "1", internalId: "original", messageId: "<a@x>" });
      f.source.push({ uid: "2", internalId: "reply", messageId: "<b@y>", parents: ["<a@x>"] });
      expect(await f.labeler.scan()).toBe(0);
      expect(f.imap.selectableMailboxes).not.toHaveBeenCalled();
    }
  });

  it("labels nothing when any mailbox needed for collision checks cannot be read", async () => {
    for (const failing of ["Trash", "All Mail"]) {
      const f = setup();
      approve(f, { uid: "1", internalId: "approved", messageId: "<a@x>" });
      f.source.push({ uid: "2", internalId: "reply", messageId: "<b@y>", parents: ["<a@x>"] });
      const read = f.imap.readNewMailboxEntries.getMockImplementation()!;
      f.imap.readNewMailboxEntries.mockImplementation(async (p: string) => {
        if (p === failing) throw new Error("Bridge offline");
        return read(p);
      });
      await expect(f.labeler.scan()).rejects.toThrow("Bridge offline");
      expect(f.imap.copyVerifiedToFolder).not.toHaveBeenCalled();
    }
  });

  it("re-authorizes before each COPY, so revoking an anchor or the policy mid-scan labels nothing further", async () => {
    for (const change of ["revoke anchor", "change policy"]) {
      let policy = label;
      const f = setup({ policy: () => policy });
      approve(f, { uid: "1", internalId: "anchor", messageId: "<a@x>" });
      f.source.push({ uid: "2", internalId: "reply", messageId: "<b@y>", parents: ["<a@x>"] });
      // The change lands after planning, while the worker re-reads the label before copying.
      const reads = f.imap.readMailboxEntries.getMockImplementation()!;
      let calls = 0;
      f.imap.readMailboxEntries.mockImplementation(async (p: string) => {
        if (++calls === 2) {
          if (change === "revoke anchor") f.mailboxes.set(label, []);
          else policy = "Labels/Other";
        }
        return reads(p);
      });
      expect(await f.labeler.scan()).toBe(0);
      expect(f.imap.copyVerifiedToFolder).not.toHaveBeenCalled();
    }
  });

  it("stops labeling when its state file is corrupt rather than forgetting removals", async () => {
    const f = setup();
    approve(f, { uid: "1", internalId: "original", messageId: "<a@x>" });
    f.source.push({ uid: "2", internalId: "reply", messageId: "<b@y>", parents: ["<a@x>"] });
    writeFileSync(path, "{not json");
    await expect(f.labeler.scan()).rejects.toThrow();
    expect(f.imap.copyVerifiedToFolder).not.toHaveBeenCalled();
    expect(existsSync(path)).toBe(true);
  });
});

describe("identity header parsing", () => {
  it("reads folded headers, lowercases IDs, and orders nearest parents first", () => {
    const parsed = parseIdentityHeaders(Buffer.from([
      "X-Pm-Internal-Id: abc==", "Message-ID: <Self@X>", "In-Reply-To: <Parent@X>",
      "References: <root@x>", " <mid@x> <parent@x>", "", "",
    ].join("\r\n")));
    expect(parsed).toEqual({ internalId: "abc==", messageId: "<self@x>", parents: ["<parent@x>", "<mid@x>", "<root@x>"] });
  });
  it("fails closed on duplicate Bridge identities and ignores self-references", () => {
    const parsed = parseIdentityHeaders(Buffer.from("X-Pm-Internal-Id: real\r\nX-Pm-Internal-Id: spoof\r\nMessage-ID: <a@x>\r\nReferences: <a@x>\r\n\r\n"));
    expect(parsed).toEqual({ internalId: undefined, messageId: "<a@x>", parents: [] });
    expect(parseIdentityHeaders(undefined)).toEqual({ internalId: undefined, messageId: undefined, parents: [] });
  });
});
