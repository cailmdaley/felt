# The inbox — internals

An inbox holds text waiting for a worker on the host that owns its address.
An address is a fiber or a session.
A fiber's host-local key is its felt store path and uid (id when it has no uid), joined by a colon, as in `/home/me/loom:01ARZ3NDEKTSV4RRFFQ69G5FAV`.
`Shuttle.Delivery.context_key/1` builds it.
A session's address is `shuttle://<host>/<harness>/<id>`.
The address `threads` is the host's routing inbox ([below](#thread-results-and-routing)).
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
A routing inbox entry also carries `routing`, its publication's routing record, and the `disposition` it settled with, written before it moves to offered.

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
A busy fiber's Claude `ask` remains hook-eligible for 30 seconds, then consume uses its native wake; the daemon schedules a consume at that deadline and also consumes on polls.

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
Either kind of inbox refuses a 129th pending entry with `queue_full`, except the routing inbox, which retention bounds.

## Messages and human lines

`shuttle message <fiber>` sends to the owner's `/deliver` and enqueues before consumption, whether a worker is live or dormant.
Plain sends ask for a turn, `--wake` forces one and `--context-only` never starts one.
Attachments are retained under the owner's `message-files/`; the entry contains file references rather than binary frames.
A plain agent `/deliver` does the same, minting an id when the caller supplies none.
The owner clears the fiber's outstanding ask when an entry from a sender other than `shuttle` reaches its inbox, including a remote sender.
Session-addressed messages and idle and mail-failure notices keep their direct transports and `messages/` receipts.
Voice (`live_input`) and explicit `message_after_launch` requests use their session delivery paths.

`/deliver` adds `consumed` for a live worker: the consumer's `action`, `members`, `followup` and `held: cost`, and `message`, this message's state after the pass (`consume --message`): `delivered`, `sent` (its outcome not yet confirmed), `reserved` for a launch, `pending`, or `unknown` when the inbox no longer holds it as delivered (it expired, which consume records on the offered entry as disposition `expired`, or was never stored), which `/deliver` answers as `queued` with `delivered: null`.
The status describes this message, not whatever else the pass sent: `woken`, `followed_up`, `delivered` (as context, or before a retry), `held`, `starting` or `queued`, which the CLI prints.
`delivered` is true once the message is delivered, null when it was sent and its outcome is unconfirmed, and false while it waits or a session starts for it.
An enqueue reply is not a promise that the model read the text.
The owner's put, consumes and any launch share a 35-second budget, each command limited to 32 seconds, so it answers inside a routing hub's 40-second forward and the CLI's 52-second `/deliver` timeout; clearing the ask runs beside them.
A timeout leaves the entry durable; retry the same id.

`--notify-when-idle` subscribes when a wake or a hook claim delivers the entry, using its publication id, so a repeated claim does not start another watcher.
`--fresh` is not an inbox entry. The sender's `/deliver` (`resume_mode: fresh`, its message id, its text) makes the owner write a record of it straight to the inbox's `offered/`, as a human line is (below), so no worker is ever offered its text, and then ask the Poller for a fresh session with the text in its launch prompt, headed `From <sender>:`. The new session is told where the previous conversation is.
That launch is an inbox launch, so the agent gate holds it: a closed, resting or unarmed fiber, a due scheduled run, the boot quarantine, a full host, or a launch breaker or cooldown refuses it, and it never reopens or arms a fiber.
A refusal answers 409 with its `reason` and an `error` that names it, and settles the record undeliverable, so the same id may be sent again once that changes; nothing about it waits in the inbox, and a later message to the fiber never carries its text.
A launch answers 200 with `delivered: true` and settles the record delivered; a Poller that does not answer in time answers 202 with `delivered: null` and leaves it unknown.
A repeated id starts nothing and answers the stored outcome: `delivered: true` for a started session, `delivered: null` for an unknown one, and `duplicate: true`.
A contract-41 CLI sends the same request and reads these answers as it always has: started, launch unconfirmed, or an error with the reason.
The human's fresh board action keeps forced-start authority.

