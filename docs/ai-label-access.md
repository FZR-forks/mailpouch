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
config after enabling the policy also blocks access until settings are restored. The same label
name applies to all configured accounts; create it in each account used to send.

With the setting enabled:

- Every MCP caller, including trusted local stdio clients, is restricted.
  OAuth approval, tool permissions, and per-agent grants still apply. An
  escalation or `full` grant cannot override this label boundary.
- Lists, searches, threads, email reads, attachments, replies, and forwards
  use only `Labels/AI-Accessible`. Omitted folder arguments default to that
  path. Explicit other paths, alternate labels, and wildcard searches fail.
  UIDs are local to the label mailbox: use IDs discovered there, never IDs
  copied from Inbox or Sent.
- Label membership is checked using live IMAP reads, including by-ID and
  attachment requests. Search results bypass cached bodies as well, protecting
  against UID reuse after a label mailbox rebuild. Manually adding/removing
  the label takes effect on the next read after Bridge synchronizes with Proton.
  Changing the configured label during a request discards its result.
- Folder listings and unread counts expose only the access label. Email
  resources obey the same restriction. Prompts that require Inbox, Sent, or
  unqualified email IDs are blocked; prompts with a folder argument can use
  the access label.
- Whole-account analytics, FTS (including cached snippets and index stats),
  logs, drafts, local scheduled/reminder history, label/folder administration,
  and move/delete tools are blocked. These need additional scoping before they
  can be exposed safely. New tools default to blocked until reviewed.

## Outgoing mail

Direct sends, replies, forwards, test sends, and the persistent scheduler all
use the same account-owned SMTP labeling path. `send_email`, `reply_to_email`,
`forward_email`, and `schedule_email` accept an optional `from` address. Proton
SMTP validates whether the authenticated account may use that sender.
`account_id` still selects the account/credentials.

Before delivery, MailPouch checks that the label exists and saves a labeling
job with a server-generated Message-ID. If either step fails, SMTP is not
called. After SMTP, the label worker finds the exact Message-ID in the
server-reported Sent mailbox and applies the label via IMAP COPY, preserving
Sent membership. It verifies label membership before removing the job.

**SMTP and labeling are not atomic.** A successful send reports `labeling:
"queued"`; the sent copy remains hidden from the agent until labeling finishes.
The worker checks every 10 seconds and retries labeling across Bridge outages,
delayed Sent synchronization, and process restarts. Label retries never resend
email. MailPouch must remain running for queued labeling and scheduled delivery.
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
follow-up capability, as are secondary labels and scoped analytics.

## Incoming replies and verification

MailPouch does not grant access based on a matching subject or conversation ID.
An incoming reply must itself have the access label before the agent can read
it. Proton's sticky-label setting is intended to apply a conversation's labels
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
