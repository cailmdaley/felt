# Collapse accounting

The collapse layer (`tests/go-parallel..tests/collapse`) folds clusters of
near-duplicate daemon and board tests into tables and properties. This file
accounts for every assertion the folded tests made: which assertion in the new
form holds it, or the commit that restored it. `561ad38c` (workspace contrast)
is reverted by `0136466e` and not counted; `fc28b293` only adds `stream_data`.

Method: each cluster's old tests were read from `git show <sha>` and matched,
assertion by assertion, against the current files. For properties the
generators were replayed (StreamData `check_all`, fast-check with the test's
seed) to measure how often each old example's case is drawn. Each restoration
was shown red by mutating `daemon/lib` or `ui/src`, then the mutation was
reverted.

## Summary

| | clusters | observables audited | lost or weakened | restoration commits |
|---|---|---|---|---|
| daemon | 17 | 456 | 7 | 4 restorations + 2 pins |
| board | 15 | 233 | 11 (7 lost or weakened, 3 copied oracles, 1 relaxed equality) | 9 |
| **total** | **32** | **689** | **18** | **15** |

"Weakened" covers an assertion the new form makes but no longer pins: a fixed
expectation replaced by a sampled case that is missed on some runs, an
equality relaxed to a pattern match, or an expected value computed by a copy
of the code under test.

### Restorations

| commit | cluster | what it restores | red evidence (lib mutation → failing test) |
|---|---|---|---|
| `c493b87f` | 16147271 | each held boot's parked reason, contract verdict and adoption state | skew reason replaced by the quarantine reason → `the boot quarantine holds on a contract skew` (`reason =~ ~r/\Acontract skew — /`); quarantine reason changed → 14 failures incl. all 12 rows |
| `330796dd` | 2716de0f | exact worker session from a dispatch on a kitty-forked server and under a wedged shell | `spawn_tmux` returns `"shuttle-anchor"` → `every launch path refuses a wrapper…` and `the tmux server preflight starts a missing macOS server…` |
| `bd2a3923` | 59f5d5a8 | If-None-Match outranks a matching If-Modified-Since and a Range (fixed example) | `not_modified?` also true on any If-Modified-Since → `If-None-Match outranks a matching If-Modified-Since and a Range` |
| `3edf58f0` | 8f7527c7 | two onsets in one minute count twice (fixed example; property gaps weighted short) | notify count capped at 1 per minute → the example and the property fail on 8/8 seeds |
| `1ec8b2ab` | e846c2e2 | `clean_handoff_since_dispatch?` false for a nested dispatch with only a flat handoff; nested shadows flat (fixed example) | `nil -> false` flipped to `true` → only the restored example fails; the property passes |
| `a3a6f0dd` | 07d57b71 | the gate's named cases and its strict boundary, fixed | `== :gt` → `!= :lt` → the pinned table fails at `prev_due -90s, window 90000ms` |
| `ce237375` | 76750ba6 | one Resting cluster per key; a cluster of four stays whole (fixed) | each loose card its own bucket → property fails "one cluster per key"; `MAX_CLUSTER_CARDS = 3` → the four-alone example fails |
| `f1f8da93` | cfcdedfa | every chunk, the live one included, survives a leftward grow at the same clock; chunk zero starts on 1970-01-01 | a firstChunk suffix on the live key → property fails; chunkIndexOf off by one → the epoch pin fails |
| `76990c5e` | 4c71e70f | fractional cursors floor (quarter-pixel generator; fixed 2.99·dayW → 2 and the column edge) | `Math.round` before the floor → fixed test "expected 3 to be 2" and the property |
| `19640bd3` | 31424a79 | another host's fiber of the same slug never answers, through `suggested()` | dirKey reduced to the id → "expected /far/b to be /srv/b" |
| `e952d80f` | 0d07b647 | a local save with empty text still sends `text: ""` | `...(text ? {text} : {})` → routing table fails |
| `bc67bcbf` | aadf7826 | written truth table replaces the copied `expected()`; a stroke with no modifier fields is bare | strict `=== false` checks → the no-fields test fails; ⌘+Ctrl → bare → table fails |
| `593d0584` | 7811b90f | fixed host fixtures and three invariants replace the restated filter | `.reverse()` after the filter → 3 failures |
| `92324444` | 757420b7 | match kinds read off the cards replace the copied `tier()`; exact > prefix > substring pinned | tiers 1 and 2 swapped in `rankOf` → property, the poller example and a mergeHits test fail |
| `483c448e` | 810243e9 | every surface's whole id list, so a card twice in flight fails | in-flight cards pushed twice → placement table fails |

