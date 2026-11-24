/**
 * OAuth 2.1 authorization-server state with optional durable persistence.
 *
 * Authorization codes (60s TTL) are process-local and single-use. Public DCR
 * clients persist alongside token hashes so cached client IDs survive restarts.
 *
 * Interactive clients also receive a REFRESH TOKEN with every access token, so
 * a host (ChatGPT, Claude) renews its session silently instead of asking the
 * user to reconnect when the 24 h access token lapses. Refresh tokens rotate
 * on use, slide their expiry forward, and are revoked with the client's grant.
 *
 * Issued ACCESS TOKENS are optionally persisted (when the store is constructed
 * with a path) so they survive a daemon restart — without persistence, a
 * restart dropped the in-memory Map and 401'd every live token, silently
 * breaking headless / static-config clients (field finding #7). Only the token
 * HASH (the Map key) + metadata are written to disk (0600, atomic) — never the
 * raw bearer — so a leaked file cannot be replayed as a credential.
 */

import { createHash, randomBytes, randomUUID } from "crypto";
import { readFileSync, writeFileSync, existsSync, renameSync } from "fs";
import { logger } from "../utils/logger.js";

export interface RegisteredClient {
  client_id: string;
  client_id_issued_at: number;
  client_name?: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
  scope?: string;
  client_secret?: string;
  client_secret_expires_at?: number;
}

export interface PendingAuth {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: "S256" | "plain";
  scopes: string[];
  resource?: string;
  state?: string;
  /** ms since epoch. Codes expire after OAUTH_CODE_TTL_MS. */
  createdAt: number;
}

export interface IssuedToken {
  token: string;
  clientId: string;
  scopes: string[];
  resource?: string;
  /** ms since epoch. */
  expiresAt: number;
  /** Refresh-token family this access token was issued from, if any. */
  familyId?: string;
}

/** A refresh token's record. Keyed by sha256(refresh token); the raw value is
 *  never stored. Bound to the client and resource of the original grant. */
export interface RefreshTokenRecord {
  clientId: string;
  scopes: string[];
  resource?: string;
  /** ms since epoch. */
  expiresAt: number;
  /** ms since epoch the token was exchanged for a successor (rotation). */
  rotatedAt?: number;
  /** Shared by every token rotated from one sign-in. Reusing a rotated token
   *  after its grace revokes the whole family (RFC 9700 §2.2.2 replay
   *  detection). Records persisted without one form a family of one. */
  familyId?: string;
}

export const OAUTH_CODE_TTL_MS = 60_000;                // RFC 6749 §4.1.2: MAX 10 min; we go short
export const OAUTH_ACCESS_TOKEN_TTL_MS = 24 * 60 * 60_000;  // 24 h — self-host session
/** Idle lifetime of a refresh token. Each refresh issues a successor with a
 *  fresh window, so an agent used at least this often never has to reconnect. */
export const OAUTH_REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60_000;  // 90 days
/** How long a rotated refresh token keeps working. Covers a host retrying a
 *  refresh whose response it never received (timeout, tunnel hiccup), which
 *  would otherwise strand it with a dead token and force a reconnect. */
export const OAUTH_REFRESH_ROTATION_GRACE_MS = 5 * 60_000;

/**
 * Absolute ceilings. The DCR endpoint is rate-limited per IP upstream, so
 * a friendly client won't hit these. The caps exist so a broken or hostile
 * client can't grow the Maps without bound between sweep() calls.
 *
 * When a cap is hit we evict the oldest entry rather than refusing the
 * new one — matches the "self-host, keep the live session working"
 * philosophy. Evicted clients will simply re-register on their next use.
 */
const OAUTH_MAX_CLIENTS = 1000;
export const OAUTH_MAX_CODES   = 500;
export const OAUTH_MAX_TOKENS  = 5000;
export const OAUTH_MAX_REFRESH_TOKENS = 5000;

