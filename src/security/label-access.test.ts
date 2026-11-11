import { describe, it, expect, vi } from "vitest";
import { accessLabelFolder, scopeLabelTool, requireLabelToolScope, labelAllowedFolders, labelScopedImap, assertLabelAccessCurrent, labelToolVisible, LABEL_HIDDEN_TOOLS } from "./label-access.js";
import { allToolDefs } from "../tools/registry.js";
import { SimpleIMAPService } from "../services/simple-imap-service.js";
import { handlers as reading } from "../tools/reading.js";
import { handlers as sending } from "../tools/sending.js";
import { executeMailTool } from "../services/mail-tool-execution.js";
import type { ToolCallContext } from "../tools/types.js";
import { logger } from "../utils/logger.js";
import type { EmailMessage } from "../types/index.js";

const folder = "Labels/AI-Accessible";
/** The authorization scope of one source folder, as the facade computes it. */
async function scopeOf(imap: SimpleIMAPService, path: string) {
  for await (const scope of imap.getLabelUidScopes([path], folder)) return scope;
  throw new Error("no scope");
}
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
      const [a, b = a] = part.split(":").map(value => value === "*" ? Infinity : Number(value));
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
    fetch: vi.fn(async function* (range: string, query: { headers?: unknown; source?: boolean; bodyParts?: unknown }, options?: { uid?: boolean }) {
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
    capabilities: new Map<string, unknown>([["MOVE", true], ["UIDPLUS", true]]),
    messageMove: vi.fn(async (range: string, target: string) => relocate(range, target, true)),
    messageCopy: vi.fn(async (range: string, target: string) => relocate(range, target, false)),
    messageDelete: vi.fn(async (range: string) => {
      const gone = new Set(pick(range, true));
      mailboxes.set(selected, mailboxes.get(selected)!.filter(m => !gone.has(m)));
      return true;
    }),
  };
  /** MOVE/COPY with UIDPLUS-style results; copies keep the Bridge identity under a new UID. */
  function relocate(range: string, target: string, remove: boolean) {
    const destination = mailboxes.get(target);
    if (!destination) return false;
    const chosen = pick(range, true);
    const uidMap = new Map<number, number>();
    for (const m of chosen) {
      const uid = Math.max(1000, ...destination.map(d => Number(d.uid))) + 1;
      destination.push({ ...m, uid: String(uid) });
      uidMap.set(Number(m.uid), uid);
    }
    if (remove) mailboxes.set(selected, mailboxes.get(selected)!.filter(m => !chosen.includes(m)));
    return { uidMap };
  }
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
    expect(client.fetch.mock.calls.filter(([, query]) => query.bodyParts || query.source).map(([range]) => range)).toEqual(["42", "8"]);
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
  it("never serves scoped reads from the body cache", async () => {
    const { imap } = fixture();
    const cached = { id: "42", folder: "INBOX", body: "Stale private body", to: [], subject: "Stale", from: "private@example.com", date: new Date(), isRead: false, isStarred: false, isHtml: false, hasAttachment: false } as EmailMessage;
    (imap as unknown as { setCacheEntry: (id: string, email: EmailMessage) => void }).setCacheEntry("42", cached);
    const scope = await scopeOf(imap, "INBOX");
    expect((await imap.searchEmails({ folder: "INBOX" }, new Map([["INBOX", scope]])))[0].body).toContain("Approved body");
    expect((await imap.getEmailById("42", "INBOX", scope))?.body).toContain("Approved body");
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
      // One shared authorization snapshot, plus one final check only when mail was
      // released, independent of the number of folders. Searches only scan their first 20.
      expect(scanned.filter(path => path === folder)).toHaveLength(operation === "lookup without a folder" ? 1 : 2);
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
  it("checks the All Mail union last in folderless lookups, even when it is listed first", async () => {
    const f = fixture();
    const existing = [...f.mailboxes];
    f.mailboxes.clear();
    f.mailboxes.set("All Mail", [{ ...f.approved }]);
    existing.forEach(([path, messages]) => f.mailboxes.set(path, messages));
    f.generations.set("All Mail", 1n);
    expect((await f.view.getEmailById("42"))?.folder).toBe("INBOX");
  });
  it("searches skip folders without approved mail, including non-selectable parents", async () => {
    const f = fixture();
    f.mailboxes.set("Archive", []);
    f.generations.set("Archive", 1n);
    f.client.list.mockResolvedValue([...f.mailboxes.keys(), "Labels"].map(path => ({ path, flags: new Set(path === "Labels" ? ["\\Noselect"] : []) })));
    vi.mocked(f.imap.syncFolders).mockResolvedValue([...f.mailboxes.keys(), "Labels"].map(path => ({ path, name: path, totalMessages: 0, unreadMessages: 0, folderType: "system" })));
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    await f.view.searchEmails({ folders: ["*"] });
    const locks = f.client.getMailboxLock.mock.calls.map(([path]) => path);
    expect(locks.filter(path => path === "Archive")).toHaveLength(1); // scope read only, no search
    expect(locks).not.toContain("Labels");
    expect(warn.mock.calls.filter(([message]) => /Search failed/.test(String(message)))).toEqual([]);
  });
  it("incremental identity reads never skip UIDs below one cached by a targeted read", async () => {
    const { imap } = fixture();
    await imap.readMailboxEntries("INBOX", ["43"]);
    expect((await imap.readNewMailboxEntries("INBOX")).map(entry => entry.uid).sort()).toEqual(["42", "43"]);
  });
  it("refreshes label membership between multi-folder operations", async () => {
    const { view, client, mailboxes } = fixture();
    expect((await view.getFolders()).map(entry => entry.totalMessages)).toEqual([1, 1, 1]);
    mailboxes.set(folder, []);
    expect((await view.getFolders()).map(entry => entry.totalMessages)).toEqual([0, 0, 0]);
    expect(await view.searchEmails({ folders: ["*"] })).toEqual([]);
    // The first listing re-proves what it released; later reads released nothing, so need no final check.
    expect(client.getMailboxLock.mock.calls.filter(([path]) => path === folder)).toHaveLength(4);
  });
  it.each(["list", "lookup", "search", "attachment"])("discards %s results if the label is removed during body retrieval", async operation => {
    const { view, client, mailboxes } = fixture();
    const fetch = client.fetch.getMockImplementation()!;
    client.fetch.mockImplementation(async function* (...args) {
      try { yield* fetch(...args); }
      finally { if (args[1].source || args[1].bodyParts) mailboxes.set(folder, []); }
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
  it("keeps results when only the access mailbox's UIDs are rebuilt, since membership is by Bridge identity", async () => {
    const { view, imap, generations } = fixture();
    const read = imap.getEmails.bind(imap);
    vi.spyOn(imap, "getEmails").mockImplementation(async (...args) => {
      const emails = await read(...args);
      generations.set(folder, 2n);
      return emails;
    });
    expect((await view.getEmails("INBOX")).map(m => m.id)).toEqual(["42"]);
  });
  it("keeps results when unrelated mail gains the label during a read", async () => {
    const { view, imap, mailboxes, hidden } = fixture();
    const read = imap.getEmails.bind(imap);
    vi.spyOn(imap, "getEmails").mockImplementation(async (...args) => {
      const emails = await read(...args);
      mailboxes.get(folder)!.push({ ...hidden, uid: "905" });
      return emails;
    });
    expect((await view.getEmails("INBOX")).map(m => m.id)).toEqual(["42"]);
  });
  it("discards results if released mail loses the label or the access mailbox disappears during a read", async () => {
    for (const change of ["replace membership", "delete"]) {
      const { view, imap, mailboxes, hidden } = fixture();
      const read = imap.getEmails.bind(imap);
      vi.spyOn(imap, "getEmails").mockImplementation(async (...args) => {
        const emails = await read(...args);
        // A real revocation: the approved copy leaves the label and unrelated mail joins under a new UID.
        if (change === "replace membership") mailboxes.set(folder, [{ ...hidden, uid: "906" }, ...mailboxes.get(folder)!.slice(1)]);
        else mailboxes.delete(folder);
        return emails;
      });
      await expect(view.getEmails("INBOX")).rejects.toThrow("Mailbox temporarily unavailable");
    }
  });
  it("never releases a different message when a source UID's content no longer matches its approved identity", async () => {
    for (const read of ["list", "lookup", "search", "attachment"]) {
      const { view, imap, mailboxes, hidden } = fixture();
      // Warm the identity index, then make INBOX UID 42 hold other mail without a new UIDVALIDITY.
      await view.getEmails("INBOX");
      mailboxes.get("INBOX")![0] = { ...hidden, uid: "42" };
      const result = read === "list" ? view.getEmails("INBOX")
        : read === "lookup" ? view.getEmailById("42", "INBOX")
          : read === "search" ? view.searchEmails({ folder: "INBOX" })
            : imap.downloadAttachment("42", 0, "INBOX", await scopeOf(imap, "INBOX"));
      await expect(result).rejects.toThrow(/Mailbox (temporarily unavailable|changed)/);
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
    // Unrelated mail gaining the label is not a revocation: the normal result is kept.
    expect(result.structuredContent).toEqual(change === "addition"
      ? { success: true, messageId: "<sent-receipt@example.com>" }
      : { success: true, messageId: "<sent-receipt@example.com>", reason: expect.stringContaining("Do not resend") });
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
    await expect(view.markEmailRead("43", true, "INBOX")).rejects.toThrow("Email 43 not found");
    expect(approved.flags.has("\\Seen")).toBe(true);
    expect(hidden.flags.has("\\Seen")).toBe(false);
    expect(await view.bulkStar(["42", "43"], true, "INBOX")).toMatchObject({ success: 1, failed: 1 });
    expect(client.messageFlagsAdd.mock.calls.every(([range]) => range === "42")).toBe(true);
  });
  it("fails closed if the physical mailbox rebuilds between authorization and reading", async () => {
    const { imap, generations } = fixture();
    const scope = await scopeOf(imap, "INBOX");
    generations.set("INBOX", 2n);
    await expect(imap.getEmails("INBOX", 50, 0, scope)).rejects.toThrow("Mailbox changed");
    await expect(imap.getEmailById("42", "INBOX", scope)).rejects.toThrow("Mailbox changed");
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
    expect(() => scopeLabelTool("fts_search", {}, folder)).toThrow("Unknown tool: fts_search");
  });
});

describe("label-scoped organizing, drafts, and tool visibility", () => {
  const withMailbox = (f: ReturnType<typeof fixture>, path: string) => { f.mailboxes.set(path, []); f.generations.set(path, 1n); };

  it("moves approved mail, keeps it approved, and treats unapproved mail as absent", async () => {
    const f = fixture();
    withMailbox(f, "Archive");
    expect(await f.view.moveEmail("42", "Archive", "INBOX")).toBe(true);
    expect(f.mailboxes.get("Archive")!.map(m => m.internalId)).toEqual(["proton-a"]);
    expect((await f.view.getEmails("Archive")).map(m => m.body)).toEqual(["Approved body"]);
    await expect(f.view.moveEmail("43", "Archive", "INBOX")).rejects.toThrow("Email 43 not found");
    expect(f.mailboxes.get("INBOX")!.map(m => m.internalId)).toEqual(["proton-hidden"]);
    // Folderless moves resolve the approved source exactly as reads do.
    withMailbox(f, "Trash");
    expect(await f.view.moveEmail("8", "Trash")).toBe(true);
    expect(f.mailboxes.get("Trash")!.map(m => m.internalId)).toEqual(["proton-sent"]);
  });

  it("bulk-moves only approved UIDs and reports the rest as not found", async () => {
    const f = fixture();
    withMailbox(f, "Archive");
    expect(await f.view.bulkMoveEmails(["42", "43"], "Archive", "INBOX")).toMatchObject({ success: 1, failed: 1, errors: ["Email 43 not found"] });
    expect(f.client.messageMove.mock.calls.map(([range]) => range)).toEqual(["42"]);
  });

  it("adds and removes other labels only on approved mail", async () => {
    const f = fixture();
    expect(await f.view.bulkCopyToFolder(["42", "43"], "Labels/Work", "INBOX")).toMatchObject({ success: 1, failed: 1 });
    expect(f.mailboxes.get("Labels/Work")!.every(m => m.internalId === "proton-a")).toBe(true);
    expect(await f.view.deleteFromFolder("19", "Labels/Work")).toBe(true);
    expect(f.mailboxes.get(folder)!.map(m => m.internalId)).toContain("proton-a");
  });

  it("never targets, removes, renames, or recreates the access label", async () => {
    const f = fixture();
    await expect(f.view.moveEmail("42", folder, "INBOX")).rejects.toThrow("Folder not found");
    await expect(f.view.copyEmailToFolder("42", "labels/ai-accessible", "INBOX")).rejects.toThrow("Folder not found");
    await expect(f.view.deleteFromFolder("900", folder)).rejects.toThrow("Folder not found");
    await expect(f.view.renameFolder(folder, "Labels/Other")).rejects.toThrow("Folder not found");
    await expect(f.view.renameFolder("Labels/Work", folder)).rejects.toThrow("Folder not found");
    await expect(f.view.createFolder(folder)).rejects.toThrow("Folder not found");
    await expect(f.view.ensureFolderExists(folder)).rejects.toThrow("Folder not found");
    for (const [tool, args] of [
      ["move_to_label", { emailId: "42", label: "AI-Accessible" }], ["bulk_remove_label", { emailIds: ["900"], label: "ai-accessible" }],
      ["move_to_folder", { emailId: "42", folder }], ["move_email", { emailId: "42", targetFolder: folder }],
      ["rename_folder", { oldName: folder, newName: "Labels/X" }], ["create_folder", { folderName: folder }],
    ] as const) expect(() => scopeLabelTool(tool, { ...args }, folder)).toThrow("Folder not found");
    expect(f.client.messageMove).not.toHaveBeenCalled();
    expect(f.client.messageCopy).not.toHaveBeenCalled();
  });

  it("refuses a scoped mutation if the source mailbox rebuilds after authorization", async () => {
    const f = fixture();
    withMailbox(f, "Archive");
    const readScopes = f.imap.getLabelUidScopes.bind(f.imap);
    vi.spyOn(f.imap, "getLabelUidScopes").mockImplementation(async function* (...args) {
      for await (const scope of readScopes(...args)) {
        f.generations.set("INBOX", 2n);
        yield scope;
      }
    });
    await expect(f.view.moveEmail("42", "Archive", "INBOX")).rejects.toThrow("Mailbox temporarily unavailable");
    expect(f.client.messageMove).not.toHaveBeenCalled();
  });

  it("denies service members that have no label-scoped form, without breaking promise resolution", async () => {
    const { view, imap } = fixture();
    const raw = vi.spyOn(imap, "deleteEmail");
    for (const call of [() => view.deleteEmail("42"), () => view.bulkDeleteEmails(["42"]), () => view.emptyTrash(), () => view.deleteFolder("Labels/Work")]) {
      await expect(call()).rejects.toThrow("Mailbox operation unavailable");
    }
    expect(raw).not.toHaveBeenCalled();
    expect(await Promise.resolve(view)).toBe(view);
  });

  it("saves drafts with a server-generated Message-ID and labels them durably", async () => {
    const { imap } = fixture();
    const drafts = { prepare: vi.fn(async () => true), discard: vi.fn(), processNow: vi.fn(async () => {}) };
    const view = labelScopedImap(imap, folder, { drafts, messageIdDomain: "example.com" });
    const save = vi.spyOn(imap, "saveDraft").mockResolvedValueOnce({ success: true, uid: 5 });
    expect(await view.saveDraft({ subject: "Plan" })).toEqual({ success: true, uid: 5 });
    const [[messageId, labelFolder, mailbox]] = drafts.prepare.mock.calls as unknown as Array<[string, string, string]>;
    expect(messageId).toMatch(/^<[0-9a-f-]+@example\.com>$/);
    expect([labelFolder, mailbox]).toEqual([folder, "drafts"]);
    expect(save).toHaveBeenCalledWith({ subject: "Plan", messageId });
    expect(drafts.processNow).toHaveBeenCalledTimes(1);

    save.mockResolvedValueOnce({ success: false, error: "No Drafts folder" });
    expect(await view.saveDraft({ subject: "Plan" })).toMatchObject({ success: false });
    expect(drafts.discard).toHaveBeenCalledTimes(1);

    save.mockClear();
    await expect(labelScopedImap(imap, folder).saveDraft({ subject: "Plan" })).rejects.toThrow("Mailbox temporarily unavailable");
    expect(save).not.toHaveBeenCalled();
  });

  it("reuses cached identities so repeat reads fetch headers only for new UIDs", async () => {
    const { view, client, mailboxes, approved } = fixture();
    const identityFetches = () => client.fetch.mock.calls.filter(([, query]) => query.headers && !query.bodyParts).length;
    await view.getEmails("INBOX");
    const first = identityFetches();
    await view.getEmails("INBOX");
    expect(identityFetches()).toBe(first);
    const next = { ...approved, uid: "44", internalId: "proton-next", flags: new Set<string>() };
    mailboxes.get("INBOX")!.push(next);
    mailboxes.get(folder)!.push({ ...next, uid: "904" });
    expect((await view.getEmails("INBOX")).map(m => m.id)).toEqual(["44", "42"]);
    expect(client.fetch.mock.calls.filter(([range, query]) => query.headers && !query.bodyParts && range !== "44" && range !== "904").length).toBe(first);
  });

  it("validates only released mail: another approved message losing the label does not fail a read", async () => {
    const { view, imap, mailboxes, approved } = fixture();
    const other = { ...approved, uid: "44", internalId: "proton-other", flags: new Set<string>() };
    mailboxes.get("INBOX")!.push(other);
    mailboxes.get(folder)!.push({ ...other, uid: "904" });
    const read = imap.getEmailById.bind(imap);
    vi.spyOn(imap, "getEmailById").mockImplementation(async (...args) => {
      const email = await read(...args);
      mailboxes.set(folder, mailboxes.get(folder)!.filter(m => m.internalId !== "proton-other"));
      return email;
    });
    expect((await view.getEmailById("42", "INBOX"))?.body).toContain("Approved body");
    await expect(assertLabelAccessCurrent(view)).resolves.toBeUndefined();
  });

  it("lists only the named UID for a lookup, not the whole source mailbox", async () => {
    const { view, client } = fixture();
    await view.getEmailById("42", "INBOX");
    const listings = client.fetch.mock.calls.filter(([, query]) => !query.headers && !query.source && !query.bodyParts);
    // The access label is listed in full (small); INBOX only for UID 42.
    expect(listings.map(([range]) => range)).toEqual(["1:*", "42", "1:*"]);
  });

  it("copies in the background only after proving the message's identity in that mailbox generation", async () => {
    const { imap, client, mailboxes, generations } = fixture();
    await expect(imap.copyVerifiedToFolder("42", "Labels/Work", "INBOX", h => h.internalId === "proton-hidden")).rejects.toThrow("Mailbox changed");
    expect(client.messageCopy).not.toHaveBeenCalled();
    // A rebuild between the identity proof and the COPY is refused under the COPY's own lock.
    const lock = client.getMailboxLock.getMockImplementation()!;
    let locks = 0;
    client.getMailboxLock.mockImplementation(async (path: string) => {
      if (path === "INBOX" && ++locks === 2) generations.set("INBOX", 2n);
      return lock(path);
    });
    await expect(imap.copyVerifiedToFolder("42", "Labels/Work", "INBOX", h => h.internalId === "proton-a")).rejects.toThrow("Mailbox changed");
    expect(client.messageCopy).not.toHaveBeenCalled();
    client.getMailboxLock.mockImplementation(lock);
    expect(await imap.copyVerifiedToFolder("42", "Labels/Work", "INBOX", h => h.internalId === "proton-a")).toBe(true);
    expect(mailboxes.get("Labels/Work")!.filter(m => m.internalId === "proton-a")).toHaveLength(2);
  });

  it("classifies every registered tool and hides only tools without a scoped form", () => {
    const unclassified = allToolDefs().map(def => def.name).filter(name => !labelToolVisible(name) && !LABEL_HIDDEN_TOOLS.has(name));
    expect(unclassified).toEqual([]);
    for (const tool of ["delete_email", "bulk_delete_emails", "empty_trash", "delete_folder", "fts_search", "get_logs", "remind_if_no_reply", "list_pending_reminders"]) {
      expect(LABEL_HIDDEN_TOOLS.has(tool)).toBe(true);
      expect(labelToolVisible(tool)).toBe(false);
    }
    for (const tool of ["move_to_trash", "archive_email", "move_email", "move_to_label", "remove_label", "save_draft",
      "list_scheduled_emails", "cancel_scheduled_email", "create_folder", "rename_folder", "pass_get", "alias_list", "start_bridge"]) {
      expect(labelToolVisible(tool)).toBe(true);
    }
    expect(labelToolVisible("some_future_tool")).toBe(false);
  });
});

describe("mailbox policy denial audit", () => {
  it.each(["get_logs", "read_surface:get_logs"])("records a known caller's %s denial without retaining arguments", tool => {
    const write = vi.fn();
    expect(() => requireLabelToolScope({ tool, args: { body: "private contents" }, readFolder: () => folder,
      caller: { clientId: "test-agent", clientName: "Test agent" }, audit: { write }, errorMessage: e => (e as Error).message,
    })).toThrow("Unknown tool");
    expect(write).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ tool, ok: false, argHash: expect.any(String) }));
    expect(JSON.stringify(write.mock.calls)).not.toContain("private contents");
  });
  it.each(["pass_get", "alias_list", "restart_server", "get_connection_status"])("never reads the mail policy for non-mail tool %s, even when it is unreadable", tool => {
    const readFolder = vi.fn(() => { throw new Error("Mailbox unavailable"); });
    const write = vi.fn();
    expect(requireLabelToolScope({ tool, args: {}, readFolder, caller: { clientId: "a", clientName: "A" }, audit: { write }, errorMessage: String })).toBeUndefined();
    expect(readFolder).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
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
