import { mkdtempSync, rmSync, writeFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { labelPolicyState } from "./label-policy-state.js";
import { describe, it, expect, vi } from "vitest";
import { createLabelPolicyReader } from "./label-config.js";

describe("live label policy", () => {
  it("fails closed when an enabled policy disappears or becomes unreadable", () => {
    let config: { aiAccessLabel?: unknown } | null = { aiAccessLabel: "AI" };
    const read = createLabelPolicyReader(() => config, () => false);
    expect(read()).toBe("Labels/AI");
    config = null;
    expect(read).toThrow("blocked");
    config = { aiAccessLabel: "AI-New" };
    expect(read()).toBe("Labels/AI-New");
    config = { aiAccessLabel: "" };
    expect(read()).toBeUndefined();
  });
  it("denies a corrupt existing config even on first read", () => {
    expect(createLabelPolicyReader(() => null, () => true)).toThrow("blocked");
  });
  it("preserves an unconfigured installation's setup behavior", () => {
    expect(createLabelPolicyReader(() => null, () => false)()).toBeUndefined();
  });
});


describe("durable fail-closed label policy", () => {
  it("resolves the marker path on each read and write after the active profile changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "mailpouch-label-policy-"));
    try {
      const first = join(dir, "first.json");
      const second = join(dir, "second.json");
      let path = first;
      const resolve = vi.fn(() => path);
      const state = labelPolicyState(resolve);
      expect(resolve).not.toHaveBeenCalled();
      const read = createLabelPolicyReader(() => ({}), () => true, state);
      expect(read()).toBeUndefined();
      labelPolicyState(second).record(true);
      path = second;
      expect(read).toThrow("blocked");
      state.record(false);
      expect(labelPolicyState(second).enabled()).toBe(false);
      path = first;
      state.record(true);
      expect(labelPolicyState(first).enabled()).toBe(true);
      expect(labelPolicyState(second).enabled()).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("keeps imports available with an invalid config override while blocking mail access", async () => {
    vi.stubEnv("MAILPOUCH_CONFIG", join(homedir(), "..", "outside-home-mailpouch.json"));
    vi.resetModules();
    try {
      const module = await import("./label-config.js");
      expect(module.currentAccessLabelFolder).toThrow("must point to a path within the home directory");
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
  it("captures activation at startup before any request", () => {
    let config: { aiAccessLabel?: unknown } | null = { aiAccessLabel: "AI" };
    const read = createLabelPolicyReader(() => config, () => false);
    config = null;
    expect(read).toThrow("blocked");
  });
  it("rejects removed/undefined fields until an explicit empty setting", () => {
    let config: { aiAccessLabel?: unknown } = { aiAccessLabel: "AI" };
    const read = createLabelPolicyReader(() => config, () => true);
    config = {};
    expect(read).toThrow("blocked");
    config = { aiAccessLabel: undefined };
    expect(read).toThrow("blocked");
    config = { aiAccessLabel: "" };
    expect(read()).toBeUndefined();
  });
  it("retains activation across restarts, config deletion, and field deletion", () => {
    const dir = mkdtempSync(join(tmpdir(), "mailpouch-label-policy-"));
    try {
      const path = join(dir, "config.json");
      const state = labelPolicyState(path);
      createLabelPolicyReader(() => ({ aiAccessLabel: "AI" }), () => true, state);
      expect(state.enabled()).toBe(true);
      if (process.platform !== "win32") expect(statSync(`${path}.label-policy.json`).mode & 0o777).toBe(0o600);
      expect(createLabelPolicyReader(() => null, () => false, labelPolicyState(path))).toThrow("blocked");
      expect(createLabelPolicyReader(() => ({}), () => true, labelPolicyState(path))).toThrow("blocked");
      expect(createLabelPolicyReader(() => ({ aiAccessLabel: "" }), () => true, state)()).toBeUndefined();
      expect(state.enabled()).toBe(false);
      expect(createLabelPolicyReader(() => ({}), () => true, labelPolicyState(path))()).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("fails closed on a corrupt marker and permits explicit owner recovery", () => {
    const dir = mkdtempSync(join(tmpdir(), "mailpouch-label-policy-"));
    try {
      const path = join(dir, "config.json");
      writeFileSync(`${path}.label-policy.json`, "corrupt");
      const state = labelPolicyState(path);
      expect(createLabelPolicyReader(() => ({}), () => true, state)).toThrow("blocked");
      expect(createLabelPolicyReader(() => ({ aiAccessLabel: "AI" }), () => true, state)()).toBe("Labels/AI");
      expect(state.enabled()).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("does not grant access if activation evidence cannot be persisted", () => {
    let config: { aiAccessLabel?: unknown } | null = { aiAccessLabel: "AI" };
    const read = createLabelPolicyReader(() => config, () => false, {
      enabled: () => false, record: () => { throw new Error("disk full"); },
    });
    // The constructor's startup read already failed to persist; every later read retries and stays blocked.
    expect(read).toThrow("blocked");
    expect(read).toThrow("blocked");
    config = null;
    expect(read).toThrow("blocked");
  });
});
