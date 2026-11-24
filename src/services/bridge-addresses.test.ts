import { describe, it, expect, afterEach } from "vitest";
import http2 from "node:http2";
import { rootCertificates } from "node:tls";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import {
  BridgeSenderDirectory,
  bridgeGrpcConfigPath,
  decodeUserListResponse,
  fetchBridgeUsers,
  findBridgeUser,
  grpcUnaryCall,
  isKnownSender,
  parseBridgeGrpcConfig,
  senderAddressKey,
  unframeGrpcMessage,
  type BridgeUser,
} from "./bridge-addresses.js";

const CERT = readFileSync(join(process.cwd(), "test/fixtures/tls/bridge-like-cert.pem"), "utf8");
const KEY = readFileSync(join(process.cwd(), "test/fixtures/tls/bridge-like-key.pem"), "utf8");

// ─── Minimal protobuf encoder for building Bridge responses ──────────────────

function varint(n: number): Buffer {
  const out: number[] = [];
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    out.push(byte);
  } while (n > 0);
  return Buffer.from(out);
}
const tag = (field: number, wire: number) => varint(field * 8 + wire);
const lenField = (field: number, value: Buffer | string) => {
  const b = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  return Buffer.concat([tag(field, 2), varint(b.length), b]);
};
const varintField = (field: number, n: number) => Buffer.concat([tag(field, 0), varint(n)]);

function encodeUser(u: Partial<BridgeUser> & { password?: string; usedBytes?: number }): Buffer {
  return Buffer.concat([
    u.id ? lenField(1, u.id) : Buffer.alloc(0),
    u.username ? lenField(2, u.username) : Buffer.alloc(0),
    lenField(3, "AB"),
    u.state !== undefined ? varintField(4, u.state) : Buffer.alloc(0),
    u.splitMode ? varintField(5, 1) : Buffer.alloc(0),
    varintField(6, u.usedBytes ?? 123456789012),
    varintField(7, 500000000000),
    u.password ? lenField(8, u.password) : Buffer.alloc(0),
    ...(u.addresses ?? []).map(a => lenField(9, a)),
  ]);
}
const encodeUserList = (users: Parameters<typeof encodeUser>[0][]) =>
  Buffer.concat(users.map(u => lenField(1, encodeUser(u))));
const frame = (msg: Buffer) => {
  const head = Buffer.alloc(5);
  head.writeUInt32BE(msg.length, 1);
  return Buffer.concat([head, msg]);
};

// ─── Fake Bridge gRPC server ──────────────────────────────────────────────────

interface FakeBridge {
  server: http2.Http2SecureServer;
  seen: Array<{ path: string; token: string | undefined }>;
}

function fakeBridge(reply: { status?: string; body?: Buffer }): FakeBridge {
  const seen: FakeBridge["seen"] = [];
  const server = http2.createSecureServer({ cert: CERT, key: KEY, allowHTTP1: false });
  server.on("stream", (stream, headers) => {
    seen.push({ path: String(headers[":path"]), token: headers["server-token"] as string | undefined });
    stream.on("data", () => {});
    stream.on("end", () => {
      stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
      stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": reply.status ?? "0", "grpc-message": "denied%20here" }));
      stream.end(reply.body ? frame(reply.body) : undefined);
    });
  });
  return { server, seen };
}

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mp-bridge-grpc-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function listenTcp(bridge: FakeBridge): Promise<number> {
  await new Promise<void>(resolve => bridge.server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => bridge.server.close());
  return (bridge.server.address() as AddressInfo).port;
}

