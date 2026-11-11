import { existsSync, readFileSync } from "fs";
import { writeOwnerOnlyJsonAtomically } from "../utils/atomic-json.js";

export interface LabelPolicyState {
  enabled(): boolean;
  record(enabled: boolean): void;
}

/** Durable evidence survives deleted config fields/files and restarts; resolvers follow the current canonical profile path. */
export function labelPolicyState(configPath: string | (() => string)): LabelPolicyState {
  const path = () => `${typeof configPath === "function" ? configPath() : configPath}.label-policy.json`;
  return {
    enabled: () => {
      const statePath = path();
      if (!existsSync(statePath)) return false;
      const value: unknown = JSON.parse(readFileSync(statePath, "utf8"));
      if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1
          || typeof (value as { enabled?: unknown }).enabled !== "boolean") {
        throw new Error("Mailbox policy state is unreadable");
      }
      return (value as { enabled: boolean }).enabled;
    },
    record: enabled => writeOwnerOnlyJsonAtomically(path(), { version: 1, enabled }),
  };
}
