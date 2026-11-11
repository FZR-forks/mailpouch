/** Server-wide mail boundary. Every registered tool is classified; unknown/new tools are hidden and denied until reviewed. */
import { randomUUID } from "node:crypto";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { MailboxMutationDeadlineError } from "../services/mailbox-mutation-deadline.js";
import { withMailboxScopes } from "../services/mailbox-scope-guard.js";
import { logger } from "../utils/logger.js";
import type { EmailFolder, EmailMessage, SaveDraftOptions, SearchEmailOptions } from "../types/index.js";
import { SEARCH_FOLDER_CAP, type MailboxUidScope, type SimpleIMAPService } from "../services/simple-imap-service.js";
import { hashArgs, type AgentAuditLog } from "../agents/audit.js";
import type { CallerContext } from "../agents/caller-context.js";
import { validateLabelName } from "../utils/helpers.js";

const labelAccessChecks = new WeakMap<SimpleIMAPService, () => Promise<void>>();

/** Revalidate all mail used by a request before releasing combined tool, resource, or prompt results. */
export async function assertLabelAccessCurrent(imap: SimpleIMAPService): Promise<void> {
  const check = labelAccessChecks.get(imap);
  if (check) await mailboxOperation(check);
}

/** Resolve a configured label name; invalid policy values fail closed. */
export function accessLabelFolder(label: unknown): string | undefined {
  if (label === undefined || label === "") return undefined;
  if (typeof label !== "string" || label !== label.trim() || validateLabelName(label)) {
    throw new McpError(ErrorCode.InvalidRequest, "Mailbox unavailable. Ask the account owner to check mail settings.");
  }
  return `Labels/${label}`;
}

/** Mail tools whose reads and writes go through the label-filtered backend facade. */
const SCOPED_MAIL_TOOLS = new Set([
  // Reading and folder metadata.
  "get_emails", "get_email_by_id", "search_emails", "download_attachment", "get_thread", "extract_action_items",
  "extract_meeting", "sync_emails", "get_emails_by_label", "get_folders", "sync_folders", "get_unread_count", "list_labels",
  // Analytics computed per call from filtered Inbox/Sent.
  "get_email_stats", "get_email_analytics", "get_contacts", "get_volume_trends", "get_correspondence_profile",
  // Flags.
  "mark_email_read", "star_email", "mark_answered", "mark_forwarded", "bulk_mark_read", "bulk_star",
  // Organizing approved messages. Moves keep the access label; the access label itself is never a target.
  "move_email", "archive_email", "move_to_trash", "move_to_spam", "move_to_folder", "bulk_move_emails",
  "move_to_label", "bulk_move_to_label", "remove_label", "bulk_remove_label", "create_folder", "rename_folder",
  // Composing. Outgoing mail and drafts are labeled automatically.
  "send_email", "reply_to_email", "forward_email", "send_test_email", "save_draft", "schedule_email",
  "list_scheduled_emails", "cancel_scheduled_email", "list_proton_scheduled",
]);

/** Tools that never read or change mail. The label policy, even when unreadable, leaves them exactly as they are without it. */
const NON_MAIL_TOOLS = new Set([
  "setup_status", "request_permission_escalation", "check_escalation_status", "get_connection_status",
  "get_server_version", "clear_cache", "start_bridge", "shutdown_server", "restart_server",
]);
const NON_MAIL_TOOL_PREFIXES = /^(alias|pass)_/;

/**
 * Mail tools with no safe label-scoped form: permanent or whole-mailbox effects,
 * derived data built from unfiltered mail, or reply reminders (whose records
 * keep a message's subject and recipient after its label is removed).
 * Hidden while the policy is on.
 */
export const LABEL_HIDDEN_TOOLS: ReadonlySet<string> = new Set([
  "delete_email", "bulk_delete_emails", "bulk_delete", "empty_trash", "delete_folder",
  "fts_search", "fts_rebuild", "fts_status", "get_logs",
  "remind_if_no_reply", "list_pending_reminders", "cancel_reminder", "check_reminders",
]);

