# Restrict agents to a Proton label

Create a label such as `AI-Accessible` in Proton Mail, then open MailPouch
Settings → Permissions → **AI email access label**, enter `AI-Accessible`, and
save. The equivalent top-level config field is:

```json
{ "aiAccessLabel": "AI-Accessible" }
```

Use the label name, without `Labels/`. This is an opt-in restriction: an absent
or empty setting retains upstream's existing access policy. Configure it before
connecting agents. Invalid nonempty values or an unreadable config block mail access. Losing the
config after enabling the policy also blocks access until settings are restored.
A private adjacent `.label-policy.json` marker preserves activation across
restarts. Removing the setting does not disable it; explicitly save an empty
label (or perform a full configuration reset) to disable filtering. The same label
name applies to all configured accounts; create it in each account used to send.

With the setting enabled, the MCP keeps its existing folder layout, tool
arguments, physical-folder UIDs, pagination, and normal send results. There is
no special folder or label for an agent to select. Inbox and Sent still mean
Inbox and Sent, and secondary labels keep their usual folder paths.

The backend intersects each requested mailbox with current access-label
membership before fetching message bodies, paginating lists, applying search
limits, downloading attachments, or changing flags. Folder and unread counts
reflect only visible mail. Analytics use fresh filtered Inbox/Sent data in an
isolated per-call service rather than the whole-account cache. Unscoped
background analytics, indexing, and reminder detection are paused while enabled. Tools,
resources, and prompts all use this backend, including trusted local callers.
Existing per-agent folder grants still apply and can narrow access further.

The access label itself is omitted from folder/label listings and agent-facing
instructions, cursors, and successful send results. Messages keep their normal
folder names and UIDs. Unlabeled messages resolve as absent. The account owner
can add/remove messages from the visible set in Proton without restarting
MailPouch; changes take effect after Bridge synchronizes. A policy change during
a request discards its result. Policy setup failures surface as an ordinary
mailbox-unavailable error, with details retained in owner logs.

The cross-folder membership check uses Bridge's generated `X-Pm-Internal-Id`,
not a sender-controlled RFC Message-ID. Distinct messages sharing a Message-ID
cannot authorize one another, and a colliding UID in Sent cannot authorize a
message in Inbox. Missing Bridge identities fail closed. UID filters are bound
to the source mailbox's UIDVALIDITY and checked under its lock, protecting
against a mailbox rebuild between authorization and reading. Message bodies
and membership never use an old authorization cache.

FTS (cached snippets/index stats), server logs, drafts, local scheduled/reminder
history, and mailbox administration still lack safe message scope. They remain
unavailable in this first implementation, rather than expose unfiltered
account data. The tools that are exposed keep their original schemas; no
label-related parameters or instructions are added.

## Outgoing mail

Direct sends, replies, forwards, test sends, and the persistent scheduler all
use the same account-owned SMTP labeling path. `send_email`, `reply_to_email`,
`forward_email`, and `schedule_email` accept an optional `from` address. Proton
SMTP validates whether the authenticated account may use that sender.
`account_id` still selects the account/credentials.

Before delivery, MailPouch checks that the label exists and saves a labeling
job with a server-generated Message-ID using the sender's domain. When the
filter is disabled, Nodemailer's normal Message-ID generation is preserved. If either step fails, SMTP is not
called. After SMTP, the label worker finds the exact Message-ID in the
server-reported Sent mailbox and applies the label via IMAP COPY, preserving
Sent membership. It verifies label membership before removing the job.

**SMTP and labeling are not atomic.** The agent receives the usual successful
send result. The Sent copy becomes visible after background labeling finishes;
no labeling status or special follow-up action is exposed to the agent.
The worker checks every 10 seconds and retries labeling across Bridge outages,
delayed Sent synchronization, and process restarts. Label retries never resend
email. Definitively rejected SMTP attempts discard their labeling jobs;
ambiguous deliveries retain them for reconciliation. MailPouch must remain running for queued labeling and scheduled delivery.
Queues are stored next to the selected config, use private file permissions and
cross-process write locks, and are bound to the mailbox/transport fingerprint.
An account repointed to another mailbox cannot process the old queue.

A job retains the label selected when SMTP was attempted, even if settings
later change. Jobs retry for up to 30 days. Older unconfirmed jobs remain in the
same file with a `needsAttentionAt` timestamp and a prominent server-log error, and
stop automatic retries. They do not count against the 10,000 active-job send
limit. Legacy jobs without `createdAt` get a full retry window on upgrade.
Restore the destination label and confirm the Sent copy, then either apply the
label manually or remove `needsAttentionAt` and reset `createdAt` to the current
Unix time in milliseconds while MailPouch is stopped. Inspect the account-owned
`.outgoing-labels-<fingerprint>.json` file and server logs to diagnose failures.
Do not delete pending records for delivered mail until labeling is resolved.
Once a job completes, manually removing the label revokes access; the worker
will not add it back.

Scheduling retains upstream's local persistent queue and 30-day horizon.
Scheduled delivery uses the label configured at delivery time. Agent-facing
list/cancel history is currently blocked because upstream records have no
label provenance; scheduling still returns the new schedule ID. This is a
follow-up capability. Secondary-label reads and analytics are already filtered.

## Incoming replies and verification

MailPouch does not grant access based on a matching subject or conversation ID.
An incoming reply must itself have the access label before the agent can read
it. The agent does not need to know or request this label. Proton's sticky-label setting is intended to apply a conversation's labels
to later sent/received messages; see Proton's own [settings text](https://github.com/ProtonMail/proton-translations/blob/fe-mail-settings/id_ID.json)
and [label documentation](https://proton.me/support/using-folders-labels).
Check sticky labels and conversation grouping in the Proton account, then verify
inheritance with a test conversation. MailPouch does not change those account
settings or label unrelated incoming mail.

Automated tests cover scope bypasses, cached reads after revocation, filtered
metadata, durable labeling retries, missing labels, alternate senders, and
settings validation. Real Proton Bridge testing is still required before
relying on this feature. Use an isolated test account to verify:

1. An unlabeled message and attachment cannot be read by tool, resource,
   prompt, thread, search, or cache path, even with a colliding Inbox UID.
2. Manually labeling an existing message makes it discoverable without a
   restart; removing the label hides it again, including previously read mail.
3. Direct send, reply, forward, alternate sender, and scheduled delivery each
   appear in Sent and under the access label, without duplicate deliveries.
4. A Bridge interruption or daemon restart after SMTP acceptance resumes
   labeling without resending; removing the label after completion stays revoked.
5. An incoming reply inherits the label when Proton sticky labels are enabled;
   an unrelated incoming message stays hidden.

Bridge retains broad access to decrypted mail; this setting restricts what the
MCP exposes. Quoted text and attachments within a labeled message are authorized
with that message. Review Proton's conversation-wide labeling behavior when
choosing which messages to expose.
