// One-time connection of MailPouch to the Bridge container:
//   docker compose run --rm mailpouch setup-bridge --username you@proton.me
//
// 1. Pins the TLS certificate Bridge presents on the private compose network
//    (trust on first use; Bridge 3 keeps its certificate inside its vault).
// 2. Reads the Bridge password shown by Bridge's `info` command (hidden prompt,
//    or stdin when piped). This is Bridge's own password, not your Proton one.
// 3. Runs `mailpouch setup` with the container addresses, then `doctor`.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { connect } from "node:net";
import { createInterface } from "node:readline";
import { connect as tlsConnect } from "node:tls";

const host = process.env.MAILPOUCH_BRIDGE_HOST || "protonmail-bridge";
const imapPort = Number(process.env.MAILPOUCH_BRIDGE_IMAP_PORT || 143);
const smtpPort = Number(process.env.MAILPOUCH_BRIDGE_SMTP_PORT || 25);
const certPath = `${process.env.HOME}/bridge-cert.pem`;

const args = process.argv.slice(2);
const username = args[args.indexOf("--username") + 1];
if (!args.includes("--username") || !username || username.startsWith("--")) {
  console.error("Usage: setup-bridge --username <the Username shown by Bridge's `info`>");
  process.exit(2);
}

/** Upgrade an IMAP connection with STARTTLS and return Bridge's certificate. */
function fetchBridgeCert() {
  return new Promise((resolve, reject) => {
    const socket = connect(imapPort, host);
    socket.setTimeout(15_000, () => socket.destroy(new Error(`No answer from Bridge at ${host}:${imapPort}`)));
    let buffer = "";
    let sent = false;
    socket.on("error", reject);
    socket.on("data", chunk => {
      buffer += chunk.toString("latin1");
      if (!sent && buffer.includes("\r\n")) { sent = true; buffer = ""; socket.write("a1 STARTTLS\r\n"); return; }
      if (!sent || !/^a1 OK/m.test(buffer)) return;
      socket.removeAllListeners("data");
      socket.setTimeout(0);
      // Bridge's certificate is self-signed: accept it here, then pin it.
      const tls = tlsConnect({ socket, rejectUnauthorized: false, servername: "localhost" }, () => {
        const der = tls.getPeerCertificate().raw;
        tls.destroy();
        der ? resolve(der) : reject(new Error("Bridge presented no certificate"));
      });
      tls.setTimeout(15_000, () => tls.destroy(new Error(`TLS handshake with Bridge at ${host}:${imapPort} timed out`)));
      tls.on("error", reject);
    });
  });
}

/** Read one line without echoing it (or all of stdin when it is not a terminal). */
async function readSecret(prompt) {
  if (!process.stdin.isTTY) {
    let data = "";
    for await (const chunk of process.stdin) data += chunk;
    return data.trim();
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  process.stdout.write(prompt);
  rl._writeToOutput = () => {}; // hide typed characters
  const answer = await new Promise(resolve => rl.question("", resolve));
  rl.close();
  process.stdout.write("\n");
  return answer.trim();
}

const der = await fetchBridgeCert();
const pem = `-----BEGIN CERTIFICATE-----\n${der.toString("base64").match(/.{1,64}/g).join("\n")}\n-----END CERTIFICATE-----\n`;
writeFileSync(certPath, pem, { mode: 0o600 });
console.log(`Pinned the Bridge certificate (SHA-256 ${createHash("sha256").update(der).digest("hex").match(/.{2}/g).join(":")}).`);

const password = await readSecret("Bridge password (the Password shown by `info`): ");
if (!password) { console.error("No password given."); process.exit(2); }

const setup = spawnSync("node", ["/app/dist/index.js", "setup", "--username", username, "--password-stdin",
  "--imap-host", host, "--imap-port", String(imapPort), "--smtp-host", host, "--smtp-port", String(smtpPort),
  "--bridge-cert", certPath], { input: password, stdio: ["pipe", "inherit", "inherit"] });
if (setup.status !== 0) process.exit(setup.status ?? 1);
const doctor = spawnSync("node", ["/app/dist/index.js", "doctor"], { stdio: "inherit" });
process.exit(doctor.status ?? 1);