Channels replies, the Dock's send and review lines, and `/dispatch user_message` record the line first, as a `source: human` record (`Shuttle.InboxRecord`).
The board keeps one `message_id` per composed message: a retry after a failed send reuses it, and a new message, or the same text after a send went through, gets a new one. The owner mints one for callers without it, such as `shuttle dispatch --message`.
Images are written to disk and represented as `[Image: path]` lines before recording.
The owner writes the record straight to the inbox's `offered/`, disposition unknown, under the inbox lock, so no reader ever offers it.
Only the call that writes the record may transport the line: typed terminal paste to a live worker, or the From User launch prompt to a dormant one.
Writing the record also writes the line's one family-board row, `brd-<id>`, whichever harness the worker runs: `answered` (`Q: … — A: …`) when the fiber has a question, else `human`; a repeated id writes none.
Typed input leaves the worker's question to its prompt hook, which clears it and writes its row under the same identity, replacing the owner's: the hook takes the identity of a human record with the same text written to one of its session's fiber inboxes within the last hour. A line typed in the terminal has no such record and gets the hook's own row.
A From User launch clears the question as any human start does, without a row of its own (`ask --clear --no-board`).
The record is settled delivered on paste or launch success, undeliverable on a definite refusal, and unknown on an ambiguous paste or a queued launch whose outcome is not known.
Since it is unknown before the side effect, a daemon that dies before reporting the outcome never sends the line again, even if it died before typing.
A line over the inbox's 64 KiB limit is transported whole and recorded cut short, as a thread result is.
A repeated id does nothing, including for `existing_only` review input, unless its record was settled undeliverable: that line never reached the worker, so it is transported again.
Otherwise it answers `duplicate: true` with the record's `disposition`, and `/deliver`'s `delivered` is true only for `delivered`.
The board reports such a repeat as sent only when it was delivered; for `unknown` (a daemon that died between recording and typing the line leaves it so) it tells the human the line may not have arrived, keeps it, and sends it again under a new id, as a new message, if they choose.

### Contract 42 and rollback

Contract 42 adds consume's `--busy` and `--message`, followup/held/message answers, `context-mailbox put --attachments-stdin`, and `inbox record-begin/record-settle`.
The CLI uses these message semantics only when both its own daemon, which forwards only the fields it knows, and the owner answer `/version` at 42, asked live on each send with a 5-second limit; otherwise it uses the older wire, which a 42 owner still accepts.
An owner below 42 receives the session-routing `unless_live` envelope; attachment sends retain session routing there.
`--fresh` sends one request to every owner; one below 42 starts the session with forced-start authority and no record.
An older CLI can still send `unless_live` to a 42 owner: a live worker answers 409 so it follows the session path.
Existing inbox entries and open delivery batches remain readable across deployment, and session traffic in flight retains its receipts.

Rolling a host back to 41 leaves inbox text and attempts on disk, but its consumer does not follow up busy Codex or Pi workers.
Records already in offered remain, but a 41 daemon does not use them to deduplicate: retrying a board line there can paste twice, and retrying a `--fresh` id starts another session, with forced-start authority.
Rolling forward resumes the recorded inbox state.

### Pulses and contract 43

A pulse keeps its clock, busy-worker skips, cost-independent wake, window rollover and Claude completion reservation in `pulses.json` and `Shuttle.Pulse`.
Its delivery is an offered inbox record, source `pulse`, sender `shuttle`, identified by the pulse key and reserved `next_tick`, not the send clock.
The daemon records before sending and settles from the transport outcome; an unknown record is not sent again.
A tick for a dormant worker carries its text in the launch prompt.
Pulse transport uses `message --recorded`, without a `messages/` receipt.
Contract 43 adds that flag and `inbox record-begin --source`.

## Thread results and routing

