# Restrict agents to a Proton label

Create a label such as `AI-Accessible` in Proton Mail, then open MailPouch
Settings → Permissions → **AI email access label**, enter `AI-Accessible`, and
save. The equivalent top-level config field is:

```json
{ "aiAccessLabel": "AI-Accessible" }
```

Use the label name, without `Labels/`. This is an opt-in restriction: an absent
or empty setting retains upstream's existing access policy. Configure it before
connecting agents; MCP clients usually read the tool list once per session.
Invalid nonempty values or an unreadable config block mail access. Losing the
config after enabling the policy also blocks access until settings are restored.
A private adjacent `.label-policy.json` marker preserves activation across
restarts. Removing the setting does not disable it; explicitly save an empty
label (or perform a full configuration reset) to disable filtering. The same label
name applies to all configured accounts; create it in each account used to send.

## What the agent sees

The MCP keeps its existing folder layout, tool arguments, physical-folder UIDs,
pagination, and normal results. There is no special folder or label for an agent
to select, and nothing tells it the policy exists. Inbox and Sent still mean
Inbox and Sent, and secondary labels keep their usual folder paths. The access
label is omitted from folder/label listings, counts, headers, cursors, errors, and
results. Requests naming it behave as if it does not exist ("Folder not found").

Everything with the label is fully usable: reading, search, threads, attachments,
flags, moving (including archive, spam, and trash), adding/removing other labels,
creating/renaming folders, drafts, replies, forwards, and scheduled sends. Proton
labels belong to the message, so moves keep the access label. MailPouch never
re-applies a label that disappears, because it cannot tell a server-side loss
from the owner removing it. The agent can never add, remove, rename, or recreate
the access label itself.

These tools are not listed while the policy is on, and calling them answers
exactly like an unknown tool: `delete_email`, `bulk_delete_emails`, `empty_trash`,
`delete_folder` (permanent or whole-mailbox effects; use `move_to_trash`), the
FTS tools (an index built from unfiltered mail), `get_logs` (server logs can
mention any mail), and the reply-reminder tools (their records keep a message's
subject and recipient after its label is removed). Tools that never touch mail
(SimpleLogin aliases, Proton Pass, Bridge/server control) behave exactly as they
do without the policy; they never read it, so even an unreadable policy does not
affect them. Every new tool must be classified before it is available under the
policy.

Existing per-agent folder grants still apply and can narrow access further. The
policy applies to tools, resources, and prompts, including trusted local callers.

## How filtering works

The backend intersects each requested mailbox with current access-label
membership before fetching message bodies, paginating, applying search limits,
downloading attachments, or changing anything. Membership is matched by Bridge's
generated `X-Pm-Internal-Id`, never the sender-controlled RFC Message-ID, so
distinct messages sharing a Message-ID cannot authorize one another and a
colliding UID in Sent cannot authorize a message in Inbox. Missing or duplicated
Bridge identities fail closed.

For speed, each mailbox's UID→identity mapping is cached per UIDVALIDITY (IMAP
never reuses a UID within one UIDVALIDITY), so a request only fetches headers for
newly arrived mail. Membership and flags are always read live, and every message
body or attachment released to the agent must itself carry the Bridge identity
the live label approved, so a stale or reused UID can never release a different
message. Reads are bound to the source mailbox's UIDVALIDITY under its lock, and
every scoped mutation re-proves, while holding the mailbox lock, that each UID it
touches was approved in that exact mailbox generation.

