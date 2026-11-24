/**
 * Sender addresses read from Proton Bridge's own gRPC service.
 *
 * Bridge's GUI talks to the Bridge process over a local gRPC API. Its
 * `GetUserList` call returns every signed-in Proton user together with the
 * enabled addresses Bridge will accept as a sender. This module is a minimal,
 * dependency-free client for that one read-only call, so agents can be told
 * which `from` addresses exist instead of guessing.
 *
 * How Bridge exposes the service (proton-bridge internal/frontend/grpc):
 *   - It runs only when Bridge starts with `--grpc` (the desktop app does this;
 *     compose.yaml's Bridge service does too).
 *   - At startup Bridge writes `grpcServerConfig.json` into its config
 *     directory: `{ port, cert, token, fileSocketPath }`.
 *   - Linux/macOS listen on a unix socket (`fileSocketPath`); Windows listens
 *     on 127.0.0.1:`port`. Either way the channel is TLS with the self-signed
 *     `cert`, and every call must carry `server-token: <token>` metadata.
 *
 * The token grants full control of Bridge. Only `GetUserList` is ever called
 * here, the Bridge password field in its response is skipped without being
 * decoded, and the token is never logged. `RunEventStream` is deliberately
 * never opened: Bridge quits when an event-stream client disconnects.
 */

import { X509Certificate } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import http2 from "node:http2";
import { connect as netConnect } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { logger } from "../utils/logger.js";

/** Contents of Bridge's `grpcServerConfig.json`. */
export interface BridgeGrpcServerConfig {
  port: number;
  cert: string;
  token: string;
  fileSocketPath: string;
}

/** `grpc.UserState` from bridge.proto. */
export const BRIDGE_USER_CONNECTED = 2;

/** The parts of `grpc.User` this module needs (never the Bridge password). */
export interface BridgeUser {
  id: string;
  username: string;
  state: number;
  splitMode: boolean;
  addresses: string[];
}

export type SenderAddressLookup =
  | { available: true; addresses: string[]; splitMode: boolean }
  | { available: false; reason: string };

/** Environment variable naming the config file; `off` disables discovery. */
export const BRIDGE_GRPC_CONFIG_ENV = "MAILPOUCH_BRIDGE_GRPC_CONFIG";

const CONFIG_FILE_NAME = "grpcServerConfig.json";
const GET_USER_LIST_PATH = "/grpc.Bridge/GetUserList";
const DEFAULT_TIMEOUT_MS = 3_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

/**
 * Where Bridge writes its gRPC server config, or undefined when disabled.
 * Mirrors Go's os.UserConfigDir() joined with `protonmail/bridge-v3`.
 */
export function bridgeGrpcConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string | undefined {
  const explicit = env[BRIDGE_GRPC_CONFIG_ENV]?.trim();
  if (explicit) return /^(off|none|false|0)$/i.test(explicit) ? undefined : explicit;
  let configDir: string | undefined;
  if (platform === "win32") configDir = env.APPDATA;
  else if (platform === "darwin") configDir = join(home, "Library", "Application Support");
  else configDir = env.XDG_CONFIG_HOME || join(home, ".config");
  return configDir ? join(configDir, "protonmail", "bridge-v3", CONFIG_FILE_NAME) : undefined;
}

/** Parse and shape-check `grpcServerConfig.json`. */
export function parseBridgeGrpcConfig(text: string): BridgeGrpcServerConfig {
  const raw = JSON.parse(text) as Record<string, unknown>;
  const cfg = {
    port: typeof raw.port === "number" ? raw.port : 0,
    cert: typeof raw.cert === "string" ? raw.cert : "",
    token: typeof raw.token === "string" ? raw.token : "",
    fileSocketPath: typeof raw.fileSocketPath === "string" ? raw.fileSocketPath : "",
  };
  if (!cfg.cert || !cfg.token) throw new Error("Bridge gRPC config has no certificate or token");
  if (!cfg.fileSocketPath && !(cfg.port > 0 && cfg.port < 65536)) {
    throw new Error("Bridge gRPC config has neither a socket path nor a port");
  }
  return cfg;
}

