# The inbox — internals

An inbox holds text waiting for a worker on the host that owns its address.
An address is a fiber or a session.
A fiber's address is its key: the path of the felt store that holds it and its uid (its id when it has no uid), joined by a colon, as in `/home/me/loom:01ARZ3NDEKTSV4RRFFQ69G5FAV`; the daemon builds it in `Shuttle.Delivery.context_key/1` and passes it to every `context-mailbox` verb.
A session's address is `shuttle://<host>/<harness>/<id>`.
Any other string names an inbox of its own: `shuttle inbox put` accepts it, and nothing reads it.
This page describes the stored entry, the one function that creates entries, the attempt record and claim by which readers take entries, and the CLI verbs over it.

## The store

Each address has one directory under the data directory:

- a fiber key `K` lives at `mailboxes/fiber/<sha256(K)>/`;
- a session `shuttle://<host>/<harness>/<id>` lives at `mailboxes/<harness>/<sha256(id)>/`.

Inside it, `pending/<sha256(message id)>.json` holds entries no worker has taken, `offered/` holds entries that reached a final disposition (kept 14 days), and `.lock` serializes writers and offers.
A Claude session's inbox also has `fallback/`, where the native-wake fallback claims an entry it is delivering.
A fiber's inbox has `destination.json`, the record of which conversation is its worker and at which epoch.

## The entry

An entry is one JSON file:

```json
{
  "request": {"address": "", "text": "…", "from": "life/vizier", "wake": false, "context_if_busy": true, "message_id": "m-1"},
  "wishes": {"source": "message", "turn": "ask", "session": "any", "if_costly": "hold", "not_before": "2026-11-15T09:00:00Z"},
  "queued_at": 1763190000000000000
}
```