The If-None-Match, standing-role and nested-shadow pins hold cases the
properties already reach on nearly every run; they make those cases hold on
every run.

Not restored, by decision:
- The non-ULID uid literals (`nil`, `""`, `"not-a-ulid"`) are drawn by
  `member_of` in one branch of four; each is missed in about 2 runs in 10,000.
- The `cccfa1b5` staleness history already runs on the injectable registry
  clock (merge `d6975ad3`): its 200 ms window is a logical value that only
  `advance/1` moves, with no wall-clock wait.

## Daemon

### 16147271 — boot-quarantine hold and startup adoption (`poller_test.exs`)

`assert_held!/2` = exactly the candidate parked in `pending_launch`,
`boot_quarantine == true`, no `tmux new-session`. Table test =
`the boot quarantine holds on <label>`. Since `c493b87f` every row also
asserts the parked reason (default `boot quarantine — awaiting release`),
`contract.ok` (default true) and `adopted?` (default true).

| old test | old observable | held by |
|---|---|---|
| stop marker still quarantines | held (pending, flag, no launch) | row "a gracefully stopped previous incarnation" → `assert_held!` |
| host not opted in | held | row "a host that has not opted in" |
| stale heartbeat | held | row "a stale heartbeat" (same 300 s age) |
| crash loop | held | row "a crash loop" (same at/booted_at/boots offsets) |
| too many recent boots | held | row "too many recent boots" (same four boots) |
| recorded workers gone | held | row "a heartbeat whose recorded workers are gone" |
| missing heartbeat | `refute File.exists?`; held | row "a missing heartbeat file" (the refute is in the arrange step) |
| scan unknown | `refute adopted?` | **restored** `c493b87f` (`adopted?: false` row expectation) |
| scan unknown | held | row "a boot whose tmux scan is unknown" |
| malformed heartbeat ×4 | held; poller survives | four rows; `assert Process.alive?(poller)` |
| contract skew | parked reason `=~ "contract skew"` | **restored** `c493b87f`; also held by `a mismatched contract level holds fresh launches and surfaces the skew` |
| contract skew | `contract.ok == false` | **restored** `c493b87f` |
| contract skew | `boot_quarantine == true` | row "a contract skew" → `assert_held!` |
| launder / skew-release / released stories | unchanged assertions | same tests; only the hard-kill arrangement moved into `hard_kill_after_long_run!/2` |
| adopts orphan on startup | the fiber appears in `eligible` | `poller adopts on startup a fiber's worker` → exact `[%{fiber_id, state: "running", tmux_session}]` (stronger) |
| uid-carrying worker | eligible and running | row "a uid-carrying fiber's worker…" (exact) |
| stderr listing warnings | eligible and running | row "uid workers when Shuttle listing warnings go to stderr" |
| hyphenated fiber id | exact eligible list; session name | row "a literal hyphenated fiber id" |
| (new) | no fresh launch can stand in for adoption | every adoption row runs under `boot_quarantine: true` and refutes `new-session` |

Observables: 24.

### 2716de0f — dispatcher continuation, preflight, resume and naming (`dispatcher_test.exs`)

CONT = `the continuation follows resume_mode, kind, session, handoff, surface
and transcript`; WRAP = `every launch path refuses a wrapper bash -l cannot
run, and only that wrapper`; TMUX = `the tmux server preflight starts a
missing macOS server through kitty or refuses`; EFF = `resolved effort and
chrome render through each harness's native flags`; RES = `a resume keeps the
session handle and sends only a nonblank prompt, on each harness's channel`.