Owners can add or remove messages from the visible set in Proton without
restarting MailPouch; changes take effect after Bridge synchronizes. If a message
a read returned (or, for folder counts, any message counted) loses the label
before the response is returned, the result is discarded ("Mailbox temporarily
unavailable"; retry). Mail *gaining* the label, or unrelated approved mail losing
it, never invalidates a request. Lookups by ID list only the named UIDs rather
than whole mailboxes. Combined tool, resource, and prompt responses
revalidate every read they used before release. Analytics use fresh filtered
Inbox/Sent data in an isolated per-call service rather than the whole-account
cache, and unscoped background analytics and indexing are paused while enabled.

Once SMTP confirms a send, if a later failure, cancellation, or deadline prevents
normal completion, the response contains only the delivery receipt and Message-ID
(when available), with an explicit instruction not to resend. It never returns
discarded original-message content or raw validation errors.

## Outgoing mail and drafts

Mail an agent sends under the policy (direct sends, replies, forwards, test
sends, and its scheduled sends) and drafts it saves are labeled automatically.
Mail the owner sends, including schedules the owner created and sends from the
settings UI, is not labeled at send time, even if it is delivered while the policy
is on.
If the policy changes between a request and delivery, the copy is not labeled. `send_email`, `reply_to_email`,
`forward_email`, and `schedule_email` accept an optional `from` address so an
agent can pick among the account's addresses; Proton SMTP validates it.
`account_id` still selects the account/credentials.

Before delivery, MailPouch checks that the label exists and durably queues a
server-generated Message-ID using the sender's domain. If either step fails, SMTP
is not called. After SMTP, the label worker finds that exact Message-ID in Sent
and applies the label via IMAP COPY, then verifies it. Every background COPY
(sent mail, drafts) first proves the message's identity
under the source mailbox lock and is refused if the mailbox was rebuilt since. It retries a few seconds
after the send, then every 10 seconds, across Bridge outages, delayed Sent
synchronization, and restarts; retries never resend mail. Drafts are labeled the
same way, immediately after saving (or in Sent if the owner already sent it); a
draft deleted before labeling is dropped after a day.

**SMTP and labeling are not atomic.** The agent receives the usual successful
send result; its Sent copy becomes visible once labeling finishes. Definitively
rejected SMTP attempts discard their jobs; ambiguous deliveries keep them. Queues
are stored next to the selected config with private permissions and cross-process
locks, bound to the mailbox/transport fingerprint. A job keeps the label selected
when SMTP was attempted. Unconfirmed sent-mail jobs older than 30 days stop
retrying, get a `needsAttentionAt` timestamp and a prominent server-log error, and
do not count against the 10,000 active-job limit. To recover, confirm the Sent copy
and apply the label manually, or remove `needsAttentionAt` and reset `createdAt`
(Unix ms) while MailPouch is stopped. Do not delete pending records for delivered
mail until labeling is resolved.

Scheduled records created under the policy remember it; the agent lists and
cancels only those, never the owner's other schedules.

## Incoming replies

Replies are made visible by Proton's **sticky labels**: once a conversation has
the access label, Proton applies it to later incoming messages in that
conversation, such as replies to the agent's mail. Turn it on once per account
in Proton Mail: Settings → All settings → Messages and composing → **Sticky
labels**. It applies only to conversations started after it is enabled, and in
testing it did not label a reply the account sent to itself. Without it, replies
stay hidden until labeled.

Proton groups conversations by its own threading, so anyone who replies in a
labeled conversation can reach the agent; treat inbound content as untrusted.
Removing the label from a conversation stops new messages there from becoming
visible. Proton filters can also apply the label to mail matching rules.

## Verification

Automated tests cover scope bypasses, UID reuse, revocation during reads and
between calls, scoped moves and label changes, filtered metadata, durable
labeling retries, drafts, missing labels, alternate senders, tool
visibility, and settings validation.

Verified against Proton Bridge 3.27.1 (2026-11-11, isolated test account): every
message carries `X-Pm-Internal-Id`, identical across Inbox, All Mail, and the
label; COPY into `Labels/<name>` applies the label without duplicating the
message; archive, trash, and restore keep the label; and, through the MCP server,
every item below, including an outside reply labeled by sticky labels and a
server restart during a Bridge outage (labeled once, never resent). Bridge lists All Mail without the `\All` flag.

To re-verify, for example after a Bridge upgrade, use an isolated test account:

1. An unlabeled message and attachment cannot be read by tool, resource,
   prompt, thread, search, or cache path, even with a colliding Inbox UID.
2. Manually labeling an existing message makes it discoverable without a
   restart; removing the label hides it again, including previously read mail.
3. Direct send, reply, forward, alternate sender, scheduled delivery, and a saved
   draft each appear under the access label, without duplicate deliveries.
4. A Bridge interruption or daemon restart after SMTP acceptance resumes
   labeling without resending; removing the label after completion stays revoked.
5. With sticky labels on, a reply to agent mail becomes visible; an unrelated
   message stays hidden.
6. Archiving and trashing approved mail keeps it visible in Archive/Trash.

Bridge retains broad access to decrypted mail; this setting restricts what the
MCP exposes. Quoted text and attachments within a labeled message are authorized
with that message.