A thread's owner captures its close, ask, handoff, rest and verdict publications, and its unblock notes, into the host's routing inbox: the inbox at address `threads`, holding every thread publication this host captured and has not yet placed.
There is no thread publication queue outside the inbox.
Each poll's delivery task captures in one `shuttle inbox thread-put` call, made even when it has nothing to capture, after skipping signals older than the 14-day retention window; the Poller itself shells nothing for threads, and a failed capture is logged and repeated by the next poll.
`thread-put` tries every publication and reports the ones the inbox refused, such as a close whose text is over 64 KiB; the daemon logs each refusal, and one refused publication never stops the rest.
The producer keeps its exact lifecycle-derived ids.
A re-capture finds the id pending or offered in the routing inbox and stores nothing, so the first capture fixes the publication and its wishes even when a later poll renders an edited outcome.
`Enqueue` stores a routing entry only when its stamp is after the capture baseline (`mailboxes/threads.json`, below) and, like every inbox entry, at most 14 days old.
An unblock note carries its board line, which its entry stores and owes until the line is appended: every `thread-put` call, after capturing, appends each line the routing inbox's entries owe, pending or offered, then records it in the entry.
The line appended is the board record the first capture stored, never a later poll's rendering, and its board id is `brd-<publication id>`, so a repeat after an append whose record was lost replaces the line rather than adding one.
A failed append, or a `thread-put` killed between creating the entry and appending, leaves the line owed, and the next poll appends it, whether or not its thread still waits on the blocker; routing never waits for the append.
Recording the append keeps the entry's modification time, so an offered entry still expires 14 days after it settles, and a line it still owes then expires with it.

An entry's `routing` record names its recipient fiber by `parent_uid`, marked `parent_unresolved` until the daemon resolves it, or, for an asker notice, the asking `session`.
Each poll lists the routing inbox once (`inbox routes`) and advances every entry with `inbox route`, passing the signal's fresh lifecycle currency and, once it resolves, the recipient the daemon read from authoritative documents: past an archived parent, never guessed from a slug.
The daemon decides whether it owns the recipient, against the host identity it froze at boot, and passes the recipient's inbox key only then; the CLI forwards a resolved recipient without one.
The key and the stored `store` name the store that physically holds the recipient, the one the Poller inventories it under and its worker reads, even when the daemon read it through another store's symlinked view; a recipient no configured store holds stays unresolved.
A superseded or expired entry settles without a handoff.
An unresolved recipient or an unknown currency waits, without holding up other entries.
The first resolution is stored in the entry, even while currency is unknown; later facts may change the recipient's host and store but never its uid, so moving the child does not redirect the result.

A current result for a fiber this host owns is placed: `inbox route` enqueues it as an ordinary entry in the recipient's inbox, with the publication's text, signal and wishes, and then settles it `placed`.
The daemon consumes the recipient's inbox as soon as the CLI answers `placed`, before it routes the next entry, so a slow handoff later in the listing never delays a local wake.
A repeated placement is a dedup no-op, and a recipient inbox that refuses it (`queue_full`) leaves it pending for the next poll.
A placed entry is ordinary: it does not follow a parent that later moves host or store.
For a fiber another host owns, `inbox route` answers `forward` with the entry's record, and the daemon posts its `context_only`, `wake`, `message_id`, `thread_signal` and `retained_at` envelope to the owner's `/api/v1/deliver`, addressed by the stored uid.
Only a 202 answer with `delivery: context` and `queued: true` lets `inbox settle` record `forwarded`.
An unreachable owner, an ambiguous reply or a lost confirmation leaves the entry pending, and the next poll repeats the same enqueue, which the owner's derived-id dedup makes a no-op.
The owner stores the result as an ordinary derived entry, which its live-worker and dormant-fiber consumers below take.