| old test | old observable | held by |
|---|---|---|
| session_name keys by uid | exact names for `tests/haiku`, `a/b/c` | ULID property: `name == "#{leaf}-#{uid}-shuttle"` over 1–4 segments and a trailing `/` |
| no ULID → nil | `nil`, `""`, `"not-a-ulid"` → nil | non-ULID property (sampled; see above) |
| produced name recognized | `shuttle_session?(name)`, `from_tmux(name) == uid` | ULID property |
| non-worker names | four refutes | unchanged loop |
| missing wrapper (dispatch) | `wrapper_unresolved`; message names `claude`, `bash -l`, `agents.json`; no new-session; no sessions | WRAP dispatch × `:missing` |
| alias wrapper | message names `ALIAS`, "does not expand aliases"; no new-session | WRAP dispatch × alias |
| wedged shell | exact `{:ok, FiberUid.session("tests/haiku")}`; spawned | **restored** `330796dd` (had become `match?({:ok, _})`) |
| resume preflighted | error; no new-session | WRAP resume × `:missing` |
| capture refuses | error naming `claude`; no new-session | WRAP capture × `:missing` |
| effort / chrome (5 tests, 9 asserts) | each flag fragment present or absent | EFF rows |
| resume command (8 tests, 20 asserts) | per-harness fragments; no `<<<`; ends with the handle | RES |
| warm / cold / no transcript | 60 s and 2700 s → previous; 2701 s → `{:cold, uuid, path}`; nil → `{:cold, uuid, nil}` | CONT, exact |
| clean handoff | `:fresh`; transcript not looked up | CONT `:after_dispatch` + `refute_received` |
| app surface | nil → previous; handed off → fresh; no lookup | CONT app rows |
| explicit previous | previous at 10 h and nil | CONT previous rows (largest age 3601 s, same branch) |
| fresh with warm transcript | not previous | CONT exact `{:cold, …}` (stronger) |
| predecessor | 3601 s → fresh; 3600 s → cold | CONT `by_transcript` rows |
| continue | pinned 60 → previous; 2701 → cold; standing + handoff → fresh; no runtime → fresh | CONT continue rows |
| previous with no id | `{:error, :missing_session_id}` | CONT previous × no session |
| standing / first run / clean | fresh | CONT rows; default arity still called near line 1483 |
| darwin, no server | exact anchor argv; anchor is not a worker name; kitty before new-session | TMUX `launches ==`, `refute shuttle_session?("shuttle-anchor")`, `kitty_at < new_session_at` |
| darwin, no server | returned session `=~ "-shuttle"` | **restored** `330796dd` (exact session for dispatch, `capture-` name for capture) |
| darwin, no kitty | `tmux_server_unavailable`; names kitty, erlexec; nothing spawned | TMUX `:refused` |
| darwin, server present | no launch; exit-empty disarmed before new-session | TMUX darwin/present |
| linux, server absent | ok; no launch | TMUX linux/absent (also refutes set-option) |
| `tmux ls` timeout | ok; no launch; no set-option | TMUX darwin/timeout |
| capture refuses | error naming kitty; nothing spawned | TMUX capture rows |

Observables: 108. Drift kept: a handoff stamp without fractional seconds is no
longer used.

### 59f5d5a8 — file-route sandbox and If-None-Match (`file_controller_test.exs`)

| old test | old observable | held by |
|---|---|---|
| local HTML / SVG / media / per-extension, both byte routes | 200; body; content-type; CSP; nosniff; no ACAO | `sandboxes every local type and status on every byte route…` |
| local HEAD / 206 / 304 / 416 | status; CSP; nosniff | same, inner loop over every type |
| relayed per-extension | 200; body; CSP; nosniff; no ACAO; forwarded URL | `sandboxes every relayed type and status…` "unsafe owner headers" |
| relayed 206 / 304 / 404 / 416; relay failure | status (failure → 502); CSP; nosniff | same, status rows |
| owner omits CSP; unsafe remote CSP/ACAO | CSP imposed; ACAO stripped | same, those rows |
| parse raises ×2, `%FF` query | 400; CSP; nosniff | `retains file security when the endpoint raises before the controller` |
| ETag format | `^W/"sha256-[0-9a-f]{64}"$` | `200 carries ETag, Last-Modified, and Cache-Control validators` |
| INM match + Range | 304; empty body; no content-range | 304 property `{true, _}`; **pinned** `bd2a3923` |
| IMS alone / 1970 / stale INM | 200; body | 304 property `{false, false}` |
| INM over a matching IMS | 200; body | 304 property; **pinned** `bd2a3923` |
| list member / `*` | 304 | 304 property |