/** Tools outside the mail boundary; the label policy is never read for them. */
export function isNonMailTool(tool: string): boolean {
  return NON_MAIL_TOOLS.has(tool) || NON_MAIL_TOOL_PREFIXES.test(tool);
}

/** Whether a tool is listed and callable while the access-label policy is enabled. */
export function labelToolVisible(tool: string): boolean {
  return SCOPED_MAIL_TOOLS.has(tool) || isNonMailTool(tool);
}

/** Every mailbox path an argument set names, including label/folder shorthand forms. */
function requestedPaths(tool: string, args: Record<string, unknown>): string[] {
  const paths: unknown[] = [
    args.folder, args.sourceFolder, args.targetFolder, args.folderName, args.oldName, args.newName,
    ...(Array.isArray(args.folders) ? args.folders : []),
  ];
  if (typeof args.label === "string") paths.push(`Labels/${args.label}`);
  if (tool === "move_to_folder" && typeof args.folder === "string") paths.push(`Folders/${args.folder.trim()}`);
  return paths.filter((path): path is string => typeof path === "string").map(path => path.trim());
}

/** Preserve ordinary tool arguments; reject only hidden tools and the access mailbox itself. */
export function scopeLabelTool(tool: string, args: Record<string, unknown>, folder: string): void {
  // Indistinguishable from an unregistered tool, so the policy is not revealed.
  if (!labelToolVisible(tool)) throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${tool}`);
  if (requestedPaths(tool, args).some(path => isAccessPath(path, folder))) {
    throw new McpError(ErrorCode.InvalidParams, "Folder not found");
  }
}

/** The access mailbox (or anything nested under it), compared case-insensitively. */
function isAccessPath(path: string, folder: string): boolean {
  const candidate = path.toLowerCase();
  const control = folder.toLowerCase();
  return candidate === control || candidate.startsWith(`${control}/`);
}

/** Record policy/configuration denials for known callers, then preserve the original MCP error. */
export function requireLabelToolScope(options: {
  tool: string;
  args: Record<string, unknown>;
  readFolder: () => string | undefined;
  caller?: CallerContext;
  audit: Pick<AgentAuditLog, "write">;
  errorMessage: (error: unknown) => string;
}): string | undefined {
  const startedAt = Date.now();
  if (isNonMailTool(options.tool)) return undefined;
  try {
    const folder = options.readFolder();
    if (folder) scopeLabelTool(options.tool.replace(/^read_surface:/, ""), options.args, folder);
    return folder;
  } catch (error) {
    if (options.caller) {
      options.audit.write({
        ts: new Date(startedAt).toISOString(),
        clientId: options.caller.clientId,
        clientName: options.caller.clientName,
        tool: options.tool,
        argHash: hashArgs(options.args),
        ok: false,
        durMs: Date.now() - startedAt,
        blockedReason: `label policy: ${options.errorMessage(error)}`,
        ip: options.caller.ip,
      });
    }
    throw error;
  }
}

/** Keep existing per-agent folder restrictions; hide the operator-only control mailbox. */
export function labelAllowedFolders(folder: string | undefined, grant?: string[]): string[] | undefined {
  return folder && grant ? grant.filter(path => !isAccessPath(path, folder)) : grant;
}

/** Carries an ordinary mailbox error (already agent-safe) through the policy error mapping. */
class OperationError extends Error {
  constructor(readonly original: unknown) { super("Mailbox operation failed"); }
}

/** Keep backend policy and transport details in owner logs, not agent responses. */
async function mailboxOperation<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof OperationError) throw error.original;
    if (error instanceof MailboxMutationDeadlineError || error instanceof McpError) throw error;
    logger.warn("Filtered mailbox operation failed", "MailboxAccess", error);
    throw new McpError(ErrorCode.InternalError, "Mailbox temporarily unavailable");
  }
}

/** Run an existing service method on authorized UIDs; its own errors reach the agent as they would without the policy. */
async function passThrough<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof McpError || error instanceof MailboxMutationDeadlineError) throw error;
    // A lock-held scope proof failure is a policy event, not an ordinary error.
    if (error instanceof Error && error.message.startsWith("Mailbox changed during the request")) throw error;
    throw new OperationError(error);
  }
}

/** Durable labeling for drafts saved by the agent. */
export interface DraftLabeler {
  prepare(messageId: string, folder: string, mailbox: "drafts"): Promise<boolean>;
  discard(messageId: string): void;
  processNow(): Promise<void>;
}

export interface LabelScopeOptions {
  drafts?: DraftLabeler;
  /** Domain for server-generated draft Message-IDs (the account's own address domain). */
  messageIdDomain?: string;
}

type BulkResult = { success: number; failed: number; errors: string[] };

/** Service members that never return or change message content. */
const PASSTHROUGH_MEMBERS = new Set([
  "isActive", "healthCheck", "insecureTls", "idleLastIssue", "idleAuthFailure", "clearCache", "ensureMutationConnection",
]);

/** Request-scoped facade preserving folders/UIDs; revalidate combined results with assertLabelAccessCurrent. */
export function labelScopedImap(imap: SimpleIMAPService, folder: string | undefined, options: LabelScopeOptions = {}): SimpleIMAPService {
  if (!folder) return imap;
  const normalize = (path: string) => path.toUpperCase() === "INBOX" ? "INBOX" : path;
  const rawFolders = async () => (await imap.syncFolders()).filter(f => !isAccessPath(f.path, folder));
  /** Bridge identities of every message this request released; all must still be approved when it finishes. */
  const requestIdentities = new Set<string>();
  /** Fail if any released message lost the access label. Mail gaining it never matters. */
  const assertStillApproved = async (identities: ReadonlySet<string>) => {
    if (!identities.size) return;
    const labeled = await imap.readLabelIdentities(folder);
    if ([...identities].some(identity => !labeled.has(identity))) {
      throw new Error("Mailbox changed during the request; retry the operation");
    }
  };
  /** Remove Bridge label metadata before exposing message headers to an agent. */
  const cleanEmail = (email: EmailMessage): EmailMessage => ({
    ...email,
    ...(email.headers ? { headers: Object.fromEntries(Object.entries(email.headers)
      .filter(([key]) => !/^x-pm-.*label/i.test(key))) } : {}),
  });
  const notFound = (id: string) => `Email ${id} not found`;
  const denyAccessPath = (...paths: Array<string | undefined>) => {
    if (paths.some(path => path !== undefined && isAccessPath(path, folder))) {
      throw new McpError(ErrorCode.InvalidParams, "Folder not found");
    }
  };

  /** Per-invocation state, isolated between simultaneous calls on the same facade. */
  const createOperation = () => {
    const released = new Set<string>();
    /** Record a returned message (or a whole scope, for aggregates) for release validation. */
    const release = (scope: MailboxUidScope, uids: Iterable<string> = scope.uids) => {
      const identities = imap.scopeIdentities(scope);
      for (const uid of uids) {
        const identity = identities.get(uid);
        if (!identity) throw new Error("Mailbox scope is unavailable");
        released.add(identity);
      }
    };
    /**
     * Validate visible folder paths and cap searches before scanning source
     * identities. With `uids`, only those UIDs are listed in each folder.
     */
    const scopesFor = async function* (paths?: string[], entries?: EmailFolder[], limit?: number, uids?: string[]): AsyncGenerator<MailboxUidScope> {
      const available = entries ?? await rawFolders();
      const availablePaths = new Set(available.map(entry => entry.path));
      // Like getEmailById, a folderless lookup checks the All Mail union last so a real folder wins.
      const isAllMail = (entry: EmailFolder) => entry.specialUse === "\\All" || entry.path === "All Mail";
      const requested = paths ? [...new Set(paths.map(normalize))]
        : [...available.filter(entry => !isAllMail(entry)), ...available.filter(isAllMail)].map(entry => entry.path);
      if (requested.some(path => !availablePaths.has(path))) {
        throw new McpError(ErrorCode.InvalidParams, "Folder not found");
      }
      if (limit && requested.length > limit) {
        logger.warn(`Search folder list truncated to the first ${limit} of ${requested.length} requested`, "MailboxAccess");
      }
      yield* imap.getLabelUidScopes(limit ? requested.slice(0, limit) : requested, folder, uids);
    };
    /** Resolve one ordinary folder while retaining its authorization snapshot. */
    const scopeFor = async (path: string) => {
      for await (const scope of scopesFor([path])) return scope;
      throw new McpError(ErrorCode.InvalidParams, "Folder not found");
    };
    /** Stop at the first approved physical-folder UID without scanning later folders. */
    const resolve = async (id: string, path?: string): Promise<{ email: EmailMessage; scope: MailboxUidScope } | null> => {
      if (path !== undefined && isAccessPath(path, folder)) return null;
      for await (const scope of scopesFor(path ? [path] : undefined, undefined, undefined, [id])) {
        if (!scope.uids.includes(id)) continue;
        const email = await imap.getEmailById(id, scope.folder, scope);
        if (!email) continue;
        release(scope, [id]);
        return { email: cleanEmail(email), scope };
      }
      return null;
    };
    /**
     * Group UIDs by the approved source mailbox that holds them: the named folder,
     * or else the first folder (in normal folder order) where each UID is approved.
     */
    const locate = async (ids: string[], path?: string) => {
      const unique = [...new Set(ids)];
      const groups = new Map<MailboxUidScope, string[]>();
      const pending = new Set(unique);
      for await (const scope of scopesFor(path !== undefined ? [path] : undefined, undefined, undefined, unique)) {
        const approved = new Set(scope.uids);
        const here = [...pending].filter(id => approved.has(id));
        if (here.length) groups.set(scope, here);
        here.forEach(id => pending.delete(id));
        if (!pending.size) break;
      }
      return { groups, missing: unique.filter(id => pending.has(id)) };
    };
    return { scopesFor, scopeFor, resolve, locate, release, released };
  };

  /** Release read results only after every message they returned is still approved. */
  const scopedRead = <T>(operation: (scope: ReturnType<typeof createOperation>) => Promise<T>) => mailboxOperation(async () => {
    const op = createOperation();
    const result = await operation(op);
    await assertStillApproved(op.released);
    op.released.forEach(identity => requestIdentities.add(identity));
    return result;
  });
  /** Mutations authorize against fresh membership and re-prove it under each mailbox lock; their results carry no mail content. */
  const scopedMutation = <T>(operation: (scope: ReturnType<typeof createOperation>) => Promise<T>) =>
    mailboxOperation(() => operation(createOperation()));

  /** Re-prove, immediately before mutating, that every targeted message is still approved. */
  const assertTargetsApproved = async (groups: Map<MailboxUidScope, string[]>) => {
    if (!groups.size) return;
    const labeled = await imap.readLabelIdentities(folder);
    for (const [scope, ids] of groups) {
      const identities = imap.scopeIdentities(scope);
      if (ids.some(id => !labeled.has(identities.get(id) ?? ""))) {
        throw new Error("Mailbox changed during the request; retry the operation");
      }
    }
  };
  /** Apply a single-message operation to an approved UID in its approved source mailbox. */
  const single = (id: string, path: string | undefined, apply: (scope: MailboxUidScope) => Promise<unknown>) =>
    scopedMutation(async ({ locate }) => {
      const { groups } = await locate([id], path);
      const [scope] = groups.keys();
      if (!scope) throw new McpError(ErrorCode.InvalidParams, notFound(id));
      await assertTargetsApproved(groups);
      return withMailboxScopes([scope], () => apply(scope));
    });
  /** Apply a bulk operation per approved source mailbox, reporting unapproved UIDs as not found. */
  const bulk = (ids: string[], path: string | undefined, apply: (scope: MailboxUidScope, ids: string[]) => Promise<BulkResult>) =>
    scopedMutation(async ({ locate }) => {
      const { groups, missing } = await locate(ids, path);
      await assertTargetsApproved(groups);
      const result: BulkResult = { success: 0, failed: missing.length, errors: missing.map(notFound) };
      for (const [scope, approved] of groups) {
        const item = await withMailboxScopes([scope], () => apply(scope, approved));
        result.success += item.success; result.failed += item.failed; result.errors.push(...item.errors);
      }
      return result;
    });
  const flagOne = (id: string, flag: string, value: boolean, path?: string) => single(id, path, async scope => {
    const result = await imap.setScopedFlags([id], flag, value, scope);
    if (result.success !== 1) throw new McpError(ErrorCode.InvalidParams, "Email not found");
    return true;
  });
  const flagMany = (ids: string[], flag: string, value: boolean, path?: string) =>
    bulk(ids, path, (scope, approved) => imap.setScopedFlags(approved, flag, value, scope));

  /** Save a draft with a server-generated Message-ID and label it so the agent can see and edit it. */
  const saveDraft = (draft: SaveDraftOptions) => mailboxOperation(async () => {
    const labeler = options.drafts;
    if (!labeler) throw new Error("Draft labeling is unavailable");
    const messageId = `<${randomUUID()}@${options.messageIdDomain ?? "localhost"}>`;
    if (!(await labeler.prepare(messageId, folder, "drafts"))) throw new Error("Draft labeling is unavailable");
    const result = await passThrough(() => imap.saveDraft({ ...draft, messageId }));
    if (!result.success) {
      try { labeler.discard(messageId); } catch (error) { logger.warn("Could not discard unsaved draft's labeling job", "MailboxAccess", error); }
      return result;
    }
    await labeler.processNow().catch(error => logger.warn("Draft labeling pending; will retry", "MailboxAccess", error));
    return result;
  });

  const methods: Record<string, (...args: never[]) => unknown> = {
    getEmails: (path = "INBOX", limit = 50, offset = 0) => scopedRead(async ({ scopeFor, release }) => {
      const scope = await scopeFor(path);
      const emails = await imap.getEmails(scope.folder, limit, offset, scope);
      release(scope, emails.map(email => email.id));
      return emails.map(cleanEmail);
    }),
    searchEmails: (search: SearchEmailOptions) => scopedRead(async ({ scopesFor, release }) => {
      const requested = search.folders ?? [search.folder ?? "INBOX"];
      const paths = (requested[0] === "*" || requested[0]?.toLowerCase() === "all") ? undefined : requested;
      const scopes = new Map<string, MailboxUidScope>();
      for await (const scope of scopesFor(paths, undefined, SEARCH_FOLDER_CAP)) scopes.set(scope.folder, scope);
      if (!scopes.size) return [];
      const emails = await imap.searchEmails({ ...search, folder: undefined, folders: [...scopes.keys()] }, scopes);
      for (const email of emails) release(scopes.get(email.folder)!, [email.id]);
      return emails.map(cleanEmail);
    }),
    getEmailById: (id: string, path?: string) => scopedRead(async ({ resolve }) => (await resolve(id, path))?.email ?? null),
    downloadAttachment: (id: string, index: number, path?: string) => scopedRead(async ({ resolve }) => {
      const source = await resolve(id, path);
      return source ? imap.downloadAttachment(id, index, source.scope.folder, source.scope) : null;
    }),
    getFolders: () => folderListing(),
    syncFolders: () => folderListing(),
    markEmailRead: (id: string, value = true, path?: string) => flagOne(id, "\\Seen", value, path),
    starEmail: (id: string, value = true, path?: string) => flagOne(id, "\\Flagged", value, path),
    setFlag: (id: string, flag: string, value = true, path?: string) => flagOne(id, flag, value, path),
    bulkMarkRead: (ids: string[], value = true, path?: string) => flagMany(ids, "\\Seen", value, path),
    bulkStar: (ids: string[], value = true, path?: string) => flagMany(ids, "\\Flagged", value, path),
    moveEmail: async (id: string, target: string, path?: string) => {
      denyAccessPath(target);
      return single(id, path, scope => passThrough(() => imap.moveEmail(id, target, scope.folder)));
    },
    bulkMoveEmails: async (ids: string[], target: string, path?: string) => {
      denyAccessPath(target);
      return bulk(ids, path, (scope, approved) => passThrough(() => imap.bulkMoveEmails(approved, target, scope.folder)));
    },
    copyEmailToFolder: async (id: string, target: string, path?: string) => {
      denyAccessPath(target);
      return single(id, path, scope => passThrough(() => imap.copyEmailToFolder(id, target, scope.folder)));
    },
    bulkCopyToFolder: async (ids: string[], target: string, path?: string) => {
      denyAccessPath(target);
      return bulk(ids, path, (scope, approved) => passThrough(() => imap.bulkCopyToFolder(approved, target, scope.folder)));
    },
    deleteFromFolder: async (id: string, labelPath: string) => {
      denyAccessPath(labelPath);
      return single(id, labelPath, scope => passThrough(() => imap.deleteFromFolder(id, scope.folder)));
    },
    bulkDeleteFromFolder: async (ids: string[], labelPath: string) => {
      denyAccessPath(labelPath);
      return bulk(ids, labelPath, (scope, approved) => passThrough(() => imap.bulkDeleteFromFolder(approved, scope.folder)));
    },
    ensureFolderExists: async (name: string) => {
      denyAccessPath(name);
      return mailboxOperation(() => passThrough(() => imap.ensureFolderExists(name)));
    },
    createFolder: async (name: string) => {
      denyAccessPath(name);
      return mailboxOperation(() => passThrough(() => imap.createFolder(name)));
    },
    renameFolder: async (from: string, to: string) => {
      denyAccessPath(from, to);
      return mailboxOperation(() => passThrough(() => imap.renameFolder(from, to)));
    },
    saveDraft: (draft: SaveDraftOptions) => saveDraft(draft),
  };

  /** Folder list with counts of approved mail only; the access mailbox is omitted. */
  const folderListing = () => scopedRead(async ({ scopesFor, release }) => {
    const result = [];
    const entries = await rawFolders();
    const entriesByPath = new Map(entries.map(entry => [entry.path, entry]));
    for await (const scope of scopesFor(undefined, entries)) {
      release(scope); // Counts derive from every approved message in the folder.
      result.push({ ...entriesByPath.get(scope.folder)!, totalMessages: scope.uids.length, unreadMessages: scope.unread });
    }
    return result;
  });

  const proxy = new Proxy(imap, {
    /** Unlisted service methods are denied rather than reaching unfiltered mail. */
    get(target, property) {
      if (typeof property === "symbol") return Reflect.get(target, property);
      if (Object.hasOwn(methods, property)) return methods[property];
      if (PASSTHROUGH_MEMBERS.has(property)) {
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      }
      // Not a thenable; other members are unavailable through the filtered view.
      if (property === "then") return undefined;
      return () => Promise.reject(new McpError(ErrorCode.InvalidRequest, "Mailbox operation unavailable"));
    },
  });
  labelAccessChecks.set(proxy, () => assertStillApproved(requestIdentities));
  return proxy;
}
