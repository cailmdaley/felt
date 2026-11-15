# The inbox — internals

An inbox holds text waiting for a worker on the host that owns its address.
An address is a fiber or a session.
A fiber's host-local key is its felt store path and uid (id when it has no uid), joined by a colon, as in `/home/me/loom:01ARZ3NDEKTSV4RRFFQ69G5FAV`.
`Shuttle.Delivery.context_key/1` builds it.
A session's address is `shuttle://<host>/<harness>/<id>`.
Any other string names an inbox of its own: `shuttle inbox put` accepts it, and nothing reads it.

## The store

Each address has one directory under the data directory:

- a fiber key `K` lives at `mailboxes/fiber/<sha256(K)>/`;
- a session lives at `mailboxes/<harness>/<sha256(id)>/`.

`pending/<sha256(message id)>.json` holds entries no worker has taken.
`offered/` holds entries with a final disposition for 14 days.
`.lock` serializes writers, hooks and the consumer, including transport emission.
A Claude session also has `fallback/`, where native-wake recovery claims a session entry.
A fiber has `destination.json`, its worker-owned conversation and receiver epoch, and `batches/<batch_id>.json`, one manifest per open wake batch with its durable payload.
A manifest lets recovery finish a claim or close interrupted between member-file writes.

## The entry

```json
{
  "request": {"text": "…", "from": "life/vizier", "message_id": "m-1"},
  "wishes": {"source": "message", "turn": "ask", "session": "any", "if_costly": "hold", "not_before": "2026-11-15T09:00:00Z"},
  "queued_at": 1763190000000000000
}
```

`request` is the publication as `messaging.Request` defines it: id, text, sender, attachments, reply and idle-notification fields, thread signal and retention stamp.
`queued_at` is Unix nanoseconds.
Readers also write `attempt`, `attempt_address` and `possible_repeat`, and `fallback` on Claude session entries.

### Delivery wishes

| Wish | Values | Meaning |
|---|---|---|
| `source` | `message`, `human`, `voice`, `thread`, `pulse`, `notice` | What produced the entry |
| `turn` | `none`, `idle`, `ask`, `force` | Context only; a turn only in a worker observed idle; a turn that cost may hold; or an unconditional wake. Any but `none` starts a session for a fiber with no worker when its gate allows |
| `session` | `any`, `fresh`, `previous` | Recorded session preference; the consumer does not act on it |
| `if_costly` | `hold`, `fresh` | Hold context or request a fresh session instead of waking a large, cold session |
| `not_before` | RFC 3339 time, or absent | When readers may first take it |

Fiber readers select from `turn`, not the request's wake fields.
`Enqueue` also sets `request.wake` for `force`, so a reader that does not understand wishes can still wake for it.
For a Claude session's `ask`, it sets `context_if_busy`: the hook takes context, with a native wake after 30 seconds without an offer.
Other session `ask` entries and all session `none` entries are context.
Session inboxes refuse `force` and `idle` with `wake_required`.
The fiber consumer has no native-wake timer.

An entry without wishes reads as the wishes its request implies.
`turn` comes from `idle_only`, then `context_if_busy`, then `wake`, else `none`.
The id prefixes `thread-`, `pulse-`, `voice-` and `claude-mail-failure-` imply sources `thread`, `pulse`, `voice` and `notice`; other ids imply `message`.
`session` defaults to `any`, and `if_costly` to `fresh` for thread results and `hold` otherwise.

## Enqueue

`messaging.Enqueue(env, InboxEntry{Address, Request, Wishes, Derived})` is the only function that creates entries.
The session hook queue, `context-mailbox put` and `inbox put` call it.
It requires a message id, text of at most 64 KiB (nonempty for a fiber), valid wish values and an RFC 3339 `not_before` when supplied.
It fills unsaid wishes and sets the request's compatibility wake fields.

A session entry requires a supported harness and live local hook registration.
An already-pending id is an error; an offered id can be queued again.
A thread notice beyond the 14-day retention is refused with `expired`.