/**
 * The socket to dial. Bridge records the path as it sees it; when the
 * socket's directory is mounted elsewhere (containers), fall back to the
 * same file name beside the config file.
 */
export function resolveSocketPath(cfg: BridgeGrpcServerConfig, configPath: string): string {
  if (existsSync(cfg.fileSocketPath)) return cfg.fileSocketPath;
  const beside = join(dirname(configPath), basename(cfg.fileSocketPath));
  return existsSync(beside) ? beside : cfg.fileSocketPath;
}

// ─── Protobuf (just enough for UserListResponse) ──────────────────────────────

class ProtoReader {
  private pos = 0;
  constructor(private readonly buf: Buffer) {}
  get done(): boolean { return this.pos >= this.buf.length; }

  varint(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (this.pos >= this.buf.length) throw new Error("truncated protobuf varint");
      const byte = this.buf[this.pos++];
      if (shift < 49) result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7;
      if (shift > 63) throw new Error("protobuf varint too long");
    }
  }

  bytes(): Buffer {
    const len = this.varint();
    if (this.pos + len > this.buf.length) throw new Error("truncated protobuf field");
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }

  skip(wireType: number): void {
    if (wireType === 0) this.varint();
    else if (wireType === 1) this.advance(8);
    else if (wireType === 2) this.bytes();
    else if (wireType === 5) this.advance(4);
    else throw new Error(`unsupported protobuf wire type ${wireType}`);
  }

  private advance(n: number): void {
    if (this.pos + n > this.buf.length) throw new Error("truncated protobuf field");
    this.pos += n;
  }
}

/**
 * Decode `grpc.User`: id=1, username=2, state=4, splitMode=5, addresses=9.
 * Field 8 is the Bridge password; it is skipped, never turned into a string.
 */
function decodeUser(buf: Buffer): BridgeUser {
  const user: BridgeUser = { id: "", username: "", state: 0, splitMode: false, addresses: [] };
  const r = new ProtoReader(buf);
  while (!r.done) {
    const key = r.varint();
    const field = Math.floor(key / 8);
    const wireType = key % 8;
    if (wireType === 2 && field === 1) user.id = r.bytes().toString("utf8");
    else if (wireType === 2 && field === 2) user.username = r.bytes().toString("utf8");
    else if (wireType === 0 && field === 4) user.state = r.varint();
    else if (wireType === 0 && field === 5) user.splitMode = r.varint() !== 0;
    else if (wireType === 2 && field === 9) user.addresses.push(r.bytes().toString("utf8"));
    else r.skip(wireType);
  }
  return user;
}

/** Decode `grpc.UserListResponse { repeated User users = 1; }`. */
export function decodeUserListResponse(buf: Buffer): BridgeUser[] {
  const users: BridgeUser[] = [];
  const r = new ProtoReader(buf);
  while (!r.done) {
    const key = r.varint();
    if (key === (1 << 3) + 2) users.push(decodeUser(r.bytes()));
    else r.skip(key % 8);
  }
  return users;
}

/** Strip gRPC length-prefixed framing from a unary response body. */
export function unframeGrpcMessage(body: Buffer): Buffer {
  if (body.length < 5) throw new Error("empty gRPC response");
  if (body[0] !== 0) throw new Error("compressed gRPC responses are not supported");
  const len = body.readUInt32BE(1);
  if (body.length < 5 + len) throw new Error("truncated gRPC response");
  return body.subarray(5, 5 + len);
}

// ─── Transport ────────────────────────────────────────────────────────────────