export class OAuthStore {
  private clients = new Map<string, RegisteredClient>();
  private codes = new Map<string, PendingAuth>();
  /**
   * XPORT-005: tokens are keyed by sha256(token), never the raw token. The
   * user-supplied bearer is hashed before the Map lookup, so the comparison is
   * over fixed-length digests rather than letting V8's hash-table short-circuit
   * on the first byte of the attacker-controlled string — consistent with the
   * `timingSafeEqual` posture the rest of the codebase uses. The reverse index
   * stores hashes too.
   */
  private tokens = new Map<string, IssuedToken>();
  /** Reverse index clientId → token-hashes, so revoking a grant can invalidate
   *  all outstanding access tokens for that client immediately rather than
   *  waiting for the 24 h TTL to expire. Kept consistent with `tokens` via the
   *  issueToken / revokeToken / evict / sweep paths. */
  private tokensByClient = new Map<string, Set<string>>();
  /** sha256(refresh token) → record. Persisted with the access tokens. */
  private refreshTokens = new Map<string, RefreshTokenRecord>();

  /**
   * Optional on-disk persistence of ISSUED TOKENS so they survive a daemon
   * restart (XPORT/#7 — a restart used to drop the in-memory Map and 401 every
   * live token, silently breaking headless/static-config clients). Only the
   * token HASH (the Map key) + metadata are written — never the raw bearer — so
   * a leaked file cannot be replayed as a credential. Public DCR registration
   * metadata also persists; codes and confidential service clients do not.
   */
  constructor(private readonly persistPath?: string) {
    if (persistPath) this.load();
  }

  /** Only public authorization-code clients belong in this store. Service
   * accounts retain their own durable credential authority. */
  private static isPublicClient(value: unknown): value is RegisteredClient {
    if (!value || typeof value !== "object") return false;
    const c = value as Partial<RegisteredClient>;
    return typeof c.client_id === "string" && /^pmc_[0-9a-f]{32}$/.test(c.client_id)
      && typeof c.client_id_issued_at === "number" && Number.isFinite(c.client_id_issued_at)
      && (c.client_name === undefined || typeof c.client_name === "string")
      && Array.isArray(c.redirect_uris) && c.redirect_uris.length > 0
      && c.redirect_uris.every(uri => typeof uri === "string")
      && Array.isArray(c.grant_types) && OAuthStore.isPublicGrantTypes(c.grant_types)
      && Array.isArray(c.response_types) && c.response_types.length === 1 && c.response_types[0] === "code"
      && c.token_endpoint_auth_method === "none"
      && (c.scope === undefined || typeof c.scope === "string")
      && c.client_secret === undefined;
  }

  /** Public clients registered before refresh-token support carry
   *  ["authorization_code"]; newer ones add "refresh_token". */
  private static isPublicGrantTypes(types: unknown[]): boolean {
    return (types.length === 1 && types[0] === "authorization_code")
      || (types.length === 2 && types[0] === "authorization_code" && types[1] === "refresh_token");
  }

  private static isRefreshRecord(value: unknown): value is RefreshTokenRecord {
    if (!value || typeof value !== "object") return false;
    const r = value as Partial<RefreshTokenRecord>;
    return typeof r.clientId === "string" && r.clientId.length > 0
      && Array.isArray(r.scopes) && r.scopes.every(x => typeof x === "string")
      && (r.resource === undefined || typeof r.resource === "string")
      && typeof r.expiresAt === "number" && Number.isFinite(r.expiresAt)
      && (r.rotatedAt === undefined || (typeof r.rotatedAt === "number" && Number.isFinite(r.rotatedAt)))
      && (r.familyId === undefined || typeof r.familyId === "string");
  }

  private load(): void {
    try {
      if (!this.persistPath || !existsSync(this.persistPath)) return;
      const raw = JSON.parse(readFileSync(this.persistPath, "utf-8")) as {
        clients?: unknown[];
        tokens?: Array<{ h: string; r: IssuedToken }>;
        refreshTokens?: Array<{ h?: unknown; r?: unknown }>;
      };
      const now = Date.now();
      if (Array.isArray(raw.clients)) {
        for (const client of raw.clients) {
          if (!OAuthStore.isPublicClient(client)) continue;
          if (this.clients.size >= OAUTH_MAX_CLIENTS) this.evictOldest(this.clients);
          this.clients.set(client.client_id, client);
        }
      }
      for (const entry of raw.tokens ?? []) {
        const { h, r } = entry;
        if (!h || !r || typeof r.expiresAt !== "number" || now > r.expiresAt) continue;
        this.tokens.set(h, r);
        let set = this.tokensByClient.get(r.clientId);
        if (!set) { set = new Set(); this.tokensByClient.set(r.clientId, set); }
        set.add(h);
      }
      if (Array.isArray(raw.refreshTokens)) {
        for (const entry of raw.refreshTokens) {
          if (!entry || typeof entry.h !== "string" || !/^[0-9a-f]{64}$/.test(entry.h)) continue;
          if (!OAuthStore.isRefreshRecord(entry.r) || this.refreshIsPrunable(entry.r, now)) continue;
          if (this.refreshTokens.size >= OAUTH_MAX_REFRESH_TOKENS) this.evictOldest(this.refreshTokens);
          this.refreshTokens.set(entry.h, entry.r);
        }
      }
    } catch {
      // Corrupt/unreadable token store → start fresh (clients re-auth). Never throw.
    }
  }

