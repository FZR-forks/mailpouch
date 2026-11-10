import { describe, it, expect, vi } from "vitest";
import { accessLabelFolder, scopeLabelTool, requireLabelToolScope, labelAllowedFolders, labelScopedImap } from "./label-access.js";
import { SimpleIMAPService } from "../services/simple-imap-service.js";
import { handlers as reading } from "../tools/reading.js";
import type { ToolCallContext } from "../tools/types.js";

const folder = "Labels/AI-Accessible";

describe("global AI label boundary", () => {
  it.each([null, 3, false, " ", " AI ", "AI/Other", "../INBOX", "AI\r\nSent"])("fails closed on invalid configuration %j", label => {
    expect(() => accessLabelFolder(label)).toThrow();
  });
  it("supports opt-in labels without widening agent grants", () => {
    expect(accessLabelFolder(undefined)).toBeUndefined();
    expect(accessLabelFolder("AI-Accessible")).toBe(folder);
    expect(labelAllowedFolders(folder, ["INBOX"])).toEqual([]);
    expect(labelAllowedFolders(folder, [folder, "INBOX"])).toEqual([folder]);
  });
  it.each(["get_emails", "get_email_by_id", "search_emails", "get_thread", "download_attachment", "reply_to_email", "forward_email"])("scopes omitted paths and blocks explicit foreign paths for %s", tool => {
    const args = {};
    scopeLabelTool(tool, args, folder);
    expect(args).toEqual({ folder });
    for (const path of ["INBOX", "Sent", "Labels/Other", "labels/ai-accessible", "", null]) {
      expect(() => scopeLabelTool(tool, { folder: path }, folder)).toThrow();
    }
  });
  it.each([["*"], ["all"], [folder, "INBOX"], [], "INBOX"])("blocks search expansion %j", folders => {
    expect(() => scopeLabelTool("search_emails", { folders }, folder)).toThrow();
  });
  it.each(["fts_search", "fts_status", "fts_rebuild", "sync_emails", "get_logs", "get_contacts", "get_email_analytics", "save_draft", "list_scheduled_emails", "cancel_scheduled_email", "list_pending_reminders", "check_reminders", "remove_label", "move_to_label", "rename_folder", "future_unreviewed_tool"])("denies unscoped surface %s", tool => {
    expect(() => scopeLabelTool(tool, {}, folder)).toThrow();
  });
  it.each(["send_email", "schedule_email", "send_test_email"])("preserves sending %s", tool => {
    expect(() => scopeLabelTool(tool, {}, folder)).not.toThrow();
  });
  it("allows only the configured label's UID namespace", () => {
    expect(() => scopeLabelTool("get_emails_by_label", { label: "Other" }, folder)).toThrow();
    expect(() => scopeLabelTool("mark_email_read", { sourceFolder: "INBOX" }, folder)).toThrow();
  });

  it("filters counts and labels before a tool can return metadata", async () => {
    const imap = new SimpleIMAPService();
    vi.spyOn(imap, "syncFolders").mockResolvedValue([
      { name: "Inbox", path: "INBOX", totalMessages: 123, unreadMessages: 10 },
      { name: "AI-Accessible", path: folder, totalMessages: 2, unreadMessages: 1 },
    ]);
    const ok = (structuredContent: Record<string, unknown>) => ({ content: [], structuredContent });
    const ctx = { imapService: labelScopedImap(imap, folder), ok } as unknown as ToolCallContext;
    expect((await reading.get_unread_count(ctx)).structuredContent).toEqual({ unreadByFolder: { [folder]: 1 }, totalUnread: 1 });
    expect(JSON.stringify((await reading.list_labels(ctx)))).not.toContain("INBOX");
  });

  it("bypasses cached search content and rejects any implicit mailbox fallback", async () => {
    const imap = new SimpleIMAPService();
    const search = vi.spyOn(imap, "searchEmails").mockResolvedValue([]);
    const scoped = labelScopedImap(imap, folder);
    await scoped.searchEmails({ folder, subject: "Test" });
    expect(search).toHaveBeenCalledWith({ folder, subject: "Test" }, true);
    expect(() => scoped.searchEmails({ folders: ["*"] })).toThrow();
  });

  it("reads current search content when a rebuilt label reuses a cached UID", async () => {
    const imap = new SimpleIMAPService();
    const cached = { id: "42", folder, body: "revoked cached text", attachments: [] };
    Object.assign(imap, { isConnected: true, client: {
      usable: true,
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      search: vi.fn().mockResolvedValue([42]),
      fetch: vi.fn(async function* () {
        yield { uid: 42, flags: new Set(), source: Buffer.from("From: new@example.com\r\nSubject: Newly authorized\r\nMessage-ID: <new@example.com>\r\n\r\nCurrent labeled text") };
      }),
    } });
    vi.spyOn(imap as never as { ensureConnection: () => Promise<void> }, "ensureConnection").mockResolvedValue();
    vi.spyOn(imap as never as { getCacheEntry: () => unknown }, "getCacheEntry").mockReturnValue(cached);
    const scoped = labelScopedImap(imap, folder);
    const results = await scoped.searchEmails({ folder });
    expect(results).toHaveLength(1);
    expect(results[0].body).toContain("Current labeled text");
    expect(results[0].messageId).toBe("<new@example.com>");
    expect(JSON.stringify(results)).not.toContain("revoked cached text");
  });

  it("does not return a cached message or attachment after label revocation", async () => {
    const imap = new SimpleIMAPService();
    const cached = { id: "42", folder, body: "private cached text", attachments: [{ filename: "secret", content: Buffer.from("secret"), size: 6 }] };
    // A real stale cache with a live server reporting that UID absent.
    Object.assign(imap, { isConnected: true, client: {
      usable: true,
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      fetch: vi.fn(async function* () {}),
    } });
    vi.spyOn(imap as never as { requireReadConnection: () => Promise<void> }, "requireReadConnection").mockResolvedValue();
    vi.spyOn(imap as never as { getCacheEntry: () => unknown }, "getCacheEntry").mockReturnValue(cached);
    const scoped = labelScopedImap(imap, folder);
    expect(await imap.getEmailById("42", folder)).toBe(cached);
    expect(await scoped.getEmailById("42", folder)).toBeNull();
    expect(await scoped.downloadAttachment("42", 0, folder)).toBeNull();
    expect(() => scoped.getEmailById("42", "INBOX")).toThrow();
  });
});


