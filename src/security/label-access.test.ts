import { describe, it, expect, vi } from "vitest";
import { accessLabelFolder, scopeLabelTool, requireLabelToolScope, labelAllowedFolders, labelScopedImap } from "./label-access.js";
import { SimpleIMAPService } from "../services/simple-imap-service.js";
import { handlers as reading } from "../tools/reading.js";
import type { ToolCallContext } from "../tools/types.js";
import type { EmailMessage } from "../types/index.js";

const folder = "Labels/AI-Accessible";
interface Message { uid: string; internalId?: string; subject: string; body: string; flags: Set<string>; attachment?: string }
function fixture() {
  const message = (uid: string, internalId: string, body: string, attachment?: string): Message => ({ uid, internalId, subject: "Same subject", body, flags: new Set(), attachment });
  const approved = message("42", "proton-a", "Approved body", "Approved attachment");
  const hidden = message("43", "proton-hidden", "Hidden body", "Hidden attachment");
  const sent = message("8", "proton-sent", "Approved sent body");
  const mailboxes = new Map<string, Message[]>([
    ["INBOX", [approved, hidden]],
    ["Sent", [message("42", "proton-other", "Hidden sent body"), sent]],
    [folder, [{ ...approved, uid: "900" }, { ...sent, uid: "901" }]],
    ["Labels/Work", [{ ...approved, uid: "19" }]],
  ]);
  const generations = new Map([...mailboxes.keys()].map(path => [path, 1n]));
  let selected = "";
  let lockTail = Promise.resolve();
  const pick = (range: string, uid: boolean) => (mailboxes.get(selected) ?? []).filter((m, i) => {
    if (range === "1:*") return true;
    return range.split(",").some(part => {
      const [a, b = a] = part.split(":").map(Number);
      const value = uid ? Number(m.uid) : i + 1;
      return value >= a && value <= b;
    });
  });
  const raw = (m: Message) => Buffer.from([
    "From: sender@example.com", "To: owner@example.com", `Subject: ${m.subject}`,
    // Distinct messages deliberately reuse this caller-controlled header.
    "Message-ID: <duplicate@example.com>", ...(m.internalId ? [`X-Pm-Internal-Id: ${m.internalId}`] : []),
    ...(m.attachment ? ["MIME-Version: 1.0", 'Content-Type: multipart/mixed; boundary="b"', "", "--b", "Content-Type: text/plain", "", m.body,
      "--b", 'Content-Type: text/plain; name="file.txt"', 'Content-Disposition: attachment; filename="file.txt"', "", m.attachment, "--b--"] : ["", m.body]),
  ].join("\r\n"));
  const client = {
    list: vi.fn(async () => [...mailboxes.keys()].map(path => ({ path, flags: new Set(path === "Labels" ? ["\\Noselect"] : []) }))),
    usable: true, mailbox: {} as { path: string; uidValidity: bigint; exists: number },
    getMailboxLock: vi.fn(async (path: string) => {
      const previous = lockTail;
      let release!: () => void;
      lockTail = new Promise<void>(resolve => { release = resolve; });
      await previous;
      if (!mailboxes.has(path)) { release(); throw new Error("Unknown mailbox"); }
      selected = path;
      client.mailbox = { path, uidValidity: generations.get(path)!, exists: mailboxes.get(path)!.length };
      return { release: vi.fn(release) };
    }),
    fetch: vi.fn(async function* (range: string, query: { headers?: unknown; source?: boolean }, options?: { uid?: boolean }) {
      for (const m of pick(range, options?.uid ?? false)) yield {
        uid: Number(m.uid), flags: m.flags,
        headers: query.headers ? Buffer.from(m.internalId ? `X-Pm-Internal-Id: ${m.internalId}\r\n\r\n` : "\r\n") : undefined,
        source: query.source ? raw(m) : undefined,
        envelope: { from: [{ address: "sender@example.com" }], to: [{ address: "owner@example.com" }], subject: m.subject, messageId: "<duplicate@example.com>", date: new Date("2026-01-01") },
        bodyParts: new Map([["1", Buffer.from(m.body)]]),
      };
    }),
    search: vi.fn(async (criteria: { uid?: string }) => (mailboxes.get(selected) ?? [])
      .filter(m => !criteria.uid || pick(criteria.uid, true).includes(m)).map(m => Number(m.uid))),
    messageFlagsAdd: vi.fn(async (range: string, flags: string[]) => { pick(range, true).forEach(m => flags.forEach(f => m.flags.add(f))); return true; }),
    messageFlagsRemove: vi.fn(async (range: string, flags: string[]) => { pick(range, true).forEach(m => flags.forEach(f => m.flags.delete(f))); return true; }),
  };
  const imap = new SimpleIMAPService();
  Object.assign(imap, { client, isConnected: true });
  for (const name of ["ensureConnection", "requireReadConnection", "ensureMutationConnection"]) {
    vi.spyOn(imap as never as Record<string, () => Promise<void>>, name).mockResolvedValue();
  }
  vi.spyOn(imap, "syncFolders").mockImplementation(async () => [...mailboxes].map(([path, messages]) => ({
    path, name: path.split("/").at(-1)!, totalMessages: messages.length,
    unreadMessages: messages.filter(m => !m.flags.has("\\Seen")).length,
    folderType: path.startsWith("Labels/") ? "label" : "system",
  })));
  return { imap, view: labelScopedImap(imap, folder), client, mailboxes, generations, approved, hidden };
}