  private persist(): void {
    if (!this.persistPath) return;
    try {
      // Hashes only — the raw bearer is blanked so a leaked file can't be replayed.
      const tokens = Array.from(this.tokens.entries()).map(([h, r]) => ({ h, r: { ...r, token: "" } }));
      const clients = Array.from(this.clients.values())
        .filter(OAuthStore.isPublicClient)
        .map(c => ({
          client_id: c.client_id, client_id_issued_at: c.client_id_issued_at,
          client_name: c.client_name, redirect_uris: c.redirect_uris,
          grant_types: c.grant_types, response_types: c.response_types,
          token_endpoint_auth_method: c.token_endpoint_auth_method, scope: c.scope,
        }));
      const tmp = `${this.persistPath}.${randomBytes(6).toString("hex")}.tmp`;
      const refreshTokens = Array.from(this.refreshTokens.entries()).map(([h, r]) => ({ h, r }));
      writeFileSync(tmp, JSON.stringify({ version: 3, clients, tokens, refreshTokens }), { mode: 0o600 });
      renameSync(tmp, this.persistPath);
    } catch {
      // Best-effort — a failed persist must not break token issuance/verification.
    }
  }

  /** sha256(token) hex — the key under which a token's record lives. */
  private static hashToken(token: string): string {
    return createHash("sha256").update(token, "utf-8").digest("hex");
  }

  /** Drop the oldest entry from a Map (relies on Map's insertion-order iteration). */
  private evictOldest<K, V>(m: Map<K, V>): void {
    const first = m.keys().next();
    if (!first.done) m.delete(first.value);
  }

  private indexToken(rec: IssuedToken): void {
    let set = this.tokensByClient.get(rec.clientId);
    if (!set) { set = new Set(); this.tokensByClient.set(rec.clientId, set); }
    set.add(OAuthStore.hashToken(rec.token));
  }

  /** `hash` is sha256(token) — the same key used in the primary tokens Map. */
  private unindexToken(hash: string, clientId: string): void {
    const set = this.tokensByClient.get(clientId);
    if (!set) return;
    set.delete(hash);
    if (set.size === 0) this.tokensByClient.delete(clientId);
  }

  registerClient(client: Omit<RegisteredClient, "client_id" | "client_id_issued_at">): RegisteredClient {
    const id = `pmc_${randomUUID().replace(/-/g, "")}`;
    const now = Math.floor(Date.now() / 1000);
    const record: RegisteredClient = {
      client_id: id,
      client_id_issued_at: now,
      ...client,
    };
    if (this.clients.size >= OAUTH_MAX_CLIENTS) this.evictOldest(this.clients);
    this.clients.set(id, record);
    this.persist();
    return record;
  }

  getClient(id: string): RegisteredClient | undefined {
    return this.clients.get(id);
  }

  /**
   * Register a client with a predetermined client_id. Used to load persisted
   * service accounts (client_credentials grant) at startup so token-issued
   * callers resolve to a human-readable client_name in logs and the Agents tab.
   * Unlike {@link registerClient}, the id is supplied by the caller (it already
   * lives in the service-account store) rather than freshly minted.
   */
  registerServiceClient(record: RegisteredClient): void {
    if (this.clients.size >= OAUTH_MAX_CLIENTS) this.evictOldest(this.clients);
    this.clients.set(record.client_id, record);
  }

  /** Allocate a new one-shot authorization code. */
  issueAuthCode(params: Omit<PendingAuth, "code" | "createdAt">): PendingAuth {
    const code = randomBytes(32).toString("base64url");
    const record: PendingAuth = { code, createdAt: Date.now(), ...params };
    if (this.codes.size >= OAUTH_MAX_CODES) this.evictOldest(this.codes);
    this.codes.set(code, record);
    return record;
  }

