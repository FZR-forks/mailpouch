import { configExists, loadConfig } from "../config/loader.js";
import { accessLabelFolder } from "./label-access.js";

/** A lost/corrupt policy must not turn an already-connected mailbox into broad access. */
export function createLabelPolicyReader(
  read: () => { aiAccessLabel?: unknown } | null,
  exists: () => boolean,
): () => string | undefined {
  let lastRestrictedFolder: string | undefined;
  return () => {
    const config = read();
    if (!config) {
      if (exists() || lastRestrictedFolder) throw new Error("Cannot read AI access policy; mail access is blocked until settings are restored.");
      return undefined;
    }
    const folder = accessLabelFolder(config.aiAccessLabel);
    lastRestrictedFolder = folder;
    return folder;
  };
}

export const currentAccessLabelFolder = createLabelPolicyReader(loadConfig, configExists);
