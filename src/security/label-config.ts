import { logger } from "../utils/logger.js";
import { configExists, getConfigPath, loadConfig } from "../config/loader.js";
import { accessLabelFolder } from "./label-access.js";
import { labelPolicyState, type LabelPolicyState } from "./label-policy-state.js";

/** Lost files/fields fail closed after activation; only an explicit empty value disables. */
export function createLabelPolicyReader(
  read: () => { aiAccessLabel?: unknown } | null,
  exists: () => boolean,
  state?: LabelPolicyState,
): () => string | undefined {
  let previouslyEnabled = false;
  const blocked = () => new Error("Mailbox access is blocked until settings are restored.");
  const current = () => {
    const config = read();
    let recorded: boolean;
    let repairMarker = false;
    try { recorded = state?.enabled() ?? previouslyEnabled; }
    catch {
      // An explicit valid setting can repair a broken marker; missing state
      // cannot be interpreted as permission to turn filtering off.
      if (config?.aiAccessLabel === undefined) throw blocked();
      recorded = true;
      repairMarker = true;
    }
    if (!config || config.aiAccessLabel === undefined) {
      if (recorded || previouslyEnabled || (!config && exists())) throw blocked();
      return undefined;
    }
    const enabled = config.aiAccessLabel !== "";
    // Remember observed intent even if marker persistence or label validation
    // fails, so a subsequent file deletion cannot reopen this process.
    if (enabled) previouslyEnabled = true;
    if (repairMarker || recorded !== enabled) {
      try { state?.record(enabled); }
      catch (error) {
        logger.error("Could not persist mailbox policy state", "MailboxAccess", error);
        throw blocked();
      }
    }
    const folder = accessLabelFolder(config.aiAccessLabel);
    previouslyEnabled = enabled;
    return folder;
  };
  // Observe startup configuration before the first tool call. Keep setup
  // diagnostics available on errors; authorization rethrows on the first read.
  try { current(); } catch { /* fail closed when mail is requested */ }
  return current;
}

export const currentAccessLabelFolder = createLabelPolicyReader(loadConfig, configExists, labelPolicyState(getConfigPath()));