Observables: 63. Drift kept: each type is requested with its own Accept
header; the no-Accept and JSON-Accept variants are gone.

### acc04e43 — `pick_socket` (`kitty_test.exs`)

All six old cases (panel over normal, newest panel, fallback to newest
normal, dead never chosen, live panel over newer dead, none → nil) are drawn
on 100% of property runs and checked by `== expected`. Observables: 6.

### 9bb3c683 — `session_status` (`tmux_test.exs`)

Each row asserts the status, the ps scan (exact args, or none) and
`present? == (status != :gone)`. The four absence messages, the three run-script
cases (own uid → `:unknown`, other session and suffix-only → `:gone`), the
two unreadable scans, and the three non-absence errors are one row each.
Observables: 16.

### cf737a72 — gated TCP peer (`peer_gate_plug_test.exs`)

Each old case (admits daemon uid and keeps login; expected nil, root, foreign
and unresolved uid refused) is a row asserting `halted`, 403 and, where the
old test checked it, the exact body. Observables: 13.

### cccfa1b5 — remote feed staleness (`remote_fiber_registry_test.exs`)

`a feed is stale from the last success, not the last poll` walks one
`@history` on the injected clock; each step asserts stale, fibers and
last_error exactly.

| old test | old observable | held by |
|---|---|---|
| single blip | fresh after success; exactly one fiber | `:success "foo"` |
| single blip | fresh after failure; `last_error`; last-good fibers | `:blip :econnrefused` |
| older than window | stale | first `:aging` |
| sustained failure | stale; `last_error`; last-good fibers | final `:aging` (`:timeout`) |
| fast recovery | stale, then fresh at once with new fibers | `:aging`, `:recovery "bar"` |
| never polled | stale; no fibers | `:never_polled` |

Observables: 14.

### 0ba1fc41 — default LocalAPI socket (`remotes_test.exs`)

Each row asserts the check result, the exact refusal (`"#{socket}: #{why}"`),
the source, `configured?` and `tailscale_socket`. Rows: applies with nothing
configured; group-writable dir; FIFO; regular file; world-writable `.local`;
symlinked state with `.local` 0777 (pins mode-over-symlink precedence) and
0755; the four real cluster layouts; darwin; absent. Observables: 27.

### 5ea956fc — invalid attachment request (`attachments_controller_test.exs`)

Each row asserts 400, `error =~` its rule, and no attachments directory.
Rows keep the old boundaries: `max_file_bytes + 1`, `max_files + 1`, the
three-chunk batch total, image 2's sha mismatch, bad base64, empty and missing
lists. Observables: 19.

### 8f7527c7 — waiting spells and tool spans (`activity_controller_test.exs`)

Both properties assert the exact bucket list against an independent model
(`spell_model`, `span_model`).

| old test | old observable | held by |
|---|---|---|
| machine prompt closes the spell | two onsets | spell property |
| file delivery keeps the spell | single onset | spell property |
| repeats collapse | single onset | spell property |
| user prompt closes | notify, attention, notify | spell property |
| post_tool_use / stop close | two onsets | spell property |
| two onsets in one minute | `n: 2` in one bucket | **restored** `3edf58f0` (was reached on ~76% of runs) |
| seven-minute call | minutes 0..6, agent, session, `n: 1` | span property |
| unmatched pre | `[agent@t0]` | span property |
| interleaved sessions | each session's minutes | span property |
| real replaces fill (both orders) | `n: 1` | span property |
| began before the window | clipped buckets, inclusive end | span property |

Observables: 15.

### 8995440c — config write precondition (`config_controller_test.exs`)