/** One unary gRPC call with an empty request message; resolves the reply bytes. */
export function grpcUnaryCall(
  cfg: BridgeGrpcServerConfig,
  configPath: string,
  path: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  platform: NodeJS.Platform = process.platform,
): Promise<Buffer> {
  const pinned = new X509Certificate(cfg.cert).raw;
  const useSocket = platform !== "win32" && cfg.fileSocketPath !== "";
  return new Promise((resolve, reject) => {
    let settled = false;
    const session = http2.connect("https://localhost", {
      createConnection: () => tlsConnect({
        ...(useSocket
          ? { socket: netConnect(resolveSocketPath(cfg, configPath)) }
          : { host: "127.0.0.1", port: cfg.port }),
        ca: cfg.cert,
        ALPNProtocols: ["h2"],
        // Bridge's certificate is generated per start; trust exactly the one
        // it wrote next to the token, whatever names it carries.
        checkServerIdentity: (_host, peer) =>
          peer.raw && Buffer.compare(peer.raw, pinned) === 0
            ? undefined
            : new Error("Bridge gRPC certificate does not match grpcServerConfig.json"),
      }),
    });
    const finish = (err: Error | undefined, value?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      session.destroy();
      if (err) reject(err);
      else resolve(value as Buffer);
    };
    const timer = setTimeout(() => finish(new Error(`Bridge gRPC call timed out after ${timeoutMs} ms`)), timeoutMs);
    session.on("error", (err) => finish(err));

    const req = session.request({
      ":method": "POST",
      ":path": path,
      "content-type": "application/grpc",
      te: "trailers",
      "server-token": cfg.token,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let status: string | undefined;
    let message: string | undefined;
    const readStatus = (headers: http2.IncomingHttpHeaders) => {
      if (headers["grpc-status"] !== undefined) {
        status = String(headers["grpc-status"]);
        message = headers["grpc-message"] ? decodeURIComponent(String(headers["grpc-message"])) : undefined;
      }
    };
    req.on("response", (headers) => {
      const httpStatus = headers[":status"];
      if (httpStatus !== 200) finish(new Error(`Bridge gRPC answered HTTP ${httpStatus}`));
      readStatus(headers);
    });
    req.on("trailers", readStatus);
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_RESPONSE_BYTES) finish(new Error("Bridge gRPC response too large"));
      else chunks.push(chunk);
    });
    req.on("error", (err) => finish(err));
    req.on("end", () => {
      if (status !== "0") {
        finish(new Error(`Bridge gRPC call failed (status ${status ?? "missing"}${message ? `: ${message}` : ""})`));
        return;
      }
      try { finish(undefined, unframeGrpcMessage(Buffer.concat(chunks))); }
      catch (err) { finish(err as Error); }
    });
    // google.protobuf.Empty: an uncompressed frame with a zero-length message.
    req.end(Buffer.alloc(5));
  });
}