describe("transparent backend mail filter", () => {
  it.each([null, 3, false, " ", " AI ", "AI/Other", "../INBOX", "AI\r\nSent"])("fails closed on invalid configuration %j", label => {
    expect(() => accessLabelFolder(label)).toThrow();
  });
  it("keeps normal arguments and per-agent folder restrictions unchanged", () => {
    expect(accessLabelFolder(undefined)).toBeUndefined();
    expect(accessLabelFolder("AI-Accessible")).toBe(folder);
    expect(labelAllowedFolders(folder, ["INBOX", folder, "Sent"])).toEqual(["INBOX", "Sent"]);
    for (const tool of ["get_emails", "get_email_by_id", "search_emails", "get_thread", "reply_to_email", "forward_email", "mark_email_read"]) {
      const args = { folder: "INBOX", sourceFolder: "Sent" };
      scopeLabelTool(tool, args, folder);
      expect(args).toEqual({ folder: "INBOX", sourceFolder: "Sent" });
      const omitted = {};
      scopeLabelTool(tool, omitted, folder);
      expect(omitted).toEqual({});
    }
  });
  it("keeps original folders and UIDs, filtering before pagination", async () => {
    const { view, client } = fixture();
    const inbox = await view.getEmails("INBOX", 1);
    expect(inbox.map(m => [m.id, m.folder, m.body])).toEqual([["42", "INBOX", "Approved body"]]);
    expect(await view.getEmails("INBOX", 1, 1)).toEqual([]);
    expect((await view.getEmails("Sent", 1)).map(m => [m.id, m.folder])).toEqual([["8", "Sent"]]);
    // Only approved UIDs reach the body/preview fetch.
    expect(client.fetch.mock.calls.filter(([, query]) => !query.headers).map(([range]) => range)).toEqual(["42", "8"]);
  });
  it("keeps the existing tool pagination and cursor format without the backing label", async () => {
    const { view, mailboxes, approved } = fixture();
    const next = { ...approved, uid: "44", internalId: "proton-next" };
    mailboxes.get("INBOX")!.push(next);
    mailboxes.get(folder)!.push({ ...next, uid: "904" });
    const ok = (structuredContent: Record<string, unknown>) => ({ content: [], structuredContent });
    const ctx = {
      args: { limit: 1 }, imapService: view, ok, limits: { maxEmailListResults: 50 },
      encodeCursor: (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url"),
      decodeCursor: (value: string) => JSON.parse(Buffer.from(value, "base64url").toString()),
    } as unknown as ToolCallContext;
    const page = (await reading.get_emails(ctx)).structuredContent!;
    expect((page.emails as EmailMessage[]).map(m => m.id)).toEqual(["44"]);
    const token = page.nextCursor as string;
    expect(ctx.decodeCursor(token)).toMatchObject({ folder: "INBOX", offset: 1 });
    ctx.args = { limit: 1, cursor: token };
    const second = (await reading.get_emails(ctx)).structuredContent!;
    expect((second.emails as EmailMessage[]).map(m => m.id)).toEqual(["42"]);
    expect(JSON.stringify([page, second])).not.toContain("AI-Accessible");
  });

  it("does not authorize UID collisions or duplicate RFC Message-IDs", async () => {
    const { view } = fixture();
    expect((await view.getEmailById("42", "INBOX"))?.body).toContain("Approved body");
    expect(await view.getEmailById("43", "INBOX")).toBeNull();
    expect(await view.getEmailById("42", "Sent")).toBeNull();
    expect(await view.getEmailById("900", folder)).toBeNull();
  });
  it("does not use cached bodies even when a scoped backend caller omits the fresh flag", async () => {
    const { imap } = fixture();
    const cached = { id: "42", folder: "INBOX", body: "Stale private body", to: [], subject: "Stale", from: "private@example.com", date: new Date(), isRead: false, isStarred: false, isHtml: false, hasAttachment: false } as EmailMessage;
    (imap as unknown as { setCacheEntry: (id: string, email: EmailMessage) => void }).setCacheEntry("42", cached);
    const scope = await imap.getLabelUidScope("INBOX", folder);
    expect((await imap.searchEmails({ folder: "INBOX" }, false, new Map([["INBOX", scope]])))[0].body).toContain("Approved body");
    expect((await imap.getEmailById("42", "INBOX", false, scope))?.body).toContain("Approved body");
  });

  it("honors manual label additions and revocation without restarting or using cached mail", async () => {
    const { imap, view, mailboxes, hidden } = fixture();
    await imap.getEmailById("43", "INBOX"); // Deliberately warm an unauthorized body cache.
    expect(await view.getEmailById("43", "INBOX")).toBeNull();
    mailboxes.get(folder)!.push({ ...hidden, uid: "902" });
    expect((await view.getEmailById("43", "INBOX"))?.body).toContain("Hidden body");
    mailboxes.set(folder, []);
    expect(await view.getEmailById("43", "INBOX")).toBeNull();
    expect(await view.getEmails("INBOX")).toEqual([]);
    expect(await view.searchEmails({ folder: "INBOX" })).toEqual([]);
    expect(await view.downloadAttachment("43", 0, "INBOX")).toBeNull();
  });
  it("preserves default and multi-folder searches while filtering before search limits", async () => {
    const { view, client } = fixture();
    expect((await view.searchEmails({ limit: 1 })).map(m => [m.id, m.folder])).toEqual([["42", "INBOX"]]);
    const result = await view.searchEmails({ folders: ["INBOX", "Sent"], limit: 20 });
    expect(result.map(m => `${m.folder}:${m.id}`).sort()).toEqual(["INBOX:42", "Sent:8"]);
    expect(client.search.mock.calls.every(([criteria]) => criteria.uid)).toBe(true);
    expect(JSON.stringify(await view.searchEmails({ folders: ["*"] }))).not.toContain("Hidden");
  });
  it("returns filtered folder/unread/secondary-label metadata without the control mailbox", async () => {
    const { view } = fixture();
    const folders = await view.getFolders();
    expect(folders.map(f => [f.path, f.totalMessages])).toEqual([["INBOX", 1], ["Sent", 1], ["Labels/Work", 1]]);
    const ok = (structuredContent: Record<string, unknown>) => ({ content: [], structuredContent });
    const ctx = { imapService: view, ok } as unknown as ToolCallContext;
    expect((await reading.get_unread_count(ctx)).structuredContent).toEqual({ unreadByFolder: { INBOX: 1, Sent: 1, "Labels/Work": 1 }, totalUnread: 3 });
    expect(JSON.stringify(await reading.list_labels(ctx))).toContain("Work");
    expect(JSON.stringify(await reading.list_labels(ctx))).not.toContain("AI-Accessible");
  });
  it("allows attachments and flag changes only for approved physical-folder UIDs", async () => {
    const { view, hidden, approved, client } = fixture();
    expect(Buffer.from((await view.downloadAttachment("42", 0, "INBOX"))!.content, "base64").toString()).toContain("Approved attachment");
    expect(await view.downloadAttachment("43", 0, "INBOX")).toBeNull();
    expect(await view.markEmailRead("42", true, "INBOX")).toBe(true);
    await expect(view.markEmailRead("43", true, "INBOX")).rejects.toThrow("Email not found");
    expect(approved.flags.has("\\Seen")).toBe(true);
    expect(hidden.flags.has("\\Seen")).toBe(false);
    expect(await view.bulkStar(["42", "43"], true, "INBOX")).toMatchObject({ success: 1, failed: 1 });
    expect(client.messageFlagsAdd.mock.calls.every(([range]) => range === "42")).toBe(true);
  });
  it("fails closed if the physical mailbox rebuilds between authorization and reading", async () => {
    const { imap, generations } = fixture();
    const scope = await imap.getLabelUidScope("INBOX", folder);
    generations.set("INBOX", 2n);
    await expect(imap.getEmails("INBOX", 50, 0, scope)).rejects.toThrow("Mailbox changed");
    await expect(imap.getEmailById("42", "INBOX", true, scope)).rejects.toThrow("Mailbox changed");
    await expect(imap.setScopedFlags(["42"], "\\Seen", true, scope)).rejects.toThrow("Mailbox changed");
  });
  it("preserves hierarchy entries and denies messages without a Bridge identity", async () => {
    const { view, mailboxes, hidden } = fixture();
    mailboxes.set("Labels", []);
    mailboxes.get("INBOX")!.push({ ...hidden, uid: "99", internalId: undefined });
    mailboxes.get(folder)!.push({ ...hidden, uid: "903", internalId: undefined });
    expect((await view.getFolders()).find(f => f.path === "Labels")).toMatchObject({ totalMessages: 0, unreadMessages: 0 });
    expect(await view.getEmailById("99", "INBOX")).toBeNull();
  });
  it("does not reveal policy names in connection/policy errors", async () => {
    const { view, mailboxes } = fixture();
    mailboxes.delete(folder);
    await expect(view.getEmails("INBOX")).rejects.toThrow("Mailbox temporarily unavailable");
    expect(() => scopeLabelTool("get_emails", { folder }, folder)).toThrow("Folder not found");
    expect(() => scopeLabelTool("fts_search", {}, folder)).toThrow("Tool unavailable");
  });
});

describe("mailbox policy denial audit", () => {
  it.each(["get_logs", "read_surface:get_logs"])("records a known caller's %s denial without retaining arguments", tool => {
    const write = vi.fn();
    expect(() => requireLabelToolScope({ tool, args: { body: "private contents" }, readFolder: () => folder,
      caller: { clientId: "test-agent", clientName: "Test agent" }, audit: { write }, errorMessage: e => (e as Error).message,
    })).toThrow("Tool unavailable");
    expect(write).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ tool, ok: false, argHash: expect.any(String) }));
    expect(JSON.stringify(write.mock.calls)).not.toContain("private contents");
  });
  it("audits unreadable configuration and rethrows the original error", () => {
    const error = new Error("Mailbox unavailable");
    const write = vi.fn();
    let received: unknown;
    try {
      requireLabelToolScope({ tool: "send_email", args: {}, readFolder: () => { throw error; },
        caller: { clientId: "agent", clientName: "Agent" }, audit: { write }, errorMessage: String,
      });
    } catch (caught) { received = caught; }
    expect(received).toBe(error);
    expect(write).toHaveBeenCalledTimes(1);
  });
});