Only a close or ask requested by the orchestrator's own worker asks that fiber for a turn (`turn: ask`, `if_costly: fresh`).
Such a result is consumed like any `ask` entry: a busy Codex or Pi orchestrator gets it in its turn as a terminal follow-up or steering, and a busy Claude orchestrator through its hook or, after 30 seconds without an offer, a native wake.
When waking an idle orchestrator is costly, its fresh session is an inbox launch under the gate (`inbox_replace`): the boot quarantine, a full host, or a closed, resting or unarmed orchestrator refuses it, and the orchestrator is woken instead, whatever the cost.
That session's launch prompt names the previous session and its cost, and says to read Status first, then `shuttle show` the previous session for what it holds that Status does not.
Results nobody asked for and unblock notes are quiet context.
When a different session asked, capture also writes that session an asker notice, id `<id>-asker`, into the routing inbox.
A waking result keeps its asking fiber and session (`asked_by`); when `inbox route` resolves the recipient past that fiber, as past an archived asking parent, it stores the asker notice and turns the result quiet before it places or forwards it.
`inbox route` answers `session` for a current notice, and the daemon sends it through the waking session transport, with `wake` and `context_if_busy`, under the notice's own id.
An unknown outcome leaves it for the next poll, across restarts; a known one settles it `delivered`, or `undeliverable` on a refusal, since the orchestrator's inbox holds the same result.

`pending_results` counts a fiber's inbox entries no worker has taken plus the routing entries, from the poll's one listing, that routing left waiting with that fiber's `parent_uid`.

### Boot import and compatibility

The Poller's first boot step, `inbox thread-state`, establishes the capture baseline in `mailboxes/threads.json`, which holds the baseline alone and never changes it.
A host without an outbox establishes its baseline once; signals at or before it never backfill.
An entry settles after its signal is stamped, and its offered entry expires 14 days after it settles; by then `Enqueue`'s 14-day window on the signal's stamp refuses a re-capture, so the signal cannot publish again.
A `threads.json` an earlier build wrote with a `retention_cutoff` field reads as its baseline; an older daemon's `thread-outbox/retention_cutoff` is not imported.

The same step imports the `thread-outbox/` directory a contract-40 daemon left, under `thread-import.lock` in the data directory.
Pending records become routing inbox entries with their recipients; acknowledgments become payload-free offered entries (`acknowledged`) that dedup a re-capture.
An acknowledgment's file name is the hash of its publication's id, which is the routing inbox's key for it, so the import takes acknowledgments from their names and never reads them: an unreadable ack imports, and a name that is not 64 hex characters (an `acked/*.tmp` left by a hard-killed older daemon, an NFS `.nfs*` silly-rename, `.DS_Store`) is ignored.
An acknowledgment wins over a pending copy of its id, including a copy an interrupted import left, and the import touches no recipient's inbox.
The importer reads the source without changing it, enqueues idempotently, then renames the directory to `thread-outbox.imported` before deleting it, so a crash at any point repeats safely.
A pending record whose text is over 64 KiB, which the older daemon's outbox took, imports cut short as capture cuts a long outcome, keeping its id, stamp, recipient and wishes.
A pending record the routing inbox can never accept (`invalid_request`, such as a malformed signal) is reported as `skipped`, which the daemon logs, and the rest import.
Stamps are read as the older daemon's capture read them (ISO 8601 with a `T` or space separator and a `Z`, `+01:00`, `+0100` or `+01` offset) and kept as written, since currency compares them verbatim; a record with no stamp, which would never expire, or one that cannot be read is skipped.
A cleanup failure is reported as `cleanup_error`, which the daemon logs; boot goes on, and the next boot removes what is left.
A malformed baseline, a pending payload that cannot be parsed, or a malformed state exits 3 (`Shuttle.Inbox.Corrupt`) and holds boot without discarding anything; restore the exact trusted baseline from backup rather than setting it to the current time.
Any other failure, a timeout included, retries the boot step.