function writeConfig(dir: string, cfg: Record<string, unknown>): string {
  const path = join(dir, "grpcServerConfig.json");
  writeFileSync(path, JSON.stringify(cfg));
  return path;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("bridgeGrpcConfigPath", () => {
  it("follows Go's os.UserConfigDir per platform", () => {
    expect(bridgeGrpcConfigPath({}, "linux", "/home/u")).toBe(join("/home/u", ".config", "protonmail", "bridge-v3", "grpcServerConfig.json"));
    expect(bridgeGrpcConfigPath({ XDG_CONFIG_HOME: "/xdg" }, "linux", "/home/u")).toBe(join("/xdg", "protonmail", "bridge-v3", "grpcServerConfig.json"));
    expect(bridgeGrpcConfigPath({}, "darwin", "/Users/u")).toBe(join("/Users/u", "Library", "Application Support", "protonmail", "bridge-v3", "grpcServerConfig.json"));
    expect(bridgeGrpcConfigPath({ APPDATA: "C:\\AppData" }, "win32", "C:\\u")).toBe(join("C:\\AppData", "protonmail", "bridge-v3", "grpcServerConfig.json"));
    expect(bridgeGrpcConfigPath({}, "win32", "C:\\u")).toBeUndefined();
  });

  it("honours MAILPOUCH_BRIDGE_GRPC_CONFIG, including turning discovery off", () => {
    expect(bridgeGrpcConfigPath({ MAILPOUCH_BRIDGE_GRPC_CONFIG: "/run/x.json" }, "linux", "/h")).toBe("/run/x.json");
    expect(bridgeGrpcConfigPath({ MAILPOUCH_BRIDGE_GRPC_CONFIG: "off" }, "linux", "/h")).toBeUndefined();
  });
});

describe("parseBridgeGrpcConfig", () => {
  it("accepts Bridge's file and rejects one without a token or endpoint", () => {
    expect(parseBridgeGrpcConfig(JSON.stringify({ port: 0, cert: "c", token: "t", fileSocketPath: "/tmp/bridge1" })))
      .toEqual({ port: 0, cert: "c", token: "t", fileSocketPath: "/tmp/bridge1" });
    expect(() => parseBridgeGrpcConfig(JSON.stringify({ port: 1, cert: "c" }))).toThrow(/token/);
    expect(() => parseBridgeGrpcConfig(JSON.stringify({ port: 0, cert: "c", token: "t" }))).toThrow(/socket path nor a port/);
  });
});

describe("decodeUserListResponse", () => {
  it("decodes users and addresses, skipping the Bridge password and unknown fields", () => {
    const users = decodeUserListResponse(encodeUserList([
      { id: "u1", username: "me@proton.me", state: 2, password: "bridge-secret", addresses: ["me@proton.me", "work@example.com"] },
      { id: "u2", username: "other@pm.me", state: 0, splitMode: true, addresses: ["other@pm.me"] },
    ]));
    expect(users).toEqual([
      { id: "u1", username: "me@proton.me", state: 2, splitMode: false, addresses: ["me@proton.me", "work@example.com"] },
      { id: "u2", username: "other@pm.me", state: 0, splitMode: true, addresses: ["other@pm.me"] },
    ]);
    expect(JSON.stringify(users)).not.toContain("bridge-secret");
  });

  it("decodes an empty list and rejects truncated input", () => {
    expect(decodeUserListResponse(Buffer.alloc(0))).toEqual([]);
    const full = encodeUserList([{ id: "u1", addresses: ["a@b.c"] }]);
    expect(() => decodeUserListResponse(full.subarray(0, full.length - 2))).toThrow(/truncated/);
  });

  it("unframes gRPC messages", () => {
    expect(unframeGrpcMessage(frame(Buffer.from("abc"))).toString()).toBe("abc");
    expect(() => unframeGrpcMessage(Buffer.from([1, 0, 0, 0, 0]))).toThrow(/compressed/);
    expect(() => unframeGrpcMessage(Buffer.from([0, 0, 0, 0, 9, 1]))).toThrow(/truncated/);
  });
});

describe("sender matching", () => {
  it("compares case-insensitively and treats +tag forms as the base address", () => {
    expect(senderAddressKey("Me+News@Proton.ME")).toBe("me@proton.me");
    expect(isKnownSender("ME+x@proton.me", ["me@proton.me"])).toBe(true);
    expect(isKnownSender("made-up@proton.me", ["me@proton.me"])).toBe(false);
  });

  it("finds only the connected user owning the account's login", () => {
    const users: BridgeUser[] = [
      { id: "1", username: "old@pm.me", state: 0, splitMode: false, addresses: ["me@proton.me"] },
      { id: "2", username: "me", state: 2, splitMode: false, addresses: ["me@proton.me", "alias@x.com"] },
    ];
    expect(findBridgeUser(users, "Me@Proton.me")?.id).toBe("2");
    expect(findBridgeUser(users, "alias@x.com")?.id).toBe("2");
    expect(findBridgeUser(users, "stranger@x.com")).toBeUndefined();
  });
});

describe("grpcUnaryCall against a fake Bridge", () => {
  it("sends the server token and returns the decoded user list (TCP, as on Windows)", async () => {
    const bridge = fakeBridge({ body: encodeUserList([{ id: "u1", username: "me@proton.me", state: 2, addresses: ["me@proton.me"] }]) });
    const port = await listenTcp(bridge);
    const path = writeConfig(tempDir(), { port, cert: CERT, token: "tok-123", fileSocketPath: "" });
    const users = await fetchBridgeUsers(path);
    expect(users[0].addresses).toEqual(["me@proton.me"]);
    expect(bridge.seen).toEqual([{ path: "/grpc.Bridge/GetUserList", token: "tok-123" }]);
  });

  it.skipIf(process.platform === "win32")("dials the unix socket, falling back to the config file's directory", async () => {
    const bridge = fakeBridge({ body: encodeUserList([]) });
    const dir = tempDir();
    await new Promise<void>(resolve => bridge.server.listen(join(dir, "bridge1234"), resolve));
    cleanups.push(() => bridge.server.close());
    // Bridge recorded the socket under another mount point.
    const path = writeConfig(dir, { port: 0, cert: CERT, token: "t", fileSocketPath: "/elsewhere/bridge1234" });
    await expect(fetchBridgeUsers(path)).resolves.toEqual([]);
  });

  it("surfaces a non-OK gRPC status", async () => {
    const bridge = fakeBridge({ status: "16" });
    const port = await listenTcp(bridge);
    const cfg = { port, cert: CERT, token: "bad", fileSocketPath: "" };
    await expect(grpcUnaryCall(cfg, "/x.json", "/grpc.Bridge/GetUserList", 3000, "win32"))
      .rejects.toThrow(/status 16: denied here/);
  });

  it("refuses a server whose certificate is not the pinned one", async () => {
    const bridge = fakeBridge({ body: encodeUserList([]) });
    const port = await listenTcp(bridge);
    const otherCert = rootCertificates[0];
    expect(otherCert).not.toBe(CERT);
    const cfg = { port, cert: CERT, token: "t", fileSocketPath: "" };
    // Same server, but the config pins a certificate it does not present.
    await expect(grpcUnaryCall({ ...cfg, cert: otherCert }, "/x.json", "/p", 3000, "win32")).rejects.toThrow();
  });
});

describe("BridgeSenderDirectory", () => {
  const me: BridgeUser = { id: "1", username: "me@proton.me", state: 2, splitMode: false, addresses: ["me@proton.me", "work@example.com"] };

  function directory(fetchUsers: () => Promise<BridgeUser[]>, now = { t: 0 }) {
    const path = writeConfig(tempDir(), {});
    return new BridgeSenderDirectory({ configPath: path, fetchUsers, now: () => now.t, ttlMs: 1000, failureTtlMs: 500 });
  }

  it("returns the account's addresses and caches them until the TTL or a fresh lookup", async () => {
    let calls = 0;
    const now = { t: 0 };
    const dir = directory(async () => { calls++; return [me]; }, now);
    expect(await dir.lookup("me@proton.me")).toEqual({ available: true, addresses: me.addresses, splitMode: false });
    await dir.lookup("me@proton.me");
    expect(calls).toBe(1);
    await dir.lookup("me@proton.me", { fresh: true });
    expect(calls).toBe(2);
    now.t = 5000;
    await dir.lookup("me@proton.me");
    expect(calls).toBe(3);
  });

  it("reports unavailable when Bridge cannot be read, the user is unknown, or discovery is off", async () => {
    const failing = directory(async () => { throw new Error("connect ENOENT"); });
    expect(await failing.lookup("me@proton.me")).toEqual({ available: false, reason: "connect ENOENT" });
    const other = directory(async () => [me]);
    expect((await other.lookup("stranger@x.com")).available).toBe(false);
    expect((await new BridgeSenderDirectory({ configPath: null }).lookup("me@proton.me")).available).toBe(false);
    const missing = new BridgeSenderDirectory({ configPath: join(tempDir(), "absent.json"), fetchUsers: async () => [me] });
    expect(await missing.lookup("me@proton.me")).toMatchObject({ available: false, reason: expect.stringContaining("--grpc") });
  });

  it("never lets a fresh lookup reuse a read that started before it", async () => {
    let calls = 0;
    const releases: Array<(users: BridgeUser[]) => void> = [];
    const dir = directory(() => { calls++; return new Promise(r => releases.push(r)); });
    const stale = dir.lookup("me@proton.me");
    const fresh = dir.lookup("new@proton.me", { fresh: true });
    const joinsFresh = dir.lookup("new@proton.me");
    expect(calls).toBe(2);
    releases[0]([me]);
    releases[1]([{ ...me, addresses: [...me.addresses, "new@proton.me"] }]);
    expect((await stale).available).toBe(true);
    expect(await fresh).toMatchObject({ available: true, addresses: expect.arrayContaining(["new@proton.me"]) });
    expect(await joinsFresh).toMatchObject({ available: true });
    expect(calls).toBe(2);
  });

  it("shares one in-flight request between concurrent lookups", async () => {
    let calls = 0;
    const dir = directory(async () => { calls++; await new Promise(r => setTimeout(r, 10)); return [me]; });
    await Promise.all([dir.lookup("me@proton.me"), dir.lookup("me@proton.me"), dir.lookup("me@proton.me")]);
    expect(calls).toBe(1);
  });
});