For a fiber, enqueue takes the inbox lock and deduplicates across pending and offered entries.
The same id and publication is a successful no-op when the wishes also match.
Address, wake fields and retention stamp do not count as publication content, and `turn` counts only when the caller states it.
Different content is `message_id_conflict`, except for a `Derived` publication: the stored entry wins whatever the second capture contains.
A thread notice beyond retention stores nothing.
A supplied thread signal requires uid, verb, stamp and owner.
Either kind of inbox refuses a 129th pending entry with `queue_full`.

## Readers

Every reader skips entries whose `not_before` is in the future.
`PendingCount` includes them; `OverdueFiberContext` measures age from the later of `queued_at` and `not_before`.
Session native-wake recovery starts its 30-second hook window at that same later time.

### The live fiber consumer

`messaging.Consume` takes the inbox lock and verifies the worker's conversation and receiver epoch.
It first advances every open batch on its own, so a batch awaiting its outcome holds only its own members.
It then decides from the due entries no open batch holds without checking thread lifecycle currency; only a reservation or a wake checks it, decides again over the current entries, and selects and claims a new batch before sending it.
The daemon supplies `Idle`, `Unknown` and `Costly`.
It first consumes without them; only an answer with `"turn": true` (a due entry asks for a turn) makes it read the worker's turn state and wake cost and consume again.
A worker is busy while a turn of its own is running, and idle when its turn ended with no task of its own pending or in progress.
An idle worker is consumed with `Idle`, and `Costly` when waking it is costly.
A worker whose turn ended with a task still open, or whose turn no hook has reported, is consumed with `Unknown` (`--unknown`) and no cost check: it is woken for `ask` and `force`, and its `idle` entries wait for an observed idle, since an `idle` entry never interrupts.
A busy worker is left to its hook.
A tracked worker whose conversation is not yet known is consumed as `-` with its epoch, and waits.
`Delivery.context` stores waking context as `turn: ask` (`force` for `--wake`), with `if_costly` defaulting by source, whether or not the fiber has a worker.
`Threads.deliver_results` triggers the same consumer on each poll.

| Entries and worker | Action |
|---|---|
| Only `none` | Wait for a hook; a receiver without a hook registration, other than Codex, takes them as context |
| `ask`, busy or not observed idle | Wait for a hook, or the next idle consume |
| `idle`, busy or not observed idle | Wait; hook-offered only to a session launched for it |
| Any `force` | Wake regardless of cost or turn state |
| `ask`/`idle`, idle, not costly | Wake |
| `ask`/`idle`, idle, costly, any `if_costly: fresh`, no force | Reserve a fresh launch and return `fresh` |
| `ask`/`idle`, idle, costly, only `hold` | Wait; `ask` remains hook-eligible |
| `ask`/`idle`/`force`, no worker | Reserve a launch and return `launch`, when the fiber passes the gate below |

A fresh reservation is written on its entries and leased for two minutes.
Within the lease, consume answers `wait` for the reserving receiver while it stays costly, and a new receiver (the launched session) takes the entries through its hook instead of a wake.
The daemon starts the session; when the Poller refuses the launch, it consumes again without `Costly`, waking the live worker.
A launch that never arrives, including one a busy Poller accepted and later refused, is asked for again once the lease passes.

### A fiber with no worker

The daemon consumes a fiber with no worker as `shuttle inbox consume <fiber-key> - 0`.
A due entry that asks for a turn (`ask`, `idle` or `force`), when no launch reservation is in its lease, makes it reserve those entries and answer `launch` with them as `members`; otherwise it answers `wait`, with `"launching": true` while a reservation's lease stands.
The reservation is the fresh one's: an attempt with `launch: true`, conversation `-` and epoch 0, leased for two minutes, so repeated consumes ask for one launch per lease.
Quiet entries are not reserved, and open batches wait for the next receiver.