Contract 41 adds `inbox thread-state`, `thread-put`, `routes`, `route` and `settle`.
The `/deliver` wire envelope is unchanged, so contract-40 and contract-41 daemons forward results to each other in both directions, and a repeated forward is a no-op on either.
The import is not a reversible migration.
A daemon rolled back to contract 40 never reads the routing inbox: results bound for another host, unresolved or not yet current, and asker notices, wait there until the host rolls forward.
Placed entries are ordinary inbox entries, which contract 40 consumes as usual; no routing entry sits in a worker's inbox.
The rolled-back daemon finds no outbox and starts a new one with its boot time as baseline, so a signal stamped between the contract-41 daemon's last poll and that boot is not published while it runs.
Rolling forward keeps the inbox's earlier baseline and imports what contract 40 captured: what either daemon published dedups, through the routing inbox's offered entries or the imported acknowledgments, and a still-current signal from that gap is published then.

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
A busy worker is consumed again with `--busy`: Codex gets its terminal follow-up, Pi its steering, and Claude gets a hook window followed by its native wake.
A tracked worker whose conversation is not yet known is consumed as `-` with its epoch, and waits.
`Delivery.context` stores waking context as `turn: ask` (`force` for `--wake`), with `if_costly` defaulting by source, whether or not the fiber has a worker.
`Threads.deliver_results` triggers the same consumer on each poll.

| Entries and worker | Action |
|---|---|
| Only `none` | Wait for a hook; a receiver without a hook registration, other than Codex, takes them as context |
| `ask`, busy | Codex terminal follow-up; Pi steering; Claude hook, then native wake after 30 s or once its turn ends |
| `ask`, not observed idle | Wake without a cost check |
| `idle`, busy or not observed idle | Wait; hook-offered only to a session launched for it |
| Any `force` | Wake regardless of cost or turn state, skipping the hook |
| `ask`/`idle`, idle, not costly | Wake |
| `ask`/`idle`, idle, costly, any `if_costly: fresh`, no force | Reserve a fresh launch and return `fresh` |
| `ask`/`idle`, idle, costly, only `hold` | Wait; `ask` remains hook-eligible |
| `ask`/`idle`/`force`, no worker | Reserve a launch and return `launch`, when the fiber passes the gate below |

A launch reservation is kept apart from the entries' delivery attempts, in the inbox's `launch.json`: the reserving receiver (`-` and epoch 0 for a fiber with no worker), the asking entries it was requested for, and when, leased for two minutes.
Reserving a launch never rewrites an entry's attempt or a batch's pinned payload.
Within the lease, consume answers `wait` for a cost-based reservation's reserving receiver while it stays costly, and a new receiver (the launched session) takes the reserved entries through its hook instead of a wake.
The daemon starts the session; when the Poller refuses the launch, it consumes again without `Costly`, waking the live worker.
A launch that never arrives, including one a busy Poller accepted and later refused, is asked for again once the lease passes.

### A fiber with no worker

The daemon consumes a fiber with no worker as `shuttle inbox consume <fiber-key> - 0`.
A due entry that asks for a turn (`ask`, `idle` or `force`), whether free or held by an open batch, makes it reserve a launch for those entries and answer `launch` with them as `members`, unless a reservation in its lease still owes any pending entry; then it answers `wait` with `"launching": true`.
Repeated consumes therefore ask for one launch per lease, and once the launched session has taken every reserved entry a new one may ask for another.
Quiet entries are not reserved.
An open batch is not sent anywhere without a receiver, but its local records are settled first, as the batch rules below settle them: a recorded confirmed receipt for its pinned payload closes it delivered, and a superseded thread result drops it, releasing or holding the rest.
A batch whose currency could not be checked waits for a later consume, as a free entry does.
A batch left unresolved and current that asks for a turn asks for a launch: a batch pinned to a conversation that ended before its outcome was known starts a replacement, whose consume then resolves it by the batch rules below (the pinned payload is offered to the ended conversation under its transport id, then rolled forward to the replacement, marked as a possible repeat when the outcome stayed unknown).