  /** Consume a code (always deletes, returns record only if still valid). */
  consumeAuthCode(code: string): PendingAuth | null {
    const rec = this.codes.get(code);
    if (!rec) return null;
    this.codes.delete(code); // single-use — always drop regardless of expiry
    if (Date.now() - rec.createdAt > OAUTH_CODE_TTL_MS) return null;
    return rec;
  }

  issueToken(args: { clientId: string; scopes: string[]; resource?: string; familyId?: string }): IssuedToken {
    const token = randomBytes(32).toString("base64url");
    const rec: IssuedToken = {
      token,
      clientId: args.clientId,
      scopes: args.scopes,
      resource: args.resource,
      expiresAt: Date.now() + OAUTH_ACCESS_TOKEN_TTL_MS,
      ...(args.familyId ? { familyId: args.familyId } : {}),
    };
    if (this.tokens.size >= OAUTH_MAX_TOKENS) {
      const first = this.tokens.keys().next();
      if (!first.done) {
        const old = this.tokens.get(first.value);
        this.tokens.delete(first.value);
        if (old) this.unindexToken(first.value, old.clientId);
      }
    }
    this.tokens.set(OAuthStore.hashToken(token), rec);
    this.indexToken(rec);
    this.persist();
    return rec;
  }

  verifyToken(token: string): IssuedToken | null {
    const hash = OAuthStore.hashToken(token);
    const rec = this.tokens.get(hash);
    if (!rec) return null;
    if (Date.now() > rec.expiresAt) {
      this.tokens.delete(hash);
      this.unindexToken(hash, rec.clientId);
      return null;
    }
    return rec;
  }

  revokeToken(token: string): boolean {
    const hash = OAuthStore.hashToken(token);
    const rec = this.tokens.get(hash);
    let removed = this.tokens.delete(hash);
    if (removed && rec) this.unindexToken(hash, rec.clientId);
    // RFC 7009: the revocation endpoint accepts either token type.
    if (this.refreshTokens.delete(hash)) removed = true;
    if (removed) this.persist();
    return removed;
  }

  /** Drop every outstanding access token for `clientId`. Returns the number
   *  of tokens revoked. Called when a per-agent grant is denied / revoked /
   *  expires so that ongoing requests holding the token can't continue past
   *  the policy change. */
  revokeTokensForClient(clientId: string): number {
    let n = 0;
    const set = this.tokensByClient.get(clientId);
    if (set) {
      for (const token of set) {
        if (this.tokens.delete(token)) n++;
      }
      this.tokensByClient.delete(clientId);
    }
    // Refresh tokens too, or a revoked client could mint new access tokens.
    for (const [h, r] of this.refreshTokens) {
      if (r.clientId === clientId) { this.refreshTokens.delete(h); n++; }
    }
    if (n > 0) this.persist();
    return n;
  }

  /** True when a refresh record can no longer be redeemed. A rotated token
   *  stays redeemable for the full grace even if its own expiry passes in
   *  between, so a retry right after a late rotation still succeeds. */
  private refreshIsDead(rec: RefreshTokenRecord, now: number): boolean {
    if (rec.rotatedAt !== undefined) return now - rec.rotatedAt > OAUTH_REFRESH_ROTATION_GRACE_MS;
    return now > rec.expiresAt;
  }

  /** True once a record is useless even as a replay tombstone: a rotated
   *  record is kept until its original expiry so reuse can still be detected. */
  private refreshIsPrunable(rec: RefreshTokenRecord, now: number): boolean {
    const until = rec.rotatedAt === undefined
      ? rec.expiresAt
      : Math.max(rec.expiresAt, rec.rotatedAt + OAUTH_REFRESH_ROTATION_GRACE_MS);
    return now > until;
  }

  /** Mint a refresh token for a client. Returns the raw token (shown once).
   *  Without a familyId it starts a new family (a fresh sign-in). */
  issueRefreshToken(args: { clientId: string; scopes: string[]; resource?: string; familyId?: string }): string {
    const token = randomBytes(32).toString("base64url");
    const rec: RefreshTokenRecord = {
      clientId: args.clientId,
      scopes: [...args.scopes],
      ...(args.resource ? { resource: args.resource } : {}),
      expiresAt: Date.now() + OAUTH_REFRESH_TOKEN_TTL_MS,
      familyId: args.familyId ?? randomUUID(),
    };
    if (this.refreshTokens.size >= OAUTH_MAX_REFRESH_TOKENS) this.evictOldest(this.refreshTokens);
    this.refreshTokens.set(OAuthStore.hashToken(token), rec);
    this.persist();
    return token;
  }