/** Read Bridge's config file and list its users. */
export async function fetchBridgeUsers(configPath: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<BridgeUser[]> {
  const cfg = parseBridgeGrpcConfig(readFileSync(configPath, "utf8"));
  return decodeUserListResponse(await grpcUnaryCall(cfg, configPath, GET_USER_LIST_PATH, timeoutMs));
}

// ─── Address matching ─────────────────────────────────────────────────────────

/**
 * Comparison key for a sender address: case-insensitive, with a `+tag`
 * removed from the local part. Bridge sends `base+tag@domain` from the
 * `base@domain` address, so both count as the same sender.
 */
export function senderAddressKey(address: string): string {
  const at = address.lastIndexOf("@");
  if (at < 1) return address.trim().toLowerCase();
  const local = address.slice(0, at);
  const plus = local.indexOf("+");
  return `${plus > 0 ? local.slice(0, plus) : local}${address.slice(at)}`.trim().toLowerCase();
}

/** Whether `candidate` is one of `addresses` (or a `+tag` form of one). */
export function isKnownSender(candidate: string, addresses: readonly string[]): boolean {
  const key = senderAddressKey(candidate);
  return addresses.some(a => senderAddressKey(a) === key);
}

/** The connected Bridge user that owns `username`, if any. */
export function findBridgeUser(users: readonly BridgeUser[], username: string): BridgeUser | undefined {
  const key = senderAddressKey(username);
  return users.find(u =>
    u.state === BRIDGE_USER_CONNECTED
    && (senderAddressKey(u.username) === key || u.addresses.some(a => senderAddressKey(a) === key)));
}

// ─── Directory with caching ───────────────────────────────────────────────────

export interface BridgeSenderDirectoryOptions {
  /** Config file path; `null` disables discovery. Defaults to bridgeGrpcConfigPath(). */
  configPath?: string | null;
  /** How long a successful user list is reused. */
  ttlMs?: number;
  /** How long a failure is remembered before Bridge is asked again. */
  failureTtlMs?: number;
  timeoutMs?: number;
  /** Test seam replacing the gRPC call. */
  fetchUsers?: (configPath: string) => Promise<BridgeUser[]>;
  now?: () => number;
}

/** Caches Bridge's user list and answers per-account sender lookups. */
export class BridgeSenderDirectory {
  private readonly configPath: string | undefined;
  private readonly ttlMs: number;
  private readonly failureTtlMs: number;
  private readonly fetchUsers: (configPath: string) => Promise<BridgeUser[]>;
  private readonly now: () => number;
  private cached?: { at: number; users?: BridgeUser[]; error?: string };
  private inFlight?: Promise<BridgeUser[]>;
  private lastLoggedError?: string;

  constructor(opts: BridgeSenderDirectoryOptions = {}) {
    this.configPath = opts.configPath === null ? undefined : (opts.configPath ?? bridgeGrpcConfigPath());
    this.ttlMs = opts.ttlMs ?? 60_000;
    this.failureTtlMs = opts.failureTtlMs ?? 15_000;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchUsers = opts.fetchUsers ?? (path => fetchBridgeUsers(path, timeoutMs));
    this.now = opts.now ?? Date.now;
  }

  /**
   * Sender addresses for the Bridge account logged in as `username`.
   * `fresh` skips the cache (used before rejecting an unlisted sender, so an
   * address added in Proton a moment ago is not refused).
   */
  async lookup(username: string, opts: { fresh?: boolean } = {}): Promise<SenderAddressLookup> {
    if (!this.configPath) return { available: false, reason: "Bridge address discovery is turned off" };
    let users: BridgeUser[];
    try {
      users = await this.users(opts.fresh === true);
    } catch (err) {
      return { available: false, reason: err instanceof Error ? err.message : String(err) };
    }
    const user = findBridgeUser(users, username);
    if (!user || user.addresses.length === 0) {
      return { available: false, reason: "Bridge has no signed-in user with this account's address" };
    }
    return { available: true, addresses: [...user.addresses], splitMode: user.splitMode };
  }

  private async users(fresh: boolean): Promise<BridgeUser[]> {
    const cached = this.cached;
    if (!fresh && cached) {
      const age = this.now() - cached.at;
      if (cached.users && age < this.ttlMs) return cached.users;
      if (cached.error && age < this.failureTtlMs) throw new Error(cached.error);
    }
    // A fresh lookup must see Bridge as it is now, so it never joins a read
    // that started earlier; later ordinary lookups share the fresh one.
    if (!this.inFlight || fresh) {
      const load = this.load(this.configPath as string);
      const shared = load.finally(() => { if (this.inFlight === shared) this.inFlight = undefined; });
      this.inFlight = shared;
    }
    return this.inFlight;
  }

  private async load(path: string): Promise<BridgeUser[]> {
    try {
      if (!existsSync(path)) {
        throw new Error(`Bridge gRPC config not found at ${path} (Bridge must run with --grpc)`);
      }
      const users = await this.fetchUsers(path);
      this.cached = { at: this.now(), users };
      if (this.lastLoggedError !== undefined) logger.info("Bridge sender addresses available again", "BridgeAddresses");
      this.lastLoggedError = undefined;
      return users;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.cached = { at: this.now(), error: message };
      if (message !== this.lastLoggedError) {
        logger.debug(`Bridge sender addresses unavailable: ${message}`, "BridgeAddresses");
        this.lastLoggedError = message;
      }
      throw new Error(message);
    }
  }
}
