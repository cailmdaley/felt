# The inbox — internals

An inbox holds text waiting for a worker on the host that owns its address.
An address is a fiber or a session.
A fiber's host-local key is `fiber:` and its uid, as in `fiber:01ARZ3NDEKTSV4RRFFQ69G5FAV`; it names no store, so a fiber's inbox, scheduled check-ins included, stays where it is when its tree moves to another store.
A fiber without a uid is keyed by its felt store path and id, joined by a colon.
At boot, before it recovers any worker, the daemon runs `shuttle inbox rekey` over its stores: an inbox still keyed `<store>:<uid>` under any of them moves to `fiber:<uid>`, with the session links that name it; when several exist for one fiber, the one whose receiver was written last becomes the inbox and the others add what it lacks: entries whose id it holds neither pending nor offered, open batches, and a receiver written later than its own. A store that is no longer configured, or is spelled by another path, is not searched.
`Shuttle.Delivery.context_key/1` builds it.
A session's address is `shuttle://<host>/<harness>/<id>`.
The address `threads` is the host's routing inbox ([below](#thread-results-and-routing)).
Any other string names an inbox of its own: `shuttle inbox put` accepts it, and nothing reads it.

## The delivery guarantee

An *entry* is a message an inbox holds in `pending/` until a worker takes it.
A worker takes entries in one of two ways: its *hook* (the harness hook Shuttle installs, which adds pending entries to the conversation as context at a prompt or tool call) emits them, or the *consumer* (`shuttle inbox consume`, which the daemon runs) sends them to the conversation as one message, a *batch*.
Each batch has a *manifest* in `batches/` naming its entries and the conversation it went to ([Batches and the claim](#batches-and-the-claim)).
An entry is *delivered* when its transport confirms the batch or a hook emits it; neither proves that the model read it.

A message to a fiber, a thread result and a delayed message are entries, delivered exactly once, with a possible repeat always marked.
The entry, with the manifest of the batch that holds it, is the source of truth across a daemon, CLI or worker death: it stays pending until it is delivered, so a death drops nothing.
Only a cancel, a superseded thread result or retention (a thread result or notice, 14 days after its stamp) settles an entry undelivered.
A death, or a receiver that never confirms, can leave a send whose outcome is unknown; the inbox then sends the entry again, once more to the same conversation or on to the one that replaces it, and every such repeat opens with “Possible repeat”.
Its id makes a second enqueue a no-op while the entry is pending and while `offered/` keeps it, which is 14 days from the entry's last write while pending.

Lines the daemon transports itself are at most once: the human's typed and spoken lines, a pulse tick and an agent's `--fresh` request.
Each is recorded in the fiber's inbox before its one transport, and only the call that created the record transports it; a record left `unknown` is never transported again.
A record settled `undeliverable` never reached a worker, and its id may be transported again, unless it was spoken.
A pulse tick is also guarded by its clock, which the daemon moves past the tick before sending it.

A message to a session address is not an entry when it asks for a turn: it goes once to the session's own transport (Claude's native socket, Codex's terminal, Pi's native inbox), and its sender's receipt says what that transport answered.
A repeat of its id answers that receipt without sending again, unless the first send was refused before anything was written.
Two session messages are entries, in the session's own inbox, which only that session's hook reads: a quiet one (`--context-only`), and an ordinary ask to an idle Claude session that is costly to wake, which the owner holds as context (receipt `queued` on `claude-hook`).
Nothing wakes the session for either: its hook offers them at its next prompt or tool call, and a session that ends first never sees them.

The fourteen outside-in tests `daemon/test/shuttle/dispatch_integration_inbox_*_test.exs` pin this guarantee with the real CLI and hooks, most of them against a daemon that dies at the worst moment:
`message` (a fiber message enqueued before its owner dies is delivered once), `cross_host` (the same, forwarded to another owner), `delayed` (a delayed message, once and not before its time), `launch_death` (the message whose launch its owner died starting), `roll_forward` (a batch whose conversation ended unanswered is carried once, marked, to its replacement), `thread` and `thread_waking` (quiet and waking thread results), `notify_idle` (a notify-only subscription is no entry), `human`, `voice`, `fresh` and `pulse` (a line, spoken line, fresh request or tick its owner died transporting is never transported again), and `session` and `session_busy` (a session message is sent once under its receipt, and a busy Claude session's ask goes to its native socket, never its inbox).

## The store

Each address has one directory under the data directory:

- a fiber key `K` lives at `mailboxes/fiber/<sha256(K)>/`;
- a session lives at `mailboxes/<harness>/<sha256(id)>/`.

`pending/<sha256(message id)>.json` holds entries no worker has taken.
`offered/` holds entries with a final disposition for 14 days.
`.lock` serializes writers, hooks and the consumer, including transport emission.
`batches/` holds one manifest per open batch, the batch's one claim record: `<batch_id>.json` for a consumer's batch, `<batch_id>.hook` for a hook's claim ([below](#batches-and-the-claim)).
A fiber has `destination.json`, its worker-owned conversation and receiver epoch.

## The entry

```json
{
  "request": {"text": "…", "from": "life/vizier", "message_id": "m-1"},
  "wishes": {"source": "message", "turn": "ask", "if_costly": "hold", "not_before": "2026-11-15T09:00:00Z"},
  "queued_at": 1763190000000000000
}
```

`request` is the publication as `messaging.Request` defines it: id, text, sender, attachments, reply and idle-notification fields, thread signal and retention stamp.
`queued_at` is Unix nanoseconds.
Readers also write `possible_repeat` when an entry settles back to pending after a batch that may have delivered it.
A routing inbox entry also carries `routing`, its publication's routing record, and the `disposition` it settled with, written before it moves to offered.

### Delivery wishes

| Wish | Values | Meaning |
|---|---|---|
| `source` | `message`, `human`, `voice`, `thread`, `pulse` | What produced the entry |
| `turn` | `none`, `idle`, `ask`, `force` | Context only; a turn only in a worker observed idle; a turn that cost may hold; or an unconditional wake. Any but `none` starts a session for a fiber with no worker when its gate allows |
| `if_costly` | `hold`, `fresh` | Hold context or request a fresh session instead of waking a large, cold session |
| `not_before` | RFC 3339 time, or absent | When readers may first take it |

Readers select from `turn`; the request's wake fields decide nothing for an entry that has wishes.
Session entries are context for the session's hook.
Session inboxes refuse `ask`, `force` and `idle` with `wake_required`: a session's turn comes from its own transport, never its inbox.
A busy fiber's Claude `ask` is hook-eligible for 30 seconds, then consume wakes the worker natively; the daemon schedules a consume at that deadline and also consumes on polls.

An entry without wishes reads as the wishes its request implies.
`turn` comes from `idle_only`, then `context_if_busy`, then `wake`, else `none`.
The id prefixes `thread-`, `pulse-` and `voice-` imply sources `thread`, `pulse` and `voice`; other ids imply `message`.
`if_costly` defaults to `fresh` for thread results and `hold` otherwise.

## Enqueue

`messaging.Enqueue(env, InboxEntry{Address, Request, Wishes, Derived})` is the only function that creates entries.
The session hook queue, `context-mailbox put` and `inbox put` call it.
It requires a message id, text of at most 64 KiB (nonempty for a fiber), valid wish values and an RFC 3339 `not_before` when supplied.
It fills unsaid wishes and clears the request's wake fields, setting `wake` only for a fiber entry's `force`.

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
The owner clears the fiber's outstanding ask when a due entry from a sender other than `shuttle` reaches its inbox, including a remote sender.
A future entry clears nothing.
Session-addressed messages, idle notices included, go to the session's own transport under a receipt in the data directory's `messages/`.
A session message that asks for a turn goes to the session's native transport whatever its turn state: a busy Claude session's native inbox queues it behind the running turn, which takes it in at its next model call or, if none comes, runs it as the next turn, and a held, refused or failed send answers its sender in the receipt.
The one exception is an ordinary ask (not `--wake`) to a Claude session that has ended its turn and is costly to wake: the owner sends it as context instead, an entry in the session's inbox for its next hook, and the receipt's detail says what a wake would cost.
A receipt is created exclusively before the side effect, as a reservation carrying a random nonce that tells a network filesystem's replayed link from a competing sender, and completed with the transport's answer after it.
A repeat of the id answers the receipt as recorded; a reservation without an answer, whether its send is still running or stopped mid-delivery, answers `ambiguous_delivery` at once and is never sent again; and different content under the id is `message_id_conflict`.
A transport that refused before writing anything (`preflight_failed`) releases its reservation, so a retry sends.
Voice (`live_input`) uses human records and typed input.

`/deliver` adds `consumed` for a live worker: the consumer's `action`, `members`, `followup` and `held: cost`, and `message`, this message's state after the pass (`consume --message`): `delivered`, `sent` (its outcome not yet confirmed), `reserved` for a launch, `pending`, or `unknown` when the inbox no longer holds it as delivered (it expired, which consume records on the offered entry as disposition `expired`, or was never stored), which `/deliver` answers as `queued` with `delivered: null`.
The status describes this message, not whatever else the pass sent: `woken`, `followed_up`, `delivered` (as context, or before a retry), `held`, `starting` or `queued`, which the CLI prints.
`delivered` is true once the message is delivered, null when it was sent and its outcome is unconfirmed, and false while it waits or a session starts for it.
A consume that fails for the live worker, such as a Claude receiver whose hook is not registered yet (every Claude worker's first seconds) or whose process is gone, answers `queued` with `delivered: null` and a `detail` saying the inbox holds the message for its worker and why the live worker could not be handed it now: the entry stays pending for that worker's hook or the next worker. `delivered` is null rather than false because the put does not report whether the id was already stored, and a repeated id may already have been delivered.
An enqueue reply is not a promise that the model read the text.
The owner's put, consumes and any launch share a 35-second budget, each command limited to 32 seconds, so it answers inside a routing hub's 40-second forward and the CLI's 52-second `/deliver` timeout; clearing the ask runs beside them.
A timeout leaves the entry durable; retry the same id.

`--notify-when-idle` subscribes when a wake or a hook claim delivers the entry, using its publication id, so a repeated claim does not start another watcher.
With no text it is no entry: `/deliver` subscribes the fiber's live worker (`Poller.context_receiver`) through a session send with no text, and a fiber with no live worker answers 409.
`--fresh` is not an inbox entry. The sender's `/deliver` (`resume_mode: fresh`, its message id, its text) makes the owner write a record of it straight to the inbox's `offered/`, as a human line is (below), so no worker is ever offered its text, and then ask the Poller for a fresh session with the text in its launch prompt, headed `From <sender>:`. The new session is told where the previous conversation is.
That launch is an inbox launch, so the agent gate holds it: a closed, resting or unarmed fiber, a due scheduled run, the boot quarantine, a full host, or a launch breaker or cooldown refuses it, and it never reopens or arms a fiber.
A refusal answers 409 with its `reason` and an `error` that names it, and settles the record undeliverable, so the same id may be sent again once that changes; nothing about it waits in the inbox, and a later message to the fiber never carries its text.
A launch answers 200 with `delivered: true` and settles the record delivered; a Poller that does not answer in time answers 202 with `delivered: null` and leaves it unknown.
A repeated id starts nothing and answers the stored outcome: `delivered: true` for a started session, `delivered: null` for an unknown one, and `duplicate: true`.
The human's fresh board action has forced-start authority.

### The human's lines

Channels replies, the Dock's send and review lines, and `/dispatch user_message` record the line first, as a `source: human` record (`Shuttle.InboxRecord`).
`/dispatch` with `user_message` and `/deliver` with `from: human` are one implementation, `Shuttle.Delivery.human/3`; `/dispatch` adds its own launch options (`force`, `existing_only`, `project_dir`, images) and, without `resume_mode`, lets the dispatcher choose, where `/deliver` lets the worker's state choose.
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

### Voice and pulses

A spoken batch is a human line with source `voice` and the relay's stable `voice-…` id, forwarded to the owner's `/deliver` as `live_input`.
It has the human's forced-start authority, including through quarantine, and reaches the frozen fiber's current worker as typed input, or a dormant conversation's From User launch prompt.
The record writes the batch's one `human` or `answered` family-board row; `HumanRecordFor` matches voice as well as human records, so the prompt hook replaces that row instead of adding another.
A voice record is never re-pasted under its id, even when settled undeliverable.
The relay (`Shuttle.Voice.TranscriptRelay`) keeps ingestion checkpoints, buffers and frozen batches in per-fiber/origin order; whether a batch was delivered is the owner's record alone, and the relay writes no record of its own.
Recovery repeats the record handoff under the same id; the owner's record, not the relay, decides whether it may paste.
The relay finishes a batch after one attempt, even without a 2xx or when its delivery task crashes: it removes the batch and records the outcome as its last, so nothing queues behind it.

A pulse keeps its clock, busy-worker skips, cost-independent wake, window rollover and Claude completion reservation in `pulses.json` and `Shuttle.Pulse`.
Its delivery is an offered inbox record, source `pulse`, sender `shuttle`, identified by the pulse key and reserved `next_tick`, not the send clock.
The daemon records before sending and settles from the transport outcome; an unknown record is not sent again.
A tick for a dormant worker carries its text in the launch prompt.
Pulse transport uses `message --recorded`, which writes no `messages/` receipt: the record deduplicates it.

## Delayed messages

`shuttle message [<fiber>] "check the fit converged" --in 8h` schedules a check-in that outlives the sending session.
With only the text, the command finds the sender's own fiber through the same worker identity as `close` and `handoff`; a session with no fiber must name one.
`--in` accepts Go durations and `d` for 24-hour days, such as `90m`, `8h` and `2d`.
`--at` accepts RFC 3339, `YYYY-MM-DD HH:MM` in the sender's local zone, or `HH:MM` for its next occurrence in that zone.
An explicit instant not in the future is refused.
The flags are mutually exclusive.

The CLI resolves the instant once per run to UTC RFC 3339 and prints it with the message id before sending.
A retry that must name the same publication passes both: `--message-id <id> --at <that UTC instant>`.
Repeating `--in 8h` resolves a new instant, which the owner refuses as a `message_id_conflict` that points at `--at`.
A delayed retry of an id the owner has already delivered or cancelled is refused as `already_settled`, naming which.
The receipt says `scheduled` and prints the sender-local time and UTC.
`--wake` requests `turn: force`, `--context-only` requests `turn: none`, and the default requests `turn: ask` with `if_costly: fresh`.
A large, cold idle session therefore gets a gated fresh replacement rather than holding a reminder indefinitely as context; when that replacement is refused, the existing worker is woken regardless of cost.
`--attach` and `--notify-when-idle` retain their ordinary behavior; the idle subscription begins only when the entry is delivered.
`--fresh` is refused with a delay because a fresh request records and launches rather than queues.
Delayed messages accept fiber addresses only: a session inbox has no delayed-message consumer, and a reminder should follow the work.

The `not_before` wish passes through `/api/v1/deliver` to the owner's `Enqueue`.
A future entry causes no ask clear, family-board message row, launch reservation, consumption, transport emission or idle subscription at enqueue.
Every poll consumes live workers and scans dormant fibers with `inbox pending --waking`, whose count excludes future entries.
The first poll at or after the instant applies the ordinary consumer rule.
Staleness age starts at the later of `queued_at` and `not_before`, not when the reminder was written.
Retention expires only thread notices, which are never delayed.

The table describes a due default (`ask`) reminder, from `Delivery.flush_owned`, `Delivery.inbox_gate`, `Poller.inbox_admission` and `Consume`.
A `force` reminder skips cost and hook windows; a `none` reminder waits as context and never starts a worker.

| State when due | Behavior |
|---|---|
| Live worker busy | Codex terminal follow-up; Pi steering; Claude hook, then native wake after its 30-second hook window or when its turn ends |
| Live idle, warm | Wake with the due batch |
| Live idle, large and cold | Reserve a fresh session under the agent gate; if refused, wake the existing worker instead of holding for cost |
| No worker, active oneshot | Start under the agent gate and capacity/breaker/cooldown admission; its hook takes the reserved batch |
| Rested (`open`, `horizon: stashed`) | Keep pending; never arm or reopen; waits for the author to arm or a worker to start |
| Draft | Keep pending until armed or a worker takes it |
| Closed | Keep pending; never reopen; waits for a later worker |
| Armed standing constitution between runs | Start an ad-hoc inbox run; this does not service a scheduled occurrence; a due occurrence takes the entry in its own run |
| Boot quarantine held | No new dormant launch or reservation; wait until release and the next poll; existing live workers still consume; a refused cold-cache replacement wakes its existing worker |
| Owner unreachable | Sending/listing/cancelling fails with the host named; an entry already accepted on that owner stays durable and is consumed when it returns, subject to quarantine |

`shuttle inbox ls <fiber> --scheduled` shows all pending entries with a `not_before`, including overdue ones, with time, sender, first text line and an overdue wait reason.
The reason is the one a `/deliver` receipt would give: the agent gate or launch admission refusal the next poll would meet, or the worker that has yet to take the entry.
Fiber ids, slugs and uids resolve through the owner to its host-local `fiber:<uid>` key, and a reference that names no fiber is an error; a raw key (`fiber:<uid>`, a store path and id, a `shuttle://` address or `threads`) reads this host.
`shuttle inbox cancel <fiber> <message-id>` marks a pending entry `cancelled` and moves it to `offered/`, under the inbox lock.
An entry an open batch holds is refused as `in_flight`: cancellation cannot retract text already emitted.
Both fiber-reference commands use the owner-routed `/api/v1/inbox` endpoint (`action: list|cancel`); an unreachable owner is an error, never an archive fallback.
The poll's one `inbox pending` call reports each owned fiber's due count and its scheduled entries; the owner feed carries the entries as `scheduled_messages`, and a future entry does not count as waiting for a worker.

## Thread results and routing

A thread's owner captures its close, ask, handoff, rest and verdict publications, and its unblock notes, into the host's routing inbox: the inbox at address `threads`, holding every thread publication this host captured and has not yet placed.
There is no thread publication queue outside the inbox.
Each poll's delivery task captures in one `shuttle inbox thread-put` call, made even when it has nothing to capture, after skipping signals older than the 14-day retention window; the Poller itself shells nothing for threads, and a failed capture is logged and repeated by the next poll.
`thread-put` tries every publication and reports the ones the inbox refused, such as a close whose text is over 64 KiB; the daemon logs each refusal, and one refused publication never stops the rest.
A publication's id is derived from its signal: the thread's uid, the verb and the stamp (an unblock note adds its blocker), never the store, so a thread whose tree moves to another store keeps its ids.
The daemon passes each publication's `aliases` too: the id that also names the store holding the thread, under which a routing inbox may hold the signal.
A re-capture finds the id or an alias pending or offered in the routing inbox and stores nothing, so the first capture fixes the publication and its wishes even when a later poll renders an edited outcome.
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
`inbox route` answers `session` for a current notice, and the daemon sends it through the waking session transport, with `wake` and `context_if_busy` (so a costly idle Claude asker holds it as context), under the notice's own id.
A refusal settles it `undeliverable`; any other answer the session transport recorded settles it `delivered`, an `unknown` one included, since sending the notice again under its id would only replay that record and the orchestrator's inbox holds the same result.
Only an unknown answer the daemon made itself (a 502 or 504: the CLI timed out, failed without a receipt, or a remote owner could not be reached) leaves it for the next poll, across restarts.

`pending_results` counts a fiber's inbox entries no worker has taken plus the routing entries, from the poll's one listing, that routing left waiting with that fiber's `parent_uid`.

### The capture baseline

The Poller's first boot step, `inbox thread-state`, establishes the capture baseline in `mailboxes/threads.json`, which holds the baseline alone and never changes it.
A host without a baseline records the current time once; signals at or before it never backfill.
An entry settles after its signal is stamped, and its offered entry expires 14 days after it settles; by then `Enqueue`'s 14-day window on the signal's stamp refuses a re-capture, so the signal cannot publish again.
A malformed state exits 3 (`Shuttle.Inbox.Corrupt`) and holds boot without discarding anything; restore the exact trusted baseline from backup rather than setting it to the current time.
Any other failure, a timeout included, retries the boot step.

## Readers

Every reader skips entries whose `not_before` is in the future.
`inbox pending` counts only due entries and lists the scheduled ones beside the count; `OverdueFiberContext` measures age from the later of `queued_at` and `not_before`.

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
| Only `none` | Wait for a hook |
| `ask`, busy | Codex terminal follow-up; Pi steering; Claude hook, then native wake after 30 s or once its turn ends |
| `ask`, not observed idle | Wake without a cost check |
| `idle`, busy or not observed idle | Wait; hook-offered only to a session launched for it |
| Any `force` | Wake regardless of cost or turn state, skipping the hook |
| `ask`/`idle`, idle, not costly | Wake |
| `ask`/`idle`, idle, costly, any `if_costly: fresh`, no force | Reserve a fresh launch and return `fresh` |
| `ask`, idle, costly, `hold`, due for an hour or more | Reserve a fresh launch and return `fresh` |
| `ask`/`idle`, idle, costly, only `hold` | Wait; `ask` remains hook-eligible |
| `ask`/`idle`/`force`, no worker | Reserve a launch and return `launch`, when the fiber passes the gate below |

A cost hold does not strand an `ask`: once it has been due for the escalation window (an hour; `SHUTTLE_COST_HOLD_ESCALATE_SEC` in the consumer's environment, when finite and nonnegative), it counts as `if_costly: fresh`, so it gets a fresh session when the gate allows and otherwise wakes the worker.
Its age runs from the later of `queued_at` and `not_before`, so a daemon restart does not reset it, and the poll's consume of every live worker is what notices it.
A `none` entry is never escalated, and an entry the worker's hook took in time is no longer pending.

A launch reservation is kept apart from the batches, in the inbox's `launch.json`: the reserving receiver (`-` and epoch 0 for a fiber with no worker), the asking entries it was requested for, and when, leased for two minutes.
Reserving a launch never rewrites a batch's manifest.
Within the lease, consume answers `wait` for a cost-based reservation's reserving receiver while it stays costly, and a new receiver (the launched session) takes the reserved entries through its hook instead of a wake.
The daemon starts the session; when the Poller refuses the launch, it consumes again without `Costly`, waking the live worker.
A launch that never arrives, including one a busy Poller accepted and later refused, is asked for again once the lease passes.

### A fiber with no worker

The daemon consumes a fiber with no worker as `shuttle inbox consume <fiber-key> - 0`.
A due entry that asks for a turn (`ask`, `idle` or `force`), whether free or held by an open batch, makes it reserve a launch for those entries and answer `launch` with them as `members`, unless a reservation in its lease still owes any pending entry; then it answers `wait` with `"launching": true`.
Repeated consumes therefore ask for one launch per lease, and once the launched session has taken every reserved entry a new one may ask for another.
Quiet entries are not reserved.
An open batch is not sent anywhere without a receiver, but what its own record decides is settled first, as the batch rules below settle it: a confirmed receipt, recorded or read from the conversation's transcript, closes it delivered, and a superseded thread result drops it, holding the rest as ambiguous.
A batch whose currency could not be checked waits for a later consume, as a free entry does.
A batch left unresolved and current that asks for a turn asks for a launch: a batch sent to a conversation that ended before its outcome was confirmed starts a replacement, whose consume then rolls it forward to the replacement, marked as a possible repeat, by the batch rules below.

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

For a receiver without a hook registration, consume sends `none` entries directly, in a batch sent as context without a turn (`action: context`), whenever it would otherwise wait.
Codex is left to its fiber hook, and Claude without a registration is unavailable; Pi, the remaining harness, refuses context without a wake (`wake_required`), which releases the batch, so its `none` entries wait for its hook too.

A wake is one message, oldest first, up to 16 entries and the harness's byte limit, with at most one thread lifecycle signal.
It includes pending `none` entries and turn-asking entries; busy-worker `idle` entries remain excluded even when force triggers a batch.
A batch of one carries its member's own sender header; a larger batch is sent from `shuttle` with each member's header inside.
Oversized publications use a retained JSON file reference instead of truncation.
The size budget reserves 512 bytes for framing and a possible-repeat warning.
Thread lifecycle currency is checked before emission; an unverifiable publication waits and a superseded one moves to offered without emission.

### Hooks

A fiber hook offers only `none` and `ask` entries that no open batch's manifest holds, and any entry a launch reservation from another receiver holds in its lease.
It never takes other `idle` or `force` entries.
It uses the same inbox lock, the 16-entry and one-lifecycle-signal limits and the harness's byte limit; its budget counts each emission's possible-repeat warning but reserves nothing for framing.
A hook takes context from the fiber inbox itself, so replacing the worker does not strand a session-scoped copy.

## Batches and the claim

A batch is claimed once, in its manifest, `batches/<batch_id>.json` (a hook's claim is `batches/<batch_id>.hook`):

```json
{"batch_id": "<sha256>", "conversation": "shuttle://host/claude/A", "epoch": 3, "members": ["m-1", "m-2"], "opened_at": 1763190000000000000,
 "payload": {"message_id": "batch-…", "text": "…", "wake": true}, "base_text": "…", "variant": "plain",
 "transcript_offset": 18233, "receipt": {"status": "queued", "transport": "claude-native"}, "error_code": ""}
```

An entry is pinned exactly while a manifest names it.
Member entries are rewritten only when they settle: a delivered member moves to `offered/` with the modification time it had pending, from which offered retention runs; a released or ambiguous one stays pending, marked `possible_repeat` when the batch may have reached a conversation (an ambiguous close, or the release of a retry or roll-forward), and carries “Possible repeat” wherever it goes next.

`batch_id` hashes sorted member ids joined by NUL; `members` keeps emission order.
`epoch` is the receiver's epoch at the claim, or zero for a session inbox.
`outcome` is absent while open, then `delivered`, `released` or `ambiguous`, recorded before the members settle, so a close interrupted midway finishes on the next pass.
`retry` counts the single bounded retry to that conversation.

The consumer's batch stores `payload` (the exact request, under its transport id), `base_text` and `variant`.
The transport id is a bounded, domain-separated hash of members, conversation and exact text variant.
Plain text, a live retry and a possible-repeat warning cannot change text under one transport id.
The consumer writes the manifest before the send, with `transcript_offset`, where a Claude or Pi conversation's transcript ends, and after the send records the transport's `receipt` and `error_code` in it.
The send writes no `messages/` receipt.
A manifest without a receipt is a send whose outcome is unknown, whether the consumer died before the send, during it or before recording it; its payload is never sent again.

A hook claims its emission with a manifest of its own, `<batch_id>.hook`, marked `hook`, with no payload, and removes it when it closes the batch delivered.
The next reader under the inbox lock, a hook or the consumer, live or dormant, closes a hook manifest it finds, since its hook died between output and close: by the outcome the manifest records, when that hook died mid-close, and otherwise ambiguous.
A launch reservation is no claim: it lives in `launch.json`, requests no emission and is not evidence of a possible repeat.
A hook claim in a session's mailbox is closed by that session's next hook.
One left by a session that has ended is inert: nothing that sends reads a session's mailbox; only `inbox ls` of that session shows it, and `inbox cancel` refuses its members as in flight.

Consume sends a new batch once.
A confirmed receipt (`accepted`, `context_added`, or a Codex terminal `submitted`) closes it delivered; a rejection releases it at once.
A receiver's refusal (Claude `wake_refused`, Pi `native_rejected`) is a rejection too: its members are free again, the receiver's hook may take those it offers, and the next pass that would wake for them sends them in a new batch, which that receiver may refuse again.
Any other answer leaves it open.
Each later pass advances an open batch from its record alone, never sending its payload again:

| The batch's record | Consume for the live worker W |
|---|---|
| `outcome` recorded | Finish the close |
| Confirmed receipt, or one the conversation's transcript now confirms | Close it delivered, subscribing the idle notices its members asked for |
| A thread member superseded | Move that member to offered and close the batch ambiguous |
| Unconfirmed, sent to W | Keep waiting; one retry, warning-marked, under its own transport id, five minutes after the send for an `unknown` outcome or thirty for a `queued` or `submitted` one |
| Unconfirmed, sent to W but held for approval (`wake_held`) | Wait for as long as W lives; no retry |
| Unconfirmed, sent to a conversation that has ended | Roll forward to W at once, warning-marked |
| Unconfirmed, sent to a conversation W has replaced | Roll forward to W, warning-marked, once five minutes have passed since the send |
| Held for approval, sent to a conversation W has replaced | Wait until that conversation ends, then roll forward to W, warning-marked |
| A quiet payload that would be retried or rolled forward | Close it ambiguous; its members return to the fiber's hooks marked |
| A hook's claim | Close it by its recorded outcome, else ambiguous |

“Unconfirmed” is every outcome but a confirmation: `unknown`, a Claude `queued` or `submitted`, a Pi `queued`, and no receipt at all.
Each pass reads a Claude or Pi conversation's transcript again from `transcript_offset` to its end and stops there, without waiting, whether or not the send's receipt was recorded.
A Claude pass reads at most 8 MiB past the offset and passes over any row over 1 MiB, such as a screenshot's tool result; Pi's passes over rows over 2 MiB.
A `queued` or `submitted` send to a conversation that is still the receiver usually holds the message, so it waits thirty minutes for its transcript to confirm it before retrying; the bound covers a receiver that dropped it (a cleared queue, an aborted turn) and a confirmation the transcript read cannot reach.
After its one retry, a batch whose outcome stays unconfirmed is not sent again to that conversation: it waits for as long as the receiver lives, and rolls forward once the conversation ends or is replaced.
A fiber with no worker settles only the first three rows and hook claims, and leaves the rest to the next receiver.

## Rollback

The current build is CLI contract 48 and HTTP API level 3.
`bin/shuttle-deploy --ref` rolls a host back to an earlier build, and the deploy keeps the previous live release for it; the notes below cover the recent levels such a rollback reaches, newest first.
A rollback leaves inbox entries and records on disk, and rolling forward again resumes from them.
The daemon and its CLI deploy together: either one rolled back alone is a contract skew that holds fresh dispatch.

**Below contract 48.**
Contract 48 sends a Claude session's ask straight to its native socket, never to the session's hook, and has no `claude-mail-recover` verb; it writes no new state.
- A 47 daemon with a 48 CLI shells `claude-mail-recover`, which the CLI lacks: every pass fails, and the daemon retries it every second, logging a warning each time, until the CLI is rolled back too. Session messages it sends through the 48 CLI go to the native socket.
- A 48 daemon with a 47 CLI never shells `claude-mail-recover`: an ask to a busy Claude session, from a sender with a session return address, is queued for that session's hook, and nothing wakes the session with it if no hook offers it.
- Across hosts, a sender on 48 that reaches a 47 owner may get that owner's `queued` `claude-hook` receipt for such an ask, and the 47 owner wakes the session natively if its hook has not offered it within 30 seconds.

**Below contract 47.**
Contract 47 keeps a batch's receipt in its manifest, claims hook emissions with `.hook` manifests, and never sends an open batch's payload again.
A 46 CLI reads a consumer's manifest as its own, but not its receipt, and does not read a hook's claim:
- for a consumer's batch it finds no `messages/` receipt under the batch's transport id and sends the payload again, once, to the conversation the manifest names; a batch still unconfirmed at rollback can reach that conversation twice, without a “Possible repeat” line when its variant was plain;
- a hook's claim left by a hook that died is invisible to it: its members read as free, the next hook or consume offers them once more without the mark, and the claim stays on disk until a 47 reader closes it.

Before rolling a host back below 47, let its consumer batches settle, so that no `mailboxes/fiber/*/batches/*.json` remains, or accept those repeats.
Rolling forward reads a manifest a 46 CLI left open, which carries no receipt, as a send of unknown outcome.

**Below API level 3.**
API level 3 came with a contract 46 build: `/deliver` takes `notify_when_idle` with no `text` and has no `unless_live`.
A daemon on the build before it refuses a notify-only `--notify-when-idle` to one of its fibers with 400 `text is required`, storing nothing, until it rolls forward; it answers a failed consume as plain `queued`, and reads an entry without a `session` wish as `any`.
Its CLI sends `unless_live` to current owners, which ignore it and queue the message.

**Below contract 45, and further back.**
Rollback below 45 is unsafe while delayed entries are pending: an older daemon can deliver a pending entry at once, ignoring its delay, so list and cancel them on 45 first (`shuttle inbox ls <fiber> --scheduled`, `shuttle inbox cancel`), or keep the owner stopped until their times have passed.
Further back, deduplication thins out: below 44 a voice batch in flight can paste twice, so stop voice capture and let relay batches drain before rolling back, and never retry a voice id there; below 42 a retried board line can paste twice and a retried `--fresh` id starts another session; below 41 the routing inbox is not read, so thread results wait in it until the host rolls forward, when an unblock note's board line shows a second time.

## Verbs

| Command | Does |
|---|---|
| `shuttle inbox put <address> <message-id> <text>` | Enqueue, with `--source`, `--turn`, `--if-costly`, `--not-before`, `--from` and `--derived`; silent on success |
| `shuttle inbox pending <address>... [--waking]` | JSON address → pending count, or with `--waking` the count a launch would be for; unreadable addresses are named on stderr and omitted |
| `shuttle inbox ls <address>` | Pending entries oldest first; `--json` includes wishes, queued time, sender and the open batch that holds it (`attempt`) |
| `shuttle inbox consume <fiber-key> <address-or-dash> <epoch> [--idle] [--unknown] [--busy] [--costly] [--message <id>]` | Consume for the current receiver, or with `-` and epoch 0 for a fiber with no worker; one JSON object with `action` (`wait`, `wake`, `context`, `fresh`, `launch`), the `members` sent or reserved, `turn` when an entry asks for a turn the worker's facts would decide, and with `--message` that entry's state after the pass (`message`: `delivered`, `sent`, `reserved`, `pending` or `unknown`). The answer is printed even when an open batch's send fails, which exits nonzero |
| `shuttle inbox thread-state` | Establish the thread capture window and print its `baseline`, or exit 3 on a corrupt state |
| `shuttle inbox thread-put` | Capture a JSON array of `{id, record, board}` publications from stdin into the routing inbox, storing a `board` record in that entry, then append every board line the routing inbox's entries owe, from the stored record; print `{"created": [ids], "refused": [{id, error}], "board_errors": [{id, error}]}`, trying every publication |
| `shuttle inbox routes` | List the routing inbox's pending publications as `{id, record}` |
| `shuttle inbox route <id> --current true\|false\|unknown [--record <json> [--key <key>]]` | Advance one routing entry from the daemon's fresh facts: the resolved recipient's `record`, and its inbox `key` when the daemon owns it; print `action`: `wait`, `forward` or `session` with the entry's `record`, or the disposition it recorded (`placed`, `superseded`, `expired`) |
| `shuttle inbox settle <id> forwarded\|delivered\|undeliverable` | Record a routing entry's confirmed handoff and move it to offered |

`shuttle inbox record-begin [--from <sender>] [--source human|voice|pulse|message] [--fiber <uid> [--ask <question>]] <fiber-key> <id>` records a line the daemon transports itself (typed or spoken human input, a pulse tick, or an agent's fresh request), read from stdin, and with `--fiber` writes a human line's board row, and prints `{"created": true|false, "disposition": "unknown"|"delivered"|"undeliverable"}`: only the call that created it may transport it, and a repeat gets the stored disposition.
`shuttle inbox record-settle <fiber-key> <id> delivered|unknown|undeliverable` records its transport outcome.
Raw-key verbs act on this host's inbox only; `ls` and `cancel` with a fiber reference route to its owner.
`context-mailbox put` also accepts thread signals, reply and notification fields, `--turn`, `--derived` and `--attachments-stdin` (a JSON attachment array); its `--wake` means `turn: force`.
The speaker's held lines are `shuttle say --held` ([CLI reference](../reference/cli.md)).