describe("label policy denial audit", () => {
  it.each(["get_email_by_id", "read_surface:get_email_by_id"])("records a known caller's %s denial without retaining mail arguments", tool => {
    const write = vi.fn();
    const args = { folder: "INBOX", body: "private contents" };
    expect(() => requireLabelToolScope({
      tool, args, readFolder: () => folder,
      caller: { clientId: "test-agent", clientName: "Test agent", ip: "127.0.0.1" },
      audit: { write }, errorMessage: e => (e as Error).message,
    })).toThrow("only the configured AI access label");
    expect(write).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      tool, clientId: "test-agent", ok: false, blockedReason: expect.stringContaining("label policy:"),
      argHash: expect.any(String), ip: "127.0.0.1",
    }));
    expect(JSON.stringify(write.mock.calls)).not.toContain("private contents");
  });
  it("audits unreadable configuration and rethrows the exact original error", () => {
    const error = new Error("Unreadable access policy");
    const write = vi.fn();
    let received: unknown;
    try {
      requireLabelToolScope({ tool: "send_email", args: {},
        readFolder: () => { throw error; },
        caller: { clientId: "agent", clientName: "Agent" },
        audit: { write }, errorMessage: e => (e as Error).message,
      });
    } catch (caught) { received = caught; }
    expect(received).toBe(error);
    expect(write).toHaveBeenCalledTimes(1);
  });
  it("preserves trusted callers without inventing an audit identity", () => {
    const write = vi.fn();
    expect(() => requireLabelToolScope({ tool: "get_emails", args: { folder: "INBOX" },
      readFolder: () => folder, audit: { write }, errorMessage: String,
    })).toThrow();
    expect(write).not.toHaveBeenCalled();
  });
});
