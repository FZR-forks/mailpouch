// Apply the container's MAILPOUCH_* environment to ~/.mailpouch.json before the
// daemon starts. Only variables that are set are applied, so settings made
// another way (Settings UI, CLI) survive restarts unless the environment says
// otherwise.
//
//   MAILPOUCH_PUBLIC_URL         OAuth issuer: the URL clients use to reach the
//                                daemon (e.g. https://mail-mcp.example.com)
//   MAILPOUCH_PERMISSION_PRESET  global permission ceiling: full | read_only |
//                                supervised | send_only
//   MAILPOUCH_AI_ACCESS_LABEL    restrict agents to one Proton label. Empty or
//                                unset leaves the current setting: losing the
//                                variable must never lift the restriction.
//   MAILPOUCH_AI_ACCESS_LABEL_OFF=true   explicitly turn the restriction off
const { loadConfig, saveConfig, buildPermissions } = await import("/app/dist/config/loader.js");
const { PERMISSION_PRESETS } = await import("/app/dist/config/schema.js");

const config = loadConfig();
if (!config?.connection?.username) {
  console.error("MailPouch is not connected to Bridge yet. Run: docker compose run --rm mailpouch setup-bridge --username <your Proton address>");
  process.exit(1);
}

const env = process.env;
// The daemon is the container's only transport, and it requires OAuth.
config.connection.remoteMode = true;
config.connection.remoteOauthEnabled = true;
if (env.MAILPOUCH_PUBLIC_URL !== undefined) {
  config.connection.remoteOauthIssuer = env.MAILPOUCH_PUBLIC_URL.trim() || undefined;
}
if (env.MAILPOUCH_PERMISSION_PRESET) {
  const preset = env.MAILPOUCH_PERMISSION_PRESET.trim();
  if (!PERMISSION_PRESETS.includes(preset) || preset === "custom") {
    console.error(`MAILPOUCH_PERMISSION_PRESET must be one of ${PERMISSION_PRESETS.filter(p => p !== "custom").join(", ")}.`);
    process.exit(1);
  }
  if (config.permissions?.preset !== preset) config.permissions = buildPermissions(preset);
}
const label = env.MAILPOUCH_AI_ACCESS_LABEL?.trim();
if (label && env.MAILPOUCH_AI_ACCESS_LABEL_OFF === "true") {
  console.error("Set either MAILPOUCH_AI_ACCESS_LABEL or MAILPOUCH_AI_ACCESS_LABEL_OFF, not both.");
  process.exit(1);
}
if (label) config.aiAccessLabel = label;
else if (env.MAILPOUCH_AI_ACCESS_LABEL_OFF === "true") config.aiAccessLabel = "";
saveConfig(config);
