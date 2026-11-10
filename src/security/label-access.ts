/** Server-wide mail boundary. Unknown/new tools are denied until reviewed. */
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { MailboxMutationDeadlineError } from "../services/mailbox-mutation-deadline.js";
import { logger } from "../utils/logger.js";
import type { EmailMessage, SearchEmailOptions } from "../types/index.js";
import type { MailboxUidScope, SimpleIMAPService } from "../services/simple-imap-service.js";
import { hashArgs, type AgentAuditLog } from "../agents/audit.js";
import type { CallerContext } from "../agents/caller-context.js";
import { validateLabelName } from "../utils/helpers.js";

/** Resolve a configured label name; invalid policy values fail closed. */
export function accessLabelFolder(label: unknown): string | undefined {
  if (label === undefined || label === "") return undefined;
  if (typeof label !== "string" || label !== label.trim() || validateLabelName(label)) {
    throw new McpError(ErrorCode.InvalidRequest, "Mailbox unavailable. Ask the account owner to check mail settings.");
  }
  return `Labels/${label}`;
}

const FOLDER_READS = new Set([
  "get_emails", "get_email_by_id", "search_emails", "download_attachment",
  "get_thread", "extract_action_items", "extract_meeting", "reply_to_email", "forward_email", "sync_emails", "get_emails_by_label",
]);
const FLAG_WRITES = new Set(["mark_email_read", "star_email", "mark_answered", "mark_forwarded", "bulk_mark_read", "bulk_star"]);
const SAFE_TOOLS = new Set([
  "setup_status", "request_permission_escalation", "check_escalation_status",
  "get_connection_status", "get_server_version", "clear_cache", "send_email", "send_test_email", "schedule_email",
  "get_folders", "sync_folders", "get_unread_count", "list_labels",
  "get_email_stats", "get_email_analytics", "get_contacts", "get_volume_trends", "get_correspondence_profile",
]);

/** Preserve ordinary folder arguments; the backend applies the access filter. */
export function scopeLabelTool(tool: string, args: Record<string, unknown>, folder: string): void {
  if (!FOLDER_READS.has(tool) && !FLAG_WRITES.has(tool) && !SAFE_TOOLS.has(tool)) {
    throw new McpError(ErrorCode.InvalidRequest, "Tool unavailable");
  }
  const requested = [args.folder, args.sourceFolder, ...(Array.isArray(args.folders) ? args.folders : []),
    ...(tool === "get_emails_by_label" && typeof args.label === "string" ? [`Labels/${args.label}`] : [])];
  if (requested.includes(folder)) throw new McpError(ErrorCode.InvalidParams, "Folder not found");
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
  return folder && grant ? grant.filter(path => path !== folder) : grant;
}

/** Keep backend policy and transport details in owner logs, not agent responses. */
async function mailboxOperation<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof MailboxMutationDeadlineError || error instanceof McpError) throw error;
    logger.warn("Filtered mailbox operation failed", "MailboxAccess", error);
    throw new McpError(ErrorCode.InternalError, "Mailbox temporarily unavailable");
  }
}