  /** Access token + refresh token for a fresh sign-in, in one new family. */
  issueTokenPair(args: { clientId: string; scopes: string[]; resource?: string }): { access: IssuedToken; refreshToken: string } {
    const familyId = randomUUID();
    const access = this.issueToken({ ...args, familyId });
    const refreshToken = this.issueRefreshToken({ ...args, familyId });
    return { access, refreshToken };
  }

  /** Revoke every refresh token in a family and the access tokens it issued. */
  private revokeFamily(familyId: string): number {
    let n = 0;
    for (const [h, r] of this.refreshTokens) {
      if (r.familyId === familyId) { this.refreshTokens.delete(h); n++; }
    }
    for (const [h, t] of this.tokens) {
      if (t.familyId === familyId) {
        this.tokens.delete(h);
        this.unindexToken(h, t.clientId);
        n++;
      }
    }
    return n;
  }

  /**
   * Look up a redeemable refresh token without consuming it. A rotated token
   * presented after its grace means two parties hold the family (a stolen
   * token was redeemed first, or the client replayed an old one): the whole
   * family and its access tokens are revoked and the caller must sign in again.
   */
  peekRefreshToken(token: string): RefreshTokenRecord | null {
    if (!token) return null;
    const hash = OAuthStore.hashToken(token);
    const rec = this.refreshTokens.get(hash);
    if (!rec) return null;
    const now = Date.now();
    if (!this.refreshIsDead(rec, now)) return rec;
    if (rec.rotatedAt !== undefined) {
      if (rec.familyId) this.revokeFamily(rec.familyId);
      this.refreshTokens.delete(hash);
      logger.warn(`Rotated OAuth refresh token reused after its grace; revoked its token family for client ${rec.clientId}`, "OAuth");
    } else {
      this.refreshTokens.delete(hash);
    }
    this.persist();
    return null;
  }

  /**
   * Redeem a refresh token: mark it rotated (it keeps working for
   * OAUTH_REFRESH_ROTATION_GRACE_MS so a retried request still succeeds) and
   * return a successor refresh token plus a new access token in the same
   * family, both bound to the original client, scopes and resource. Null when
   * the token is unknown, expired, past its rotation grace, or belongs to
   * another client.
   */
  rotateRefreshToken(token: string, clientId?: string): { access: IssuedToken; refreshToken: string } | null {
    const rec = this.peekRefreshToken(token);
    if (!rec) return null;
    if (clientId && clientId !== rec.clientId) return null;
    if (rec.rotatedAt === undefined) rec.rotatedAt = Date.now();
    if (!rec.familyId) rec.familyId = randomUUID();
    const args = { clientId: rec.clientId, scopes: rec.scopes, resource: rec.resource, familyId: rec.familyId };
    const refreshToken = this.issueRefreshToken(args);
    const access = this.issueToken(args);
    return { access, refreshToken };
  }

  /**
   * Drop expired codes + tokens. Safe to call periodically — O(n) scan, but
   * n is small in a single-user deployment (usually ≤ dozens).
   */
  sweep(now = Date.now()): { codes: number; tokens: number } {
    let codes = 0;
    let tokens = 0;
    for (const [k, v] of this.codes) {
      if (now - v.createdAt > OAUTH_CODE_TTL_MS) {
        this.codes.delete(k);
        codes++;
      }
    }
    for (const [k, v] of this.tokens) {
      if (now > v.expiresAt) {
        this.tokens.delete(k);
        this.unindexToken(k, v.clientId);
        tokens++;
      }
    }
    let refresh = 0;
    for (const [k, v] of this.refreshTokens) {
      if (this.refreshIsPrunable(v, now)) { this.refreshTokens.delete(k); refresh++; }
    }
    if (tokens > 0 || refresh > 0) this.persist();
    return { codes, tokens };
  }

  stats(): { clients: number; codes: number; tokens: number; refreshTokens: number } {
    return { clients: this.clients.size, codes: this.codes.size, tokens: this.tokens.size, refreshTokens: this.refreshTokens.size };
  }
}
