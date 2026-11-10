import { mkdtempSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { labelPolicyState } from "./label-policy-state.js";
import { describe, it, expect } from "vitest";
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
    expect(read).toThrow("blocked");
    config = null;
    expect(read).toThrow("blocked");
  });
});