`a write commits only when its precondition matches the file as it is now`;
each row asserts status, conflict flag, message and the file afterwards.
Absent key, matching digest, stale digest (409, "changed since you opened
it", file unchanged), null over an existing file (409), null over an absent
file (200), digest over a deleted file (409, "was deleted since you opened
it", file still absent): one row each. Observables: 16.

### f991e56d — remote writes and forced starts (`api_controller_test.exs`)

P = `a forced start without a usable project_dir asks for one before any
write` (per row: 422, `dispatched false`, `arm_refused`, fiber id, `needs
project_dir`, own host, message, status unchanged on disk; after the loop no
`reopen`, no `set-agent`, nothing spawned). F = `a remote-owned write forwards
to the owner, origin stripped, and relays its answer` (200, verbatim body or
re-stamped origin, forwarded URL, forwarded payload).

| old test | old observables | held by |
|---|---|---|
| no project_dir (9) | 422 … nothing spawned | P row `api-start-no-dir` + post-loop |
| bad dir (6) | "no such file or directory" | P row `api-start-bad-dir` |
| blank dir (3) | no `set-agent` | P row `api-start-blank-dir` + post-loop |
| standing (6) | status stays closed on disk | P row `api-standing-no-dir` |
| pinned (5) | status stays open on disk | P row `api-pinned-no-dir` |
| missing dir (5) | names the path | P row `api-start-missing-dir` |
| transition (6) | invoked, action, origin, URL, payload | F `/transition` (whole-body equality) |
| felt edit, lifecycle, dispatch, dispatch with message (16) | relayed body, URL, payload | F rows |

Observables: 56.

### e0eaa0ce — expected digest (`config_files_test.exs`)

`commits iff the expected digest names the file as it is now, absence
included` walks on-disk {absent, stores, other} × read {nil, stores, other} ×
text {replacement, ""}: a match commits and the disk reads the text (absent
for `""`); a mismatch conflicts with "changed" or "deleted" and leaves the
disk as it was. Matching, stale, deleted, nil-vs-absent, nil-vs-existing and
stale removal are cells of that grid; the `:any` default test is unchanged.
Observables: 20.

### 07d57b71 — standing-role due gate (`standing_role_test.exs`)

The property's oracle is `defect == nil and reach > 0`.

| old test | old observable | held by |
|---|---|---|
| last tick inside the lookback | due | property; **pinned** `a3a6f0dd` |
| last tick before the lookback | not due | property; pinned |
| stray review key | still due | property (~7% of runs); pinned |
| catch-up (5 min tick, 6 min lookback) | due | property; pinned |
| oneshot | not due | property; pinned |
| unresolved schedule | not due | property; pinned |
| (new) | a tick exactly one window old is not due | property (`reach 0`); pinned |

Observables: 6.

### e25b3924 — awaiting-role actions (`actions_test.exs`)

`each column resolves to its verdict, and the actions offered are exactly
those` asserts the exact `{:ok, %{id, invocation}}` per column and the exact
offered set. Standing: tempered/in-flight → accept-run, composted →
close-composted, drafts → reopen-draft, awaiting → close-awaiting-review, and
the offered set excludes reopen and both continue-run actions. Pinned:
accept-run in every live column; offered set excludes reopen and
reopen-draft. Observables: 23.

### 2de83678 — app adoption and recovery (`app_workers_test.exs`)

AD = `adoption records ownership only for the requested thread confirmed
live` (unverified, `get` not found, calls exactly one read); RC = `watcher
recovery reloads only its own thread, confirmed, and keeps ownership when it
cannot` (result, exact call list, ownership kept). The three non-live states
and the other-thread read are AD rows; another-thread, disconnected,
status-less read, wrong-thread resume and the live resume of a not-loaded
thread are RC rows. Observables: 21.

### e846c2e2 — nested-only continuation readers (`continuation_test.exs`)

| old test | old observable | held by |
|---|---|---|
| nested shadows flat | nested dispatched_at and session | property (~5.5% of runs draw both); **pinned** `1ec8b2ab` |
| no flat fallback | dispatched_at, handed_off_at nil; nested session | property |
| un-migrated fiber | nothing read | property (`runtime: :absent`) |
| non-map runtime | nothing read | property (`"oops"`, nil, 42) |
| flat handoff only | `clean_handoff_since_dispatch?` false | **restored** `1ec8b2ab` (the property checks only indifference to flat keys) |

Observables: 9.

## Board

| old test | old observable | held by |
|---|---|---|
| **1f319dc5 keymap (`keymap.test.ts`)** | `keyIntent` per surface × binding × key (1 parametric) | `every declared binding yields its intent…`, all misses collected |
| **5fda3936 move menu (`moveDestinations.test.ts`)** | 34 contains / excludes across 14 tests | `offers exactly the destinations each guard allows`: each row compares the full ordered id list (stronger) |
| **44cc6308 cycle rule (`boardRules.test.ts`)** | 10 shapes → `'cycles'` | property (seed `0x5eed`) reaches every shape, half of them only with extra fields; `isCycleFiber` is checked first, so the extras cannot mask |
| **d3bb53ff stack drop claim** | 11 cases | the full verdict × inZone × dwelled truth table against `legal && (inZone \|\| dwelled === true)` |
| **13684342 queue drop** | 11 lifecycle / kind cases | property `toEqual({ok: true, tail})`; the transitive tail stays in `stacks a dropped card onto the chain TAIL` |
| **76750ba6 Resting clusters** | four alone `[['science', 4]]` | **restored** `ce237375` (fixed example and one-cluster-per-key) |
| | keeps descending; no stranded card | partition / prefix / parent-overflow invariants, plus one-cluster-per-key |
| | every card exactly once | partition invariant |
| **aadf7826 settings hotkey (`chassisGuards.test.ts`)** | 23 key × modifier answers | **re-oracled** `bc67bcbf` (written truth table) |
| | (absent modifier fields) | **restored** `bc67bcbf` |
| **7811b90f projectsForHost (`projectPicker.test.ts`)** | local → 2 ids in order; candide → 1; cineca → []; reversed order kept | **restored** `593d0584` as fixed examples; property now three invariants |
| **4c71e70f columnIndexAtX, overlayDueEdits (`chronicleDueDrag.test.ts`)** | 0, 1, 5, edge at 48; clamps; dayW 0; dayCount 0 | floor-bracket property |
| | 2.99·dayW → 2 | **restored** `76990c5e` |
| | overlay: untouched cards by reference, no mutation, confirmed / unconfirmed / no-due edits | overlay property (each case 20–88 of 200 runs) |
| **757420b7 localHits (`chronicleSearch.test.ts`)** | hit id, `where`, onBoard; id-only; case and padding | property set equality, `where`, re-query equality |
| | exact > prefix > substring | **re-oracled and pinned** `92324444` |
| **f8703362 wikilinks (`wikilinks.test.ts`)** | 7 resolutions | 7 table rows, same literals |
| **0d07b647 settings API (`settingsApi.test.ts`)** | 15 method / URL / body checks | 15 calls × {local, remote}, whole-request equality |
| | local write with empty text | **restored** `e952d80f` |
| **cfcdedfa chronicle window (`chronicleWindow.test.ts`)** | 12 edge-extension cases | edge property, whole-plan equality (exact trigger edge 10×, one pixel outside 7×) |
| | settled chunks re-found across a grown window and a later clock; contiguity; 6 am bounds; DST witnesses | chunk property in 5 zones |
| | live chunk unchanged across a leftward grow at the same clock | **restored** `f1f8da93` |
| | chunk helpers at the epoch | **pinned** `f1f8da93` (the property already anchors `% 28`) |
| **810243e9 role placement (`KanbanComposite.test.ts`)** | 18 placement and field checks | 3 kinds × 6 runtimes table |
| | in-flight list exactly `['role']` | **restored** `483c448e` (had become `includes`) |
| **31424a79 project_dir inheritance (`startPrompt.test.ts`)** | nearest same-host, same-store ancestor; another store; own dir; no host | property over generated trees |
| | another host's same slug, through `suggested()` | **restored** `19640bd3` |

The restored same-slug example's far row also differs in store, so it catches
a key that drops both host and store, not host alone; the property covers the
host-only case at the function level.

## Gates

On `a3a6f0dd`: `mix test` 1543 tests, 8 properties, 0 failures on two clean
runs. A third run failed once in `remote_registry_client_test.exs` ("an
http:// remote is never sent through it", a 2 s request under load average
~60); this layer does not touch that file, and it passed alone five times and
in the next full run. `npm test` 1452 tests, 0 failures; `npx tsc --noEmit`
clean.
