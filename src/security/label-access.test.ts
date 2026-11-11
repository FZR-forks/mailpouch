import { describe, it, expect, vi } from "vitest";
import { accessLabelFolder, scopeLabelTool, requireLabelToolScope, labelAllowedFolders, labelScopedImap, assertLabelAccessCurrent } from "./label-access.js";
import { SimpleIMAPService } from "../services/simple-imap-service.js";
import { handlers as reading } from "../tools/reading.js";
import { handlers as sending } from "../tools/sending.js";
import { executeMailTool } from "../services/mail-tool-execution.js";
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
  it.each(["getFolders", "syncFolders", "wildcard search", "wildcard all search", "multi-folder search", "lookup without a folder"])(
    "lists folders once and bounds label/source scans per %s operation", async operation => {
      const { view, imap, client, mailboxes, generations, approved } = fixture();
      // Exercise an account with many labels; folder-listing cost must stay constant.
      for (let i = 0; i < 30; i++) {
        const path = `Labels/Other${i}`;
        mailboxes.set(path, [{ ...approved, uid: String(100 + i) }]);
        generations.set(path, 1n);
      }
      const paths = [...mailboxes.keys()].filter(path => path !== folder);
      if (operation === "getFolders") expect(await view.getFolders()).toHaveLength(paths.length);
      else if (operation === "syncFolders") expect(await view.syncFolders()).toHaveLength(paths.length);
      else if (operation === "wildcard search") await view.searchEmails({ folders: ["*"] });
      else if (operation === "wildcard all search") await view.searchEmails({ folder: "all" });
      else if (operation === "multi-folder search") await view.searchEmails({ folders: paths });
      else expect(await view.getEmailById("999")).toBeNull();
      expect(imap.syncFolders).toHaveBeenCalledTimes(1);
      expect(client.list).toHaveBeenCalledTimes(1);
      const scanned = client.getMailboxLock.mock.calls.map(([path]) => path);
      // One shared authorization snapshot and one final membership check,
      // independent of the number of folders. Searches only scan their first 20.
      expect(scanned.filter(path => path === folder)).toHaveLength(2);
      const expected = operation.includes("search") ? paths.slice(0, 20) : paths;
      for (const path of paths) {
        if (expected.includes(path)) expect(scanned).toContain(path);
        else expect(scanned).not.toContain(path);
      }
    },
  );
  it("stops a folderless lookup at the first approved match without scanning later folders", async () => {
    const { view, client } = fixture();
    expect((await view.getEmailById("42"))?.folder).toBe("INBOX");
    expect(client.getMailboxLock.mock.calls.map(([path]) => path)).toEqual([folder, "INBOX", "INBOX", folder]);
  });
  it("refreshes label membership between multi-folder operations", async () => {
    const { view, client, mailboxes } = fixture();
    expect((await view.getFolders()).map(entry => entry.totalMessages)).toEqual([1, 1, 1]);
    mailboxes.set(folder, []);
    expect((await view.getFolders()).map(entry => entry.totalMessages)).toEqual([0, 0, 0]);
    expect(await view.searchEmails({ folders: ["*"] })).toEqual([]);
    expect(client.getMailboxLock.mock.calls.filter(([path]) => path === folder)).toHaveLength(6);
  });
  it.each(["list", "lookup", "search", "attachment"])("discards %s results if the label is removed during body retrieval", async operation => {
    const { view, client, mailboxes } = fixture();
    const fetch = client.fetch.getMockImplementation()!;
    client.fetch.mockImplementation(async function* (...args) {
      try { yield* fetch(...args); }
      finally { if (args[1].source || !args[1].headers) mailboxes.set(folder, []); }
    });
    const result = operation === "list" ? view.getEmails("INBOX")
      : operation === "lookup" ? view.getEmailById("42", "INBOX")
        : operation === "search" ? view.searchEmails({ folders: ["INBOX", "Sent"] })
          : view.downloadAttachment("42", 0, "INBOX");
    await expect(result).rejects.toThrow("Mailbox temporarily unavailable");
  });
  it.each(["getFolders", "syncFolders", "later-folder lookup"])("discards %s results after revocation while scanning later folders", async operation => {
    const { view, client, mailboxes } = fixture();
    const lock = client.getMailboxLock.getMockImplementation()!;
    client.getMailboxLock.mockImplementation(async path => {
      if (path === "Sent") mailboxes.set(folder, []);
      return lock(path);
    });
    const result = operation === "getFolders" ? view.getFolders()
      : operation === "syncFolders" ? view.syncFolders() : view.getEmailById("8");
    await expect(result).rejects.toThrow("Mailbox temporarily unavailable");
  });
  it("revalidates membership after the attachment source is downloaded", async () => {
    const { view, imap, mailboxes } = fixture();
    const download = imap.downloadAttachment.bind(imap);
    vi.spyOn(imap, "downloadAttachment").mockImplementation(async (...args) => {
      const attachment = await download(...args);
      expect(attachment).not.toBeNull();
      mailboxes.set(folder, []);
      return attachment;
    });
    await expect(view.downloadAttachment("42", 0, "INBOX")).rejects.toThrow("Mailbox temporarily unavailable");
  });
  it("discards results if the access mailbox changes identity, membership, or availability during a read", async () => {
    for (const change of ["rebuild", "replace membership", "delete"]) {
      const { view, imap, mailboxes, generations, hidden } = fixture();
      const read = imap.getEmails.bind(imap);
      vi.spyOn(imap, "getEmails").mockImplementation(async (...args) => {
        const emails = await read(...args);
        if (change === "rebuild") generations.set(folder, 2n);
        else if (change === "replace membership") mailboxes.get(folder)![0] = { ...hidden, uid: "900" };
        else mailboxes.delete(folder);
        return emails;
      });
      await expect(view.getEmails("INBOX")).rejects.toThrow("Mailbox temporarily unavailable");
    }
  });
  it("rechecks membership before applying flags", async () => {
    const { view, client, imap, mailboxes } = fixture();
    const readScope = imap.getLabelUidScopes.bind(imap);
    vi.spyOn(imap, "getLabelUidScopes").mockImplementation(async function* (...args) {
      for await (const scope of readScope(...args)) {
        mailboxes.set(folder, []);
        yield scope;
      }
    });
    await expect(view.starEmail("42", true, "INBOX")).rejects.toThrow("Mailbox temporarily unavailable");
    expect(client.messageFlagsAdd).not.toHaveBeenCalled();
  });
  it("keeps simultaneous facade operations' authorization snapshots isolated", async () => {
    const { view, imap, mailboxes } = fixture();
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    let release!: () => void;
    const delayed = new Promise<void>(resolve => { release = resolve; });
    const read = imap.getEmails.bind(imap);
    vi.spyOn(imap, "getEmails").mockImplementationOnce(async (...args) => {
      const emails = await read(...args);
      started();
      await delayed;
      return emails;
    });
    const first = view.getEmails("INBOX").catch(error => error);
    await ready;
    try {
      mailboxes.set(folder, mailboxes.get(folder)!.filter(message => message.internalId === "proton-sent"));
      expect((await view.getEmailById("8", "Sent"))?.body).toContain("Approved sent body");
    } finally { release(); }
    expect(await first).toMatchObject({ message: expect.stringContaining("Mailbox temporarily unavailable") });
  });
  it("discards aggregate results if an earlier read was revoked before a later read", async () => {
    const { view, mailboxes } = fixture();
    expect(await view.getEmails("INBOX")).toHaveLength(1);
    mailboxes.set(folder, mailboxes.get(folder)!.filter(message => message.internalId === "proton-sent"));
    expect(await view.getEmails("Sent")).toHaveLength(1);
    await expect(assertLabelAccessCurrent(view)).rejects.toThrow("Mailbox temporarily unavailable");
  });
  it.each([
    ["reply_to_email", "addition"], ["reply_to_email", "revocation"],
    ["forward_email", "addition"], ["forward_email", "revocation"],
  ])("preserves only the %s delivery receipt after a label %s during SMTP", async (tool, change) => {
    const { view, mailboxes, hidden } = fixture();
    const sendEmail = vi.fn(async () => {
      if (change === "addition") mailboxes.get(folder)!.push({ ...hidden, uid: "902" });
      else mailboxes.set(folder, mailboxes.get(folder)!.filter(message => message.internalId !== "proton-a"));
      return { success: true, messageId: "<sent-receipt@example.com>" };
    });
    const ctx = {
      args: { emailId: "42", folder: "INBOX", to: "recipient@example.com", body: "Thanks" },
      imapService: view, smtpService: { sendEmail }, config: { smtp: { username: "owner@example.com" } },
      getCallerAllowedFolders: () => undefined, invalidateAnalytics: vi.fn(),
      actionOk: (messageId?: string) => ({ content: [], structuredContent: { success: true, messageId } }),
      MAX_SUBJECT_LENGTH: 998, MAX_BODY_LENGTH: 10_000,
    } as unknown as ToolCallContext;
    const result = await executeMailTool({
      invoke: record => { ctx.recordMailDelivery = record; return sending[tool](ctx); },
      validate: () => assertLabelAccessCurrent(view),
    });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      success: true, messageId: "<sent-receipt@example.com>", reason: expect.stringContaining("Do not resend"),
    });
    for (const secret of ["Approved body", "Same subject", "sender@example.com", folder]) {
      expect(JSON.stringify(result)).not.toContain(secret);
    }
    if (change === "revocation") expect(await view.getEmailById("42", "INBOX")).toBeNull();
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

it("keeps an empty effective folder allowlist deny-all instead of treating it as unrestricted", async () => {
  const getEmails = vi.fn();
  await expect(reading.get_emails({
    args: { folder: "INBOX" }, imapService: { getEmails }, limits: { maxEmailListResults: 50 },
    getCallerAllowedFolders: () => labelAllowedFolders(folder, [folder]),
  } as unknown as ToolCallContext)).rejects.toThrow("outside this agent's folder allowlist");
  expect(getEmails).not.toHaveBeenCalled();
  expect(() => scopeLabelTool("get_emails", { folder: "labels/ai-accessible" }, folder)).toThrow("Folder not found");
});