/** Same folders, UIDs and tools as the underlying service, with a live backend UID filter. */
export function labelScopedImap(imap: SimpleIMAPService, folder: string | undefined): SimpleIMAPService {
  if (!folder) return imap;
  const normalize = (path: string) => path.toUpperCase() === "INBOX" ? "INBOX" : path;
  const rawFolders = async () => (await imap.syncFolders()).filter(f => f.path !== folder);
  const scopeFor = async (path: string) => {
    const normalized = normalize(path);
    if (!(await rawFolders()).some(entry => entry.path === normalized)) {
      throw new McpError(ErrorCode.InvalidParams, "Folder not found");
    }
    return imap.getLabelUidScope(normalized, folder);
  };
  const cleanEmail = (email: EmailMessage): EmailMessage => ({
    ...email,
    ...(email.headers ? { headers: Object.fromEntries(Object.entries(email.headers)
      .filter(([key]) => !/^x-pm-.*label/i.test(key))) } : {}),
  });
  const resolve = async (id: string, path?: string): Promise<{ email: EmailMessage; scope: MailboxUidScope } | null> => {
    if (path === folder) return null;
    const paths = path ? [normalize(path)] : (await rawFolders()).map(f => f.path);
    for (const source of paths) {
      const scope = await scopeFor(source);
      if (!scope.uids.includes(id)) continue;
      const email = await imap.getEmailById(id, source, true, scope);
      if (email) return { email: cleanEmail(email), scope };
    }
    return null;
  };
  const flags = async (ids: string[], flag: string, value: boolean, path?: string) => {
    const source = path ?? (ids.length === 1 ? (await resolve(ids[0]))?.email.folder : undefined);
    if (!source) return { success: 0, failed: ids.length, errors: ids.map(id => `Email ${id} not found`) };
    return imap.setScopedFlags(ids, flag, value, await scopeFor(source));
  };
  const flagOne = async (id: string, flag: string, value: boolean, path?: string) => {
    const result = await flags([id], flag, value, path);
    if (result.success !== 1) throw new McpError(ErrorCode.InvalidParams, "Email not found");
    return true;
  };
  return new Proxy(imap, {
    get(target, property) {
      if (property === "getEmails") return (path = "INBOX", limit = 50, offset = 0) => mailboxOperation(async () => {
        const scope = await scopeFor(path);
        return (await target.getEmails(scope.folder, limit, offset, scope)).map(cleanEmail);
      });
      if (property === "searchEmails") return (options: SearchEmailOptions) => mailboxOperation(async () => {
        const requested = options.folders ?? [options.folder ?? "INBOX"];
        const paths = (requested[0] === "*" || requested[0]?.toLowerCase() === "all")
          ? (await rawFolders()).map(f => f.path)
          : requested.map(normalize);
        if (!paths.length) return [];
        const scopes = new Map<string, MailboxUidScope>();
        for (const path of paths) scopes.set(path, await scopeFor(path));
        return (await target.searchEmails({ ...options, folder: undefined, folders: paths }, true, scopes)).map(cleanEmail);
      });
      if (property === "getEmailById") return (id: string, path?: string) => mailboxOperation(async () => (await resolve(id, path))?.email ?? null);
      if (property === "downloadAttachment") return (id: string, index: number, path?: string) => mailboxOperation(async () => {
        const source = await resolve(id, path);
        return source ? target.downloadAttachment(id, index, source.scope.folder, true, source.scope) : null;
      });
      if (property === "getFolders" || property === "syncFolders") return () => mailboxOperation(async () => {
        const result = [];
        for (const entry of await rawFolders()) {
          const scope = await scopeFor(entry.path);
          result.push({ ...entry, totalMessages: scope.uids.length, unreadMessages: scope.unread });
        }
        return result;
      });
      if (property === "markEmailRead" || property === "starEmail") return (id: string, value = true, path?: string) =>
        mailboxOperation(() => flagOne(id, property === "markEmailRead" ? "\\Seen" : "\\Flagged", value, path));
      if (property === "setFlag") return (id: string, flag: string, value = true, path?: string) =>
        mailboxOperation(() => flagOne(id, flag, value, path));
      if (property === "bulkMarkRead" || property === "bulkStar") return (ids: string[], value = true, path?: string) =>
        mailboxOperation(async () => {
          if (path) return flags(ids, property === "bulkMarkRead" ? "\\Seen" : "\\Flagged", value, path);
          const result = { success: 0, failed: 0, errors: [] as string[] };
          for (const id of ids) {
            const item = await flags([id], property === "bulkMarkRead" ? "\\Seen" : "\\Flagged", value);
            result.success += item.success; result.failed += item.failed; result.errors.push(...item.errors);
          }
          return result;
        });
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
