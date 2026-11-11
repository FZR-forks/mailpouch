# Run MailPouch and Proton Bridge with Docker Compose

`compose.yaml` runs two containers on a headless server:

- **protonmail-bridge**: Proton Mail Bridge, from the community
  [dancwilliams/protonmail-bridge-docker](https://github.com/dancwilliams/protonmail-bridge-docker)
  image, pinned to one build. It publishes no ports; only MailPouch reaches it, on
  a private network.
- **mailpouch**: the MailPouch HTTP daemon (`ghcr.io/fzr-forks/mailpouch`),
  published on the host's loopback interface, port 8788.

Proton Bridge requires a paid Proton Mail plan.

## 1. Log Bridge in to your Proton account

```sh
docker compose run --rm protonmail-bridge init
```

This opens Bridge's own command line. You type everything yourself, so your
Proton password never lands in a file or the shell history:

1. `login`, then your Proton address and password.
2. If your account has two-factor authentication, enter the code from your
   authenticator app at the `Two factor code:` prompt. (Security keys are not
   supported inside the container.) Two-password accounts are asked for their
   mailbox password next.
3. If Proton asks for human verification, Bridge prints a
   `https://verify.proton.me/...` link: open it on any device, solve the
   challenge, then press Enter.
4. `info` shows the **Username** and **Password** for IMAP/SMTP. This is
   Bridge's own password, not your Proton one; you need it in step 2.
5. `exit`, then `Ctrl+C` if the container does not stop on its own.

Bridge keeps a session token, never your password. To encrypt Bridge's
keychain at rest, set `KEYRING_PASSPHRASE` (for example in `.env`) before
running `init`. Proton's QR-code sign-in is not supported by Bridge.

## 2. Connect MailPouch to Bridge

```sh
docker compose up -d protonmail-bridge
docker compose run --rm mailpouch setup-bridge --username <Username from info>
```

`setup-bridge` pins the TLS certificate Bridge presents on the private network
(it prints the fingerprint), asks for the Bridge password from `info` without
echoing it, saves the connection, and runs `mailpouch doctor`.

## 3. Start MailPouch

```sh
docker compose up -d
docker compose ps        # both services should become healthy
```

Settings come from the environment (for example a `.env` file next to
`compose.yaml`) and are applied on every start:

| Variable | Default | Meaning |
|---|---|---|
| `MAILPOUCH_PUBLIC_URL` | `http://127.0.0.1:8788` | URL agents use to reach MailPouch; the OAuth issuer |
| `MAILPOUCH_PERMISSION_PRESET` | `supervised` | Ceiling for every agent: `full`, `supervised`, `send_only` or `read_only` |
| `MAILPOUCH_AI_ACCESS_LABEL` | unset | Only mail with this Proton label is visible to agents ([details](ai-label-access.md)). Unset or empty keeps the current setting |
| `MAILPOUCH_AI_ACCESS_LABEL_OFF` | unset | `true` turns the label restriction off |
| `MAILPOUCH_BIND` | `127.0.0.1` | Host address the daemon is published on |
| `MAILPOUCH_TAG` | `latest` | MailPouch image tag (`latest`, a version, or `edge`) |
| `KEYRING_PASSPHRASE` | unset | Passphrase for Bridge's keychain |

## 4. Connect an agent

Every agent authenticates as its own OAuth client.

**Headless agents** use a pre-approved service account:

```sh
docker compose exec mailpouch mailpouch agent issue --name my-agent --preset supervised
```

It prints a `client_id` and `client_secret` once. The agent exchanges them for
a token at `POST /oauth/token` (`grant_type=client_credentials`).

**Interactive apps** (for example Claude Code with
`{"type": "http", "url": "<MAILPOUCH_PUBLIC_URL>/mcp"}`) register themselves
and wait for approval. Approve them within five minutes:

```sh
docker compose exec mailpouch mailpouch agent list
docker compose exec mailpouch mailpouch agent approve <client_id> --preset supervised
```

The per-agent preset can only narrow `MAILPOUCH_PERMISSION_PRESET`.

## Exposing MailPouch beyond the server

The daemon speaks plain HTTP. Keep `MAILPOUCH_BIND=127.0.0.1` and either reach
it over an SSH tunnel or VPN, or put a TLS reverse proxy (Caddy, nginx,
Traefik) in front of it and set `MAILPOUCH_PUBLIC_URL` to the proxy's
`https://` address.

Inside the container every client, proxied or direct, appears to come from
Docker's gateway address, because MailPouch only trusts `X-Forwarded-For` from
a loopback peer. Agents are still told apart by their own OAuth identity, but
per-agent IP pins cannot distinguish them, and the per-IP limit on the
unauthenticated OAuth endpoints is shared by all clients.

## Maintenance

- **Logs:** `docker compose logs -f mailpouch`. A healthy Bridge logs little.
- **Updates:** `docker compose pull && docker compose up -d`. The Bridge image
  is pinned in `compose.yaml`; bump its tag and digest to update Bridge.
- **Status:** `docker compose exec mailpouch mailpouch doctor`.
- **Sign out:** `docker compose run --rm protonmail-bridge init`, then
  `logout`; or end the Bridge session in Proton's web settings under
  Security → Sessions.
- **Data:** the `bridge` volume holds Bridge's session and mail cache; the
  `mailpouch` volume holds MailPouch's config (including the Bridge password),
  agent grants, and queues. Back up and protect both.