Only an armed fiber may be started by an entry that is not the human's (`Delivery.inbox_gate/2`): a constitution this host owns with `status: active`, not at rest (`horizon: stashed`), and not a standing constitution whose scheduled run is due, since that run takes the entries.
Arming is the author's authorization, which a message or a thread result does not grant: a draft, a constitution at rest, a paused schedule and a closed constitution keep their entries for whoever arms or starts them next.
An outstanding `ask` does not matter; an armed oneshot with one is also dispatched by the Poller on its own, and its worker takes the entries.
The Poller then admits the launch (`Poller.admit_inbox_launch/2`) when nothing is tracked for the fiber, no reconciliation hold is on and the host has a free worker slot.
While the boot quarantine or a contract skew holds fresh launches, it parks the fiber in `pending_launch`, drawn as held, without reserving anything, and the poll after the hold comes off starts it.
Admitted, the daemon consumes, and on `launch` calls `Poller.dispatch_fiber/3` with `force`, `ad_hoc`, `inbox: true` and `resume_mode: "continue"`: the dispatcher's resume-or-fresh rule, with the gate checked again on a fresh read so a fiber closed meanwhile is never reopened.
The launch prompt says messages are arriving and carries none of their text.

The launched session takes the batch through its fiber hook.
A fiber hook may take any entry, `idle` and `force` included, that a launch reservation from another receiver holds in its lease, and a receiver's link to the fiber inbox is written when it becomes the receiver, so a Claude session, whose conversation is known at launch, finds the batch at its first prompt.
That hook claim is the delivery: an entry is delivered when the session takes it, never when its terminal started.
A fresh Codex or Pi conversation becomes the receiver only once the daemon has captured it from the transcript the harness writes, usually after its first prompt: Codex then takes the batch at its next tool call, and Pi, whose hook offers only at a prompt, is woken with it once the lease passes.
A session that dies before taking the batch, a launch the Poller refuses or holds after the reservation, or a lease that lapses leaves the entries pending, and the next consume of the fiber with no worker reserves them again.
While a lease stands, a live worker other than the reserving one leaves the reserved entries to its hook; once it passes, they are consumed as any other.

Each poll consumes every live worker's inbox and asks one `shuttle inbox pending --waking` call about every gated-in fiber with no worker.
It counts the due entries that ask for a turn and that no open batch holds, and counts none while a launch reservation is in its lease; a fiber with a count is started as above.
This catches an entry that became due by `not_before` or outlived a daemon restart.
An enqueue through `Delivery.context` starts its fiber at once.

A session started for messages on an armed standing constitution is an ad-hoc run with an `inbox-` run id.
It starts only while no occurrence is due, and its own end, a handoff or a concluded exit, is not service: an occurrence that elapsed while it ran still fires after it ends.
A temper, rest or re-arm of that run counts as usual.

A receiver without a hook registration takes `none` entries directly, in a batch sent as context without a turn (`action: context`) whenever consume would otherwise wait.
Codex leaves them to its fiber hook, and Claude without a registration is unavailable.

A wake is one message, oldest first, up to 16 entries and the harness's byte limit, with at most one thread lifecycle signal.
It includes pending `none` entries and turn-asking entries; busy-worker `idle` entries remain excluded even when force triggers a batch.
A batch of one carries its member's own sender header; a larger batch is sent from `shuttle` with each member's header inside.
Oversized publications use a retained JSON file reference instead of truncation.
The size budget reserves 512 bytes for framing and a possible-repeat warning.
Thread lifecycle currency is checked before emission; an unverifiable publication waits and a superseded one moves to offered without emission.

### Hooks

A fiber hook offers only `none` and `ask` entries that are not pinned and that no open batch's manifest holds, and any entry a launch reservation from another receiver holds in its lease.
It never takes other `idle` or `force` entries.
It uses the same inbox lock, the 16-entry and one-lifecycle-signal limits and the harness's byte limit; its budget counts each emission's possible-repeat warning but reserves nothing for framing.
A hook takes context from the fiber inbox itself, so replacing the worker does not strand a session-scoped copy.

## Attempts and the claim

Each selected entry carries the same attempt record:

```json
"attempt": {"batch_id": "<sha256>", "conversation": "shuttle://host/claude/A", "epoch": 3, "members": ["m-1", "m-2"], "opened_at": 1763190000000000000}
```

