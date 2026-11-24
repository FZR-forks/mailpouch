# Sender addresses from Proton Bridge

A Proton account can send from several addresses: the main one, extra
addresses, and custom-domain addresses added under Proton's settings. In
Bridge's combined mode they all share one mailbox and one IMAP/SMTP login, and
IMAP has no command that lists them. MailPouch asks Bridge itself instead.

## What agents see

When the list is available, the `from` field of `send_email`,
`reply_to_email`, `forward_email`, and `schedule_email` names the account's
addresses:

```json
"from": {
  "type": "string",
  "enum": ["me@proton.me", "me@pm.me", "hello@example.com"],
  "description": "Sender address (optional). This Proton account can send from: me@proton.me, me@pm.me, hello@example.com. Omit to send from me@proton.me. Any other address is rejected."
}
```

- With one configured account the list is an `enum`. With several accounts it
  is in the description only and names the active account, because a call
  routed with `account_id` belongs to another account.
- A `from` outside the list is refused before anything is sent, with the valid
  addresses in the error. MailPouch first re-reads Bridge's list, so an address
  you added in Proton a moment ago is accepted. `name+tag@domain` counts as
  `name@domain`, as it does in Bridge.
- `reply_to_email` with `replyAll` leaves all of your own addresses out of CC.
- MCP clients usually fetch the tool list once per session, so reconnect the
  agent to see a newly added address in the schema.

If the list cannot be read (Bridge without its gRPC service, a remote Bridge,
or an IMAP account), the tools behave as before: any valid `from` is passed to
Bridge, which refuses addresses the account does not own.

## Where the list comes from

Bridge's desktop app controls Bridge through a local gRPC service. MailPouch
makes one read-only call on it, `GetUserList`, which returns each signed-in
Proton user with the addresses Bridge accepts as a sender. Disabled addresses
are already left out. MailPouch uses the Bridge user whose address matches the
account's IMAP/SMTP username, and caches the list for a minute.

To reach the service, MailPouch reads `grpcServerConfig.json`, which Bridge
writes on every start:

| Platform | Default location |
|---|---|
| Linux | `$XDG_CONFIG_HOME/protonmail/bridge-v3/` (default `~/.config/protonmail/bridge-v3/`) |
| macOS | `~/Library/Application Support/protonmail/bridge-v3/` |
| Windows | `%APPDATA%\protonmail\bridge-v3\` |
| Docker (`compose.yaml`) | `/run/mailpouch-bridge/` |

`MAILPOUCH_BRIDGE_GRPC_CONFIG` sets another path, or turns discovery off with
`off`.

The file holds a per-start access token and certificate. On Linux and macOS
the service listens on a unix socket; on Windows it listens on `127.0.0.1`.
MailPouch pins the certificate from the file.

## Setups

- **Bridge desktop app on the same machine and user:** nothing to do. The app
  starts Bridge with `--grpc` and the file is in its default place.
- **Docker Compose:** `compose.yaml` runs Bridge through
  `docker/bridge-grpc.sh`, which starts Bridge with `--grpc` instead of
  `--noninteractive` and shares the socket and file with the MailPouch
  container. See [Docker](docker.md#sender-addresses).
- **Headless Bridge started by hand:** start the `bridge` binary (not the
  `proton-bridge` launcher, which opens the GUI for `--grpc`) with `--grpc`,
  and make its socket and `grpcServerConfig.json` readable by MailPouch's user.
- **Bridge on another host:** not supported; the service is local only.

## Security notes

- The token in `grpcServerConfig.json` controls all of Bridge, not just the
  address list: whoever holds it could sign accounts out or read the Bridge
  password. MailPouch already holds that password. MailPouch calls only
  `GetUserList`, skips the Bridge password field in the reply without
  decoding it, and never logs the token. In Docker the token and socket are
  readable by MailPouch's user only.
- MailPouch never opens Bridge's event stream: Bridge stops when a client of
  that stream disconnects.
