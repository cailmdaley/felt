# The inbox — internals

An inbox holds text waiting for a worker on the host that owns its address.
An address is a fiber, named by its key, or a session, named by its `shuttle://<host>/<harness>/<id>` address.
This page describes the stored entry, the one function that creates entries, and the CLI verbs over it.

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
Delivery bookkeeping (`attempt_address`, `possible_repeat`, and `fallback` on Claude entries) is written into the same file by the readers.

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

## Verbs

| Command | Does |
|---|---|
| `shuttle inbox put <address> <message-id> <text>` | `Enqueue`, with `--source`, `--turn`, `--session`, `--if-costly`, `--not-before`, `--from` and `--derived`. Silent on success, including a deduplicated no-op in a fiber inbox |
| `shuttle inbox pending <address>...` | One JSON object, address → pending count. An address whose inbox can't be read is named on stderr and left out |
| `shuttle inbox ls <address>` | The address's pending entries, oldest first: id, source, turn, `not_before` (`-` when absent), queued time and sender. `--json` prints the same as an array of objects with `id`, `source`, `turn`, `not_before`, `queued_at` and `from` |

The verbs act on this host's inbox only.
The daemon-internal `shuttle context-mailbox put` and `pending` share their code with `inbox put` and `pending`; `context-mailbox put` has no wish flags and reads `--wake` as `turn: force`.
`shuttle inbox` with no subcommand is the speaker's held-lines inbox ([CLI reference](../reference/cli.md)).
