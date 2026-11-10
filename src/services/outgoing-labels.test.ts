import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OutgoingLabelQueue } from "./outgoing-labels.js";
import { logger } from "../utils/logger.js";
import type { SimpleIMAPService } from "./simple-imap-service.js";

const id = "<12345678-abcd@mailpouch.local>";
const folder = "Labels/AI-Accessible";
let dir: string;
let path: string;
let queues: OutgoingLabelQueue[];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "mailpouch-labels-")); path = join(dir, "queue.json"); queues = []; });
afterEach(() => { vi.restoreAllMocks(); queues.forEach(q => q.stop()); rmSync(dir, { recursive: true, force: true }); });
function setup(label: unknown = "AI-Accessible") {
  const copies: string[][] = [];
  const mailboxes = new Map<string, { id: string; messageId: string }[]>([["Envoyés", []], [folder, []]]);
  const imap = {
    syncFolders: vi.fn(async () => [{ path: folder }, { path: "Envoyés", specialUse: "\\Sent" }]),
    searchEmails: vi.fn(async (o: { folder: string }) => mailboxes.get(o.folder) ?? []),
    copyEmailToFolder: vi.fn(async (...args: string[]) => {
      copies.push(args);
      mailboxes.set(folder, [{ id: "77", messageId: id }]);
      return true;
    }),
  };
  const queue = new OutgoingLabelQueue(path, imap as unknown as SimpleIMAPService, () => label, async () => {});
  queues.push(queue);
  return { queue, imap, copies, mailboxes };
}
describe("durable outgoing labels", () => {
  it("persists before delivery, tolerates delayed Sent, and resumes after restart", async () => {
    const { queue, mailboxes, imap } = setup();
    await queue.prepare(id);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual([{ messageId: id, folder, createdAt: expect.any(Number) }]);
    await queue.processPending();
    expect(imap.copyEmailToFolder).not.toHaveBeenCalled();
    queue.stop();
    mailboxes.set("Envoyés", [{ id: "8", messageId: id }]);
    const resumed = new OutgoingLabelQueue(path, imap as unknown as SimpleIMAPService, () => "AI-Accessible", async () => {});
    queues.push(resumed);
    await resumed.processPending();
    expect(imap.copyEmailToFolder).toHaveBeenCalledWith("8", folder, "Envoyés");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual([]);
  });
  it("retains a failed label operation for retry, without an SMTP dependency", async () => {
    const { queue, mailboxes, imap } = setup();
    await queue.prepare(id);
    mailboxes.set("Envoyés", [{ id: "8", messageId: id }]);
    imap.copyEmailToFolder.mockRejectedValueOnce(new Error("Bridge offline"));
    await expect(queue.processPending()).rejects.toThrow("Bridge offline");
    expect(JSON.parse(readFileSync(path, "utf8"))).toHaveLength(1);
    await queue.processPending();
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual([]);
  });
  it("uses exact identity instead of authorizing substring matches", async () => {
    const { queue, mailboxes, imap } = setup();
    await queue.prepare(id);
    mailboxes.set("Envoyés", [{ id: "8", messageId: `${id}.other` }]);
    await queue.processPending();
    expect(imap.copyEmailToFolder).not.toHaveBeenCalled();
  });
  it("never restores a label after successful labeling and user revocation", async () => {
    const { queue, mailboxes, imap } = setup();
    await queue.prepare(id);
    mailboxes.set(folder, [{ id: "8", messageId: id }]);
    await queue.processPending();
    mailboxes.set(folder, []);
    await queue.processPending();
    expect(imap.copyEmailToFolder).not.toHaveBeenCalled();
  });
  it("blocks delivery preparation if the label or durable queue is unavailable", async () => {
    const { queue, imap } = setup();
    imap.syncFolders.mockResolvedValueOnce([]);
    await expect(queue.prepare(id)).rejects.toThrow("Mailbox unavailable");
    writeFileSync(path, "corrupt");
    await expect(queue.prepare(id)).rejects.toThrow();
  });
});


describe("outgoing job isolation and age limit", () => {
  it("finishes later jobs in the same tick before rethrowing the first job failure", async () => {
    const { queue, mailboxes, imap } = setup();
    const nextId = "<abcdefab-1234@mailpouch.local>";
    await queue.prepare(id);
    await queue.prepare(nextId);
    mailboxes.set("Envoyés", [{ id: "8", messageId: id }, { id: "9", messageId: nextId }]);
    imap.copyEmailToFolder.mockImplementation(async (uid: string) => {
      if (uid === "8") throw new Error("First job failed");
      mailboxes.set(folder, [{ id: "99", messageId: nextId }]);
      return true;
    });
    await expect(queue.processPending()).rejects.toThrow("First job failed");
    expect(imap.copyEmailToFolder).toHaveBeenCalledWith("9", folder, "Envoyés");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual([
      { messageId: id, folder, createdAt: expect.any(Number) },
    ]);
  });

  it("retains expired work for operator recovery and does not retry it after restart", async () => {
    const { queue, imap } = setup();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const log = vi.spyOn(logger, "error").mockImplementation(() => {});
    const job = { messageId: id, folder, createdAt: now - 31 * 24 * 60 * 60 * 1000 };
    writeFileSync(path, JSON.stringify([job]));
    await queue.processPending();
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual([{ ...job, needsAttentionAt: now }]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("needs operator attention"), "OutgoingLabels");
    expect(imap.searchEmails).not.toHaveBeenCalled();
    queue.stop();
    const restarted = new OutgoingLabelQueue(path, imap as unknown as SimpleIMAPService, () => "AI-Accessible", async () => {});
    queues.push(restarted);
    await restarted.processPending();
    expect(log).toHaveBeenCalledTimes(1);
    expect(imap.searchEmails).not.toHaveBeenCalled();
  });

  it("gives legacy records a full retry window without assuming their age", async () => {
    const { queue } = setup();
    writeFileSync(path, JSON.stringify([{ messageId: id, folder }]));
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    await queue.processPending();
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual([{ messageId: id, folder, createdAt: now }]);
  });

  it("does not count retained attention records against active send capacity", async () => {
    const { queue } = setup();
    writeFileSync(path, JSON.stringify(Array.from({ length: 10_000 }, (_, i) => ({
      messageId: `<${i.toString(16)}@mailpouch.local>`, folder, createdAt: 0, needsAttentionAt: 1,
    }))));
    await expect(queue.prepare(id)).resolves.toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toHaveLength(10_001);
  });
});


describe("outgoing label activation and rejected sends", () => {
  it("reports disabled labeling without creating a durable job", async () => {
    const { queue, imap } = setup("");
    expect(await queue.prepare(id)).toBe(false);
    expect(imap.syncFolders).not.toHaveBeenCalled();
    expect(existsSync(path)).toBe(false);
  });
  it("discards definitively rejected attempts from persistent state", async () => {
    const { queue } = setup();
    expect(await queue.prepare(id)).toBe(true);
    queue.discard(id);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual([]);
    await queue.processPending();
  });
});
