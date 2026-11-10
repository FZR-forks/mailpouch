import { existsSync, readFileSync } from "fs";
import { writeOwnerOnlyJsonAtomically } from "../utils/atomic-json.js";

export interface LabelPolicyState {
  enabled(): boolean;
  record(enabled: boolean): void;
}

/** Durable evidence survives deleted config fields/files and process restarts. */
export function labelPolicyState(configPath: string): LabelPolicyState {
  const path = `${configPath}.label-policy.json`;
  return {
    enabled: () => {
      if (!existsSync(path)) return false;
      const value: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1
          || typeof (value as { enabled?: unknown }).enabled !== "boolean") {
        throw new Error("Mailbox policy state is unreadable");
      }
      return (value as { enabled: boolean }).enabled;
    },
    record: enabled => writeOwnerOnlyJsonAtomically(path, { version: 1, enabled }),
  };
}