`batch_id` hashes sorted member ids joined by NUL; `members` keeps emission order.
`epoch` is the receiver's epoch at the claim, or zero for a session inbox.
`outcome` is absent while open, then `delivered`, `released` or `ambiguous`.
`retry` counts the single bounded retry to that conversation.

A wake attempt also stores `payload` (the exact request and transport id), `base_text` and `variant`.
The transport id is a bounded, domain-separated hash of members, conversation and exact text variant.
Plain text, a live retry, a possible-repeat warning and a staleness caveat cannot change text under one transport id.
The batch's manifest stores that complete record before any member is pinned or any message is sent.
Recovery repairs partial member writes and replays that same payload, even when new entries arrive.
A partial close can replay the same payload against the transport's `messages/` receipt without injecting it again.
Before a superseded member can change an open batch, the payload's `messages/` record decides: a confirmed receipt closes the batch `delivered`; no record or a rejection drops the superseded member and releases the rest; any other record closes it `ambiguous`.

A wake claim writes `attempt_address` beside the attempt, pinning it to that conversation.
A confirmed receipt closes the batch `delivered` and moves its pending members to offered.
An unconfirmed send leaves it pinned and open.
A clean rejection releases it; any earlier unknown send remains recorded as possible-repeat evidence.
When a pinned conversation ends, or stays unknown for five minutes after another receiver replaces it, the batch rolls forward with a possible-repeat warning.
When it is still the receiver, five minutes of unknown outcome permit one warning-marked retry under a distinct transport id.
Exhausting that retry does not prevent later roll-forward to another receiver.
Approval-held messages (`wake_held`) are not retried.

An entry pinned without a manifest is an open batch of one, including one read from `attempt_address` alone; its five-minute wait starts when the consumer first reads it.
Without a stored payload it keeps the transport id it was sent under.
Its staleness-caveat variant is reconstructed from the stored transport receipt's content hash.
Retries and roll-forwards use hashed transport identities.
Quiet context pinned this way is released to a Codex receiver's fiber hook rather than sent.

A hook claim is unpinned.
If a hook leaves its attempt open, the next reader under the inbox lock, a hook or the consumer, closes it ambiguous, and the entry carries “Possible repeat” wherever it goes next.
A launch reservation, fresh or for a fiber with no worker, is also unpinned, but has `launch: true`: it requests no emission and is not evidence of a possible repeat.
Unpinned claims and delivered closes preserve the entry's modification time, from which offered retention runs.
The session-only Claude fallback claims by moving an entry into `fallback/` and writes no attempt.

## Verbs

| Command | Does |
|---|---|
| `shuttle inbox put <address> <message-id> <text>` | Enqueue, with `--source`, `--turn`, `--session`, `--if-costly`, `--not-before`, `--from` and `--derived`; silent on success |
| `shuttle inbox pending <address>... [--waking]` | JSON address → pending count, or with `--waking` the count a launch would be for; unreadable addresses are named on stderr and omitted |
| `shuttle inbox ls <address>` | Pending entries oldest first; `--json` includes wishes, queued time, sender and open attempt |
| `shuttle inbox consume <fiber-key> <address-or-dash> <epoch> [--idle] [--unknown] [--costly]` | Consume for the current receiver, or with `-` and epoch 0 for a fiber with no worker; one JSON object with `action` (`wait`, `wake`, `context`, `fresh`, `launch`), the `members` sent or reserved, and `turn` when an entry asks for a turn the worker's facts would decide. The answer is printed even when an open batch's send fails, which exits nonzero |

All verbs act on this host's inbox only.
`context-mailbox put` also accepts thread signals, reply and notification fields, `--turn` and `--derived`; its `--wake` means `turn: force`.
`context-mailbox deliver` is consume without turn facts: only force initiates a wake, ask remains hook context, and a receiver without a hook takes `none` entries as context.
`context-mailbox pending` shares the inbox counting code.
`shuttle inbox` with no subcommand is the speaker's held-lines inbox ([CLI reference](../reference/cli.md)).
