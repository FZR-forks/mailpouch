/** Server-wide mail boundary. Unknown/new tools are denied until reviewed. */
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { SearchEmailOptions } from "../types/index.js";
import type { SimpleIMAPService } from "../services/simple-imap-service.js";
import { validateLabelName } from "../utils/helpers.js";

export function accessLabelFolder(label: unknown): string | undefined {
  if (label === undefined || label === "") return undefined;
  if (typeof label !== "string" || label !== label.trim() || validateLabelName(label)) {
    throw new McpError(ErrorCode.InvalidRequest, "Invalid AI access label configuration; mail access is blocked.");
  }
  return `Labels/${label}`;
}

const FOLDER_READS = new Set([
  "get_emails", "get_email_by_id", "search_emails", "download_attachment",
  "get_thread", "extract_action_items", "extract_meeting", "reply_to_email", "forward_email",
]);
const FLAG_WRITES = new Set(["mark_email_read", "star_email", "mark_answered", "mark_forwarded", "bulk_mark_read", "bulk_star"]);
const SAFE_TOOLS = new Set([
  "setup_status", "request_permission_escalation", "check_escalation_status",
  "get_connection_status", "get_server_version", "clear_cache", "send_email", "send_test_email", "schedule_email",
  "get_folders", "sync_folders", "get_unread_count", "list_labels",
]);

/** Add a safe default, reject all explicit alternative paths, never rewrite UIDs. */
export function scopeLabelTool(tool: string, args: Record<string, unknown>, folder: string): void {
  const requireFolder = (field: string) => {
    if (args[field] === undefined) args[field] = folder;
    if (args[field] !== folder) throw new McpError(ErrorCode.InvalidRequest, "Blocked: only the configured AI access label is accessible.");
  };
  if (FOLDER_READS.has(tool)) {
    requireFolder("folder");
    if (args.folders !== undefined && (!Array.isArray(args.folders) || args.folders.length === 0 || args.folders.some(f => f !== folder))) {
      throw new McpError(ErrorCode.InvalidRequest, "Blocked: search may only use the AI access label.");
    }
  } else if (tool === "get_emails_by_label") {
    if (args.label === undefined) args.label = folder.slice("Labels/".length);
    if (`Labels/${args.label}` !== folder) throw new McpError(ErrorCode.InvalidRequest, "Blocked: label is outside AI access.");
  } else if (FLAG_WRITES.has(tool)) {
    requireFolder("sourceFolder");
  } else if (!SAFE_TOOLS.has(tool)) {
    throw new McpError(ErrorCode.InvalidRequest, `Blocked: ${tool} is unavailable under AI label access because it has no live label scope.`);
  }
}

export function labelAllowedFolders(folder: string | undefined, grant?: string[]): string[] | undefined {
  if (!folder) return grant;
  return !grant || grant.includes(folder) ? [folder] : [];
}

/** Per-call facade: do not mutate shared connections/caches or use a cached by-ID read. */
export function labelScopedImap(imap: SimpleIMAPService, folder: string | undefined): SimpleIMAPService {
  if (!folder) return imap;
  return new Proxy(imap, {
    get(target, property) {
      if (property === "searchEmails") return (options: SearchEmailOptions) => {
        if (options.folder !== folder || options.folders?.some(f => f !== folder)) {
          throw new McpError(ErrorCode.InvalidRequest, "Blocked: missing AI label search scope.");
        }
        return target.searchEmails(options, true);
      };
      if (property === "getEmailById") return (id: string, path?: string) => {
        if (path !== folder) throw new McpError(ErrorCode.InvalidRequest, "Blocked: missing AI label provenance.");
        return target.getEmailById(id, path, true);
      };
      if (property === "getFolders" || property === "syncFolders") return async () =>
        (await target.syncFolders()).filter(f => f.path === folder);
      if (property === "downloadAttachment") return (id: string, index: number, path?: string) => {
        if (path !== folder) throw new McpError(ErrorCode.InvalidRequest, "Blocked: missing AI label provenance.");
        return target.downloadAttachment(id, index, path, true);
      };
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