`request` is the message as `messaging.Request` defines it: id, text, sender, reply and idle-notification fields, thread signal and retention stamp.
`queued_at` is Unix nanoseconds.
Readers write delivery bookkeeping into the same file: `attempt`, `attempt_address` and `possible_repeat` ([Attempts and the claim](#attempts-and-the-claim)), and `fallback` on Claude entries.

### Delivery wishes

`wishes` records how the entry wants to reach its worker:

| Wish | Values | Records |
|---|---|---|
| `source` | `message`, `human`, `voice`, `thread`, `pulse`, `notice` | What produced the entry |
| `turn` | `none`, `idle`, `ask`, `force` | Whether the entry wants a turn: none, only when the worker is idle, one that a costly wake may hold, or one regardless |
| `session` | `any`, `fresh`, `previous` | Which session should take it |
| `if_costly` | `hold`, `fresh` | What to do instead of waking a large session whose cache is cold |
| `not_before` | an RFC 3339 time, or absent | When readers may first offer or deliver it |

Readers act on `not_before` and on the request's wake fields; `inbox ls` shows the wishes, and nothing else reads `turn`, `session` or `if_costly`.
`Enqueue` sets only the wake fields that the inbox's readers already act on:

| Inbox | `turn` | Request fields | Delivered as |
|---|---|---|---|
| fiber | `force` | `wake` | a turn in the fiber's worker |
| fiber | `none`, `idle`, `ask` | none | context |
| Claude session | `ask` | `context_if_busy` | context, with a native wake if no hook offers it within 30 seconds |
| any session | `none`; `ask` outside Claude | none | context |
| any session | `force`, `idle` | refused with `wake_required` | |

A build that predates wishes reads the same wake fields and ignores the wishes, so it delivers an entry with a future `not_before` at once.

An entry without `wishes` reads as the wishes its request implies: `turn` from those fields (`idle_only`, then `context_if_busy`, then `wake`, else `none`), `source` from its id (`thread-`, `pulse-`, `voice-` and `claude-mail-failure-` prefixes name `thread`, `pulse`, `voice` and `notice`; anything else is `message`), `session` `any`, and `if_costly` `fresh` for a thread result and `hold` otherwise.

## Enqueue

`messaging.Enqueue(env, InboxEntry{Address, Request, Wishes, Derived})` is the only function that creates an entry.
The session hook path (`queueMailbox`), `shuttle context-mailbox put` and `shuttle inbox put` all call it.

It first:

1. Refuses an entry without a message id, with text over 64 KiB, or, for a fiber, with no text.
2. Fills unsaid wishes from the request as above and refuses an unknown value for any wish or a `not_before` that is not RFC 3339.
3. Sets the request's wake fields from `turn` as in the table above.

For a session, it then refuses a harness without a message hook, a session without a live hook registration on this host, a `turn` of `force` or `idle` (`wake_required`), and a thread notice older than the 14-day retention (`expired`), and writes `pending/<sha256(id)>.json` exclusively: an id already pending is an error, and an id already offered is queued again.

For a fiber, it takes the inbox lock and then:

1. Deduplicates by message id across `pending/` and `offered/`. An id already there is a successful no-op when the entry matches: the same text, sender, attachments, reply and notification fields and thread signal (the address, wake fields and retention stamp don't count), and the same wishes, where `turn` counts only when the caller stated it. When it differs, the result depends on `Derived`: a derived entry, whose id Shuttle minted from the event it reports, is a no-op and the stored entry wins; any other entry is a `message_id_conflict` error. Dedup lasts as long as `offered/` keeps the entry, 14 days.
2. Stores nothing for a thread notice older than the 14-day retention.
3. Refuses a thread signal missing its uid, verb, stamp or owner.
4. Writes `pending/<sha256(id)>.json` exclusively.

Either way, an inbox with 128 entries pending refuses another with `queue_full`.

## Readers

Every reader that selects pending entries for offer or delivery skips one whose `not_before` is in the future:

- the hook offer (`OfferMailbox`, including a session's linked fiber context);
- the daemon's direct fiber delivery (`DeliverFiberContext`);
- the Claude native-wake fallback (`RecoverClaudeMail`), whose 30-second hook window starts at `not_before` when that is later than `queued_at`.

`OverdueFiberContext`, which `shuttle doctor` reports, measures an entry's age from the later of `queued_at` and `not_before`.
`PendingCount` counts every pending entry, delayed ones included, because they still wait for a worker.

## Attempts and the claim

A reader takes pending entries by claiming them, under the inbox's `.lock` and before any side effect: `claimBatch` writes the same `attempt` into every entry of the batch.
The lock is what keeps two readers from taking one entry; the claim records which batch and conversation took it.

```json
"attempt": {"batch_id": "<sha256>", "conversation": "shuttle://host/claude/A", "epoch": 3, "members": ["m-1", "m-2"], "opened_at": 1763190000000000000}
```

| Field | Records |
|---|---|
| `batch_id` | The SHA-256 of the batch's member ids, sorted and joined by NUL, so claiming the same batch again gives the same id |
| `conversation` | The session the batch is going to |
| `epoch` | The fiber receiver's epoch (`destination.json`) when `conversation` was the receiver at the claim; absent otherwise, as in a session inbox |
| `members` | The batch's message ids, oldest first |
| `opened_at` | When it was claimed, in Unix nanoseconds |
| `outcome` | Absent while the attempt is open; then `delivered`, `released` or `ambiguous` |
| `retry` | How many sends direct delivery made to `conversation` after an earlier one stayed unknown; absent before the first. A retry's transport id is the entry's message id with `-retry-<n>` before the address suffix, so the conversation's stored receipt for the earlier send is not replayed. A later claim for the same conversation keeps the count |

Claiming the same batch for the same conversation and epoch while its attempt is open keeps that attempt as it was opened, so a reader that died after its claim and is retried finds the batch id it first wrote.
The claim is a field in the pending file, not a move, so a build that predates it still sees the entry as pending.

Both readers that select entries claim through it:

- **The hook offer** claims its batch (up to 16 entries and the harness's size limit, at most one thread lifecycle signal) for the hook's own session, emits it, then closes it `delivered`.
  Its attempt is not pinned: a hook that dies after its claim leaves the entry pending with an open attempt, and the next hook or direct delivery that selects it claims it again.
- **Direct fiber delivery** (`DeliverFiberContext`) claims each entry on its own, a batch of one, and pins it: the claim also writes `attempt_address`, and the entry is sent to that conversation, with the same transport id, until the attempt closes.

`closeAttempts` closes an attempt with what the transport reported:

| Outcome | The entry |
|---|---|
| `delivered` | moves to `offered/` with its attempt and the modification time it had pending, from which the 14-day retention runs; `attempt_address` is left as it was |
| `released` | stays pending, unpinned: `attempt_address` is cleared. Direct delivery releases an entry its conversation rejected, and quiet Codex context it hands back to the fiber hook |
| `ambiguous` | stays pending, unpinned, with `possible_repeat` set, so its next direct emission starts "Possible repeat" |

An unconfirmed direct send leaves its attempt open and pinned, and the next delivery replays the conversation's stored receipt instead of sending again.
When the pinned conversation rejects the entry, has ended with the outcome unknown, or is no longer the fiber's receiver and has left it unknown for five minutes since `opened_at`, direct delivery closes that attempt (`released` or `ambiguous`) and claims the entry for the fiber's current receiver in one write.
When the pinned conversation is still the receiver and has left the outcome unknown for five minutes, the open attempt counts a `retry` and restarts `opened_at`, also in one write, and the entry is sent again under the retry's transport id, starting "Possible repeat". That does not set `possible_repeat`, so a build that predates `attempt` reads the entry as pinned and replays the first send's receipt.
The five minutes are checked when a delivery runs, which the daemon does on each poll. A send held for the receiver's approval (`wake_held`) is not retried.
The dedup layer keeps one receipt per transport id and refuses different text under it, so each text a conversation can be sent has its own id: the plain text and the `possible_repeat` warning go to different conversations under the entry's id, and a retry has its own.
A conversation gets one retry: an attempt with `retry` set stays open and pinned while its conversation is the receiver, however long its outcome stays unknown.
An attempt read from `attempt_address` alone has no `opened_at`; its five minutes start when direct delivery first sees its outcome unknown.
An unpinned claim, like a delivered close, keeps the file's modification time; a pinned claim and every other close write it afresh.

Hosts upgrade at different times, so `attempt_address` and `possible_repeat` are written beside `attempt` wherever a pinned attempt is opened or closed, and a build that predates `attempt` acts on them.
That build drops `attempt` from any entry it rewrites, and an `attempt_address` with no attempt record for that address reads as an open attempt of that one entry to that address.
Which reader may select an entry is decided before the claim, by each reader's own rule: in a fiber inbox a hook offers only entries that do not ask for a wake and are not pinned, and direct delivery takes an entry that asks for a wake, a pinned one, and any entry when the receiver has no hook.
The Claude native-wake fallback claims an entry by moving it into `fallback/`, under the same lock, and writes no attempt.

## Verbs

| Command | Does |
|---|---|
| `shuttle inbox put <address> <message-id> <text>` | `Enqueue`, with `--source`, `--turn`, `--session`, `--if-costly`, `--not-before`, `--from` and `--derived`. Silent on success, including a deduplicated no-op in a fiber inbox |
| `shuttle inbox pending <address>...` | One JSON object, address → pending count. An address whose inbox can't be read is named on stderr and left out |
| `shuttle inbox ls <address>` | The address's pending entries, oldest first: id, source, turn, `not_before` (`-` when absent), queued time and sender. `--json` prints the same as an array of objects with `id`, `source`, `turn`, `not_before`, `queued_at`, `from`, and `attempt` when the entry has an open attempt |

The verbs act on this host's inbox only.
The daemon-internal `shuttle context-mailbox put` and `pending` share their code with `inbox put` and `pending`; `context-mailbox put` has no wish flags and reads `--wake` as `turn: force`.
`shuttle inbox` with no subcommand is the speaker's held-lines inbox ([CLI reference](../reference/cli.md)).
