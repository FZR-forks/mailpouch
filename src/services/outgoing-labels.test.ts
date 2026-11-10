import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OutgoingLabelQueue } from "./outgoing-labels.js";
import type { SimpleIMAPService } from "./simple-imap-service.js";

const id = "<12345678-abcd@mailpouch.local>";
const folder = "Labels/AI-Accessible";
let dir: string;
let path: string;
let queues: OutgoingLabelQueue[];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "mailpouch-labels-")); path = join(dir, "queue.json"); queues = []; });
afterEach(() => { queues.forEach(q => q.stop()); rmSync(dir, { recursive: true, force: true }); });
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
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual([{ messageId: id, folder }]);
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
    await expect(queue.prepare(id)).rejects.toThrow("Create the configured");
    writeFileSync(path, "corrupt");
    await expect(queue.prepare(id)).rejects.toThrow();
  });
});