Only an armed fiber may be started by an entry that is not the human's (`Delivery.inbox_gate/2`): a constitution this host owns with `status: active`, not at rest (`horizon: stashed`), and not a standing constitution whose scheduled run is due, since that run takes the entries.
Arming is the author's authorization, which a message or a thread result does not grant: a draft, a constitution at rest, a paused schedule and a closed constitution keep their entries for whoever arms or starts them next.
An outstanding `ask` does not matter; an armed oneshot with one is also dispatched by the Poller on its own, and its worker takes the entries.
The Poller then admits the launch (`Poller.admit_inbox_launch/2`) when nothing is tracked for the fiber, no reconciliation hold is on, the host has a free worker slot, and neither the resume-loop breaker nor a launch-refusal cooldown that holds the fiber's autonomous dispatch is open, so a message never keeps relaunching a crash-looping worker; the receipt's detail names which one holds it.
Unlike a human's start, an inbox launch leaves the breaker's count as it was, so a retry after its cooldown that dies at once reopens it, and a short standing run started for messages counts as a oneshot's rapid exit when it failed its messages: it ended without a clean handoff, or with an entry that asks for a turn, queued before it started, still pending. A run that took its messages and handed off ends the sequence and clears the breaker, however short it was.
While the boot quarantine or a contract skew holds fresh launches, it parks the fiber in `pending_launch`, drawn as held, without reserving anything, and the poll after the hold comes off starts it.
Admitted, the daemon consumes, and on `launch` calls `Poller.dispatch_fiber/3` with `ad_hoc`, `inbox: true` and `resume_mode: "continue"` (the dispatcher's resume-or-fresh rule).
An inbox launch is not a forced start: it arms and reopens nothing, leaves the worker's question for the human, and needs the gate on the Poller's final read of the fiber and again on the dispatcher's own, so a fiber closed or put to rest meanwhile is refused, never reopened.
A refusal on the document's policy (closed, at rest, unarmed, a scheduled run due) is a wait wherever it is found, and is never recorded as a failed launch, so it opens no launch cooldown.
The launch prompt says messages are arriving and carries none of their text.

The launched session takes the batch through its fiber hook.
A fiber hook may take any entry, `idle` and `force` included, that a launch another receiver reserved holds in its lease, and a receiver's link to the fiber inbox is written when it becomes the receiver.
A Claude session's conversation is known at launch, and it becomes the receiver when the daemon records the launch, a moment after its terminal starts and usually before Claude submits its first prompt, whose hook then takes the batch.
Nothing holds that first prompt back, though: a hook that runs before the session is the receiver takes nothing and leaves the batch pending, for the session's first tool call or next prompt, or, once the lease passes, a wake that sends it as a message.
That hook claim is the delivery: an entry is delivered when the session takes it, never when its terminal started.
A fresh Codex or Pi conversation becomes the receiver only once the daemon has captured it from the transcript the harness writes, usually after its first prompt: Codex then takes the batch at its next tool call, and Pi, whose hook offers only at a prompt, is woken with it once the lease passes.
A session that dies before taking the batch, a launch the Poller refuses or holds after the reservation, or a lease that lapses leaves the entries pending, and the next consume of the fiber with no worker reserves them again.
While a lease stands, a live worker other than the reserving one leaves the reserved entries to its hook; once it passes, they are consumed as any other.

Each poll consumes every live worker's inbox and asks one `shuttle inbox pending --waking` call about every gated-in fiber with no worker.
It counts the due entries that ask for a turn, free or held by an open batch, and counts none while a reservation in its lease still owes one; a fiber with a count is started as above.
The count reads files only, so it includes held batches that a confirmed receipt or a superseded thread result has already resolved; the consume that follows settles them and answers `wait`, and the next poll counts none.
Under the boot quarantine that consume does not run, so a fiber with only such a batch is drawn as held until the hold comes off, and then settles without a launch.
This catches an entry that became due by `not_before` or outlived a daemon restart.
An enqueue through `Delivery.context` starts its fiber at once.

A session started for messages on an armed standing constitution is an ad-hoc run with an `inbox-` run id.
It starts only while no occurrence is due, and its own end, a handoff or a concluded exit, is not service: an occurrence that elapsed while it ran still fires after it ends.
A temper, rest or re-arm of that run counts as usual.
A daemon rolled back below contract 40 reads such a run's end as service, so an occurrence that elapsed while it ran is skipped once, and a CLI rolled back below contract 40 does not read `launch.json`, so within a live lease it may answer `fresh` again and a second forced-fresh start kills the first replacement.

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
A launch reservation is no attempt: it lives in `launch.json`, requests no emission and is not evidence of a possible repeat.
A contract-39 CLI wrote its reservation into the reserved entries' attempts (`launch: true`); the first reader under the inbox lock, a consume or a hook, moves the newest such record to `launch.json` with its receiver, epoch, members and opening time, and clears it from the entries.
Unpinned claims and delivered closes preserve the entry's modification time, from which offered retention runs.
The session-only Claude fallback claims by moving an entry into `fallback/` and writes no attempt.

## Verbs

| Command | Does |
|---|---|
| `shuttle inbox put <address> <message-id> <text>` | Enqueue, with `--source`, `--turn`, `--session`, `--if-costly`, `--not-before`, `--from` and `--derived`; silent on success |
| `shuttle inbox pending <address>... [--waking]` | JSON address → pending count, or with `--waking` the count a launch would be for; unreadable addresses are named on stderr and omitted |
| `shuttle inbox ls <address>` | Pending entries oldest first; `--json` includes wishes, queued time, sender and open attempt |
| `shuttle inbox consume <fiber-key> <address-or-dash> <epoch> [--idle] [--unknown] [--busy] [--costly] [--message <id>]` | Consume for the current receiver, or with `-` and epoch 0 for a fiber with no worker; one JSON object with `action` (`wait`, `wake`, `context`, `fresh`, `launch`), the `members` sent or reserved, `turn` when an entry asks for a turn the worker's facts would decide, and with `--message` that entry's state after the pass (`message`: `delivered`, `sent`, `reserved`, `pending` or `unknown`). The answer is printed even when an open batch's send fails, which exits nonzero |
| `shuttle inbox thread-state` | Establish the thread capture window and import an older daemon's thread outbox; print `baseline` and any `skipped` records and `cleanup_error`, or exit 3 on a corrupt outbox or state |
| `shuttle inbox thread-put` | Capture a JSON array of `{id, record, board}` publications from stdin into the routing inbox, storing a `board` record in that entry, then append every board line the routing inbox's entries owe, from the stored record; print `{"created": [ids], "refused": [{id, error}], "board_errors": [{id, error}]}`, trying every publication |
| `shuttle inbox routes` | List the routing inbox's pending publications as `{id, record}` |
| `shuttle inbox route <id> --current true\|false\|unknown [--record <json> [--key <key>]]` | Advance one routing entry from the daemon's fresh facts: the resolved recipient's `record`, and its inbox `key` when the daemon owns it; print `action`: `wait`, `forward` or `session` with the entry's `record`, or the disposition it recorded (`placed`, `superseded`, `expired`) |
| `shuttle inbox settle <id> forwarded\|delivered\|undeliverable` | Record a routing entry's confirmed handoff and move it to offered |

`shuttle inbox record-begin [--from <sender>] [--fiber <uid> [--ask <question>]] <fiber-key> <id>` records a line the daemon transports itself (typed human input, the default sender, or an agent's fresh request), read from stdin, and with `--fiber` writes a human line's board row, and prints `{"created": true|false, "disposition": "unknown"|"delivered"|"undeliverable"}`: only the call that created it may transport it, and a repeat gets the stored disposition.
`shuttle inbox record-settle <fiber-key> <id> delivered|unknown|undeliverable` records its transport outcome.
All verbs act on this host's inbox only.
`context-mailbox put` also accepts thread signals, reply and notification fields, `--turn`, `--derived` and `--attachments-stdin` (a JSON attachment array); its `--wake` means `turn: force`.
`context-mailbox deliver` is consume without turn facts: only force initiates a wake, ask remains hook context, and a receiver without a hook takes `none` entries as context.
`context-mailbox pending` shares the inbox counting code.
`shuttle inbox` with no subcommand is the speaker's held-lines inbox ([CLI reference](../reference/cli.md)).
