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
