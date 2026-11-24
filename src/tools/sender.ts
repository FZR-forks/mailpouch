/**
 * The optional `from` argument of the outbound-mail tools.
 *
 * When Proton Bridge's address list is available (see
 * services/bridge-addresses.ts), agents are shown the account's real sender
 * addresses in the tool schema and an unlisted `from` is refused before any
 * SMTP work starts. Without that list, a syntactically valid `from` is passed
 * through and Bridge itself decides.
 */

import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { isValidEmail } from "../utils/helpers.js";
import { isKnownSender, senderAddressKey } from "../services/bridge-addresses.js";
import type { ToolCallContext, ToolDef } from "./types.js";

/** Tools whose inputSchema carries a `from` sender argument. */
export const SENDER_TOOLS: ReadonlySet<string> = new Set([
  "send_email", "reply_to_email", "forward_email", "schedule_email",
]);

/**
 * Whether some sending tool is usable: enabled globally AND allowed by the
 * caller's grant. Both must hold for the same tool; `grantAllows` is
 * undefined for a trusted caller without a grant gate.
 */
export function someSenderToolUsable(
  enabled: (tool: string) => boolean,
  grantAllows?: (tool: string) => boolean,
): boolean {
  return [...SENDER_TOOLS].some(tool => enabled(tool) && (grantAllows?.(tool) ?? true));
}

/** Static `from` schema, used when Bridge's address list is unavailable. */
export const FROM_SCHEMA_FIELD = {
  type: "string",
  description:
    "Sender address (optional). Must be an address of this Proton account; omit to send from the account's login address. Do not invent addresses.",
} as const;

/** Syntax check shared by every sender tool. */
export function senderAddress(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !isValidEmail(value)) {
    throw new McpError(ErrorCode.InvalidParams, "'from' must be a valid email address.");
  }
  return value;
}

/**
 * Validate `args.from` for this call's account. Returns the sender to use
 * (undefined = the account's login address). Throws InvalidParams, naming
 * the allowed addresses, when Bridge reports that the account cannot send
 * from it. A miss is re-checked against a fresh list first, so an address
 * added in Proton moments ago is not refused from a stale cache.
 */
export async function resolveSenderAddress(ctx: ToolCallContext): Promise<string | undefined> {
  const from = senderAddress(ctx.args.from);
  if (from === undefined || !ctx.senderAddresses) return from;
  const login = ctx.config?.smtp?.username;
  if (login && senderAddressKey(from) === senderAddressKey(login)) return from;

  let lookup = await ctx.senderAddresses();
  if (!lookup.available || isKnownSender(from, lookup.addresses)) return from;
  lookup = await ctx.senderAddresses({ fresh: true });
  if (!lookup.available || isKnownSender(from, lookup.addresses)) return from;

  throw new McpError(
    ErrorCode.InvalidParams,
    `'from' ${from} is not a sender address of this Proton account. Use one of: ${lookup.addresses.join(", ")}`
      + (login ? `, or omit 'from' to send as ${login}.` : "."),
  );
}

/** Every address of this call's account, for excluding "self" from reply-all. */
export async function ownAddresses(ctx: ToolCallContext): Promise<string[]> {
  if (!ctx.senderAddresses) return [];
  const lookup = await ctx.senderAddresses();
  return lookup.available ? lookup.addresses : [];
}

/** One letter as a case-insensitive character class (JSON Schema patterns have no flags). */
function caseless(ch: string): string {
  const lower = ch.toLowerCase();
  const upper = ch.toUpperCase();
  if (lower !== upper && ch.length === 1) return `[${lower}${upper}]`;
  // Only syntax characters: `\-` is an invalid escape in Unicode-mode regexes.
  return ch.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

/**
 * Pattern matching exactly the listed addresses, in any letter case and with
 * an optional `+tag` on the local part, the same forms resolveSenderAddress
 * accepts.
 */
export function senderPattern(addresses: readonly string[]): string {
  const alternatives = addresses.map(address => {
    const key = senderAddressKey(address);
    const at = key.lastIndexOf("@");
    const exact = (text: string) => [...text].map(caseless).join("");
    return `${exact(key.slice(0, at))}(?:\\+[^@\\s]*)?@${exact(key.slice(at + 1))}`;
  });
  return `^(?:${alternatives.join("|")})$`;
}

/**
 * Advertise the account's sender addresses on every sender tool's `from`
 * field. `enumerate` adds them as `examples` plus a `pattern` that accepts
 * only those addresses (any case, optional `+tag`); only safe when every call
 * goes to the same account (an `account_id`-routed call has other addresses).
 */
export function withSenderAddressHints(
  defs: ToolDef[],
  addresses: readonly string[],
  opts: { login: string; enumerate: boolean; accountLabel?: string },
): ToolDef[] {
  const allowed = [...addresses];
  if (opts.login && !isKnownSender(opts.login, allowed)) allowed.unshift(opts.login);
  if (allowed.length === 0) return defs;
  const scope = opts.accountLabel ? ` (account ${opts.accountLabel}; other accounts have their own addresses)` : "";
  const field = {
    type: "string",
    ...(opts.enumerate ? { examples: allowed, pattern: senderPattern(allowed) } : {}),
    description:
      `Sender address (optional). This Proton account can send from: ${allowed.join(", ")}${scope}. `
      + `Omit to send from ${opts.login || allowed[0]}. Any other address is rejected.`,
  };
  return defs.map(def => {
    if (!SENDER_TOOLS.has(def.name)) return def;
    const schema = def.inputSchema as { properties?: Record<string, unknown> } | undefined;
    if (!schema?.properties?.from) return def;
    return { ...def, inputSchema: { ...schema, properties: { ...schema.properties, from: field } } };
  });
}
