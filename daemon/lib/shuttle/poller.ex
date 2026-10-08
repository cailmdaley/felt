defmodule Shuttle.Poller do
  @moduledoc """
  Polls the felt fiber tree and dispatches workers for eligible constitutions.

  A single GenServer owns the dispatch tick, the eligibility predicate, and
  reconciliation; there is no retry queue — a oneshot whose worker exited
  while its fiber is still active is simply eligible again on the next tick. It starts `Shuttle.WorkerWatcher` processes
  under a `DynamicSupervisor` to track each worker's tmux session from outside.

  ## Felt stores

  The Poller manages one or more felt stores on the same machine, as
  `Shuttle.FeltStores` resolves them and re-read every poll cycle:

      # env var (comma-separated, takes precedence over the persisted file):
      SHUTTLE_STORES=~/some-store,~/other-project
      # or persisted registration written through the HTTP API:
      ~/.config/shuttle/stores.json

  The registry is the source of truth: with `SHUTTLE_STORES` unset, the list
  comes straight from the registry (empty if none registered). A
  `:felt_stores` start option pins the list instead (tests).

  Each fiber resolves to exactly one store: the one whose `.felt/` physically
  roots the fiber file. The resolution is cached in `State.fiber_store_cache`
  for the daemon's lifetime.
  """

  use GenServer
  require Logger
  require Shuttle.Dispatcher

  alias Shuttle.{
    Collaboration,
    DaemonHeartbeat,
    Dispatcher,
    LifecycleService,
    LifecycleStore,
    StandingRole,
    WorkerWatcher
  }

  alias Shuttle.Poller.Snapshot
  alias Shuttle.Poller.SessionReconciliation
  alias Shuttle.Poller.StandingRoles

  @default_poll_interval_ms 30_000
  # A stuck felt/SSH read must not permanently stop reconciliation. The
  # watchdog reaps the tracked read task before advancing the poller's clock;
  # the per-cycle token makes a result already queued at that boundary inert.
  @default_poll_stall_timeout_ms 300_000
  @default_full_scan_budget_ms 10_000
  @default_full_scan_min_interval_ms 600_000
  @default_full_scan_timeout_ms 900_000
  @poll_stall_margin_ms 1_000
  @default_max_concurrent_workers 10
  @default_heartbeat_interval_ms 5_000
  # THE boot-quarantine default: a freshly (re)started daemon parks every
  # autonomous dispatch until a human releases it (POST
  # /api/v1/quarantine/release / `shuttle daemon release`) — no timeout, no
  # self-clearing. Single source of truth; config (`:boot_quarantine`) and the
  # start_link opt override it (config/test.exs sets false so dispatch tests
  # exercise the tick directly; quarantine tests opt back in per-poller).
  @default_boot_quarantine true
  # The persistent_term namespace `own_host_id/1` freezes each Poller
  # instance's identity under (keyed further by that instance's self_ref —
  # see init/1). A plain atom tag, not `__MODULE__`, so it reads unambiguously
  # in `:persistent_term.info/0` dumps.
  @own_host_pt_namespace :shuttle_own_host_id
  # The daemon-wide identity `freeze_daemon_host_id!/1` resolves once at
  # application start; per-Poller slots fall back to it.
  @daemon_host_key {@own_host_pt_namespace, :daemon}
  # How long a caller waits on a Poller call that may spawn or stop a worker
  # (dispatch, claim, kill, capture, lifecycle transitions): well past
  # GenServer's 5 s default, since a spawn on a loaded host can take seconds.
  # `config :shuttle, :dispatch_call_timeout_ms` overrides it.
  @dispatch_call_timeout_ms 30_000
  @orchestrator_state_call_timeout_ms 30_000

  # Resume-loop circuit breaker. A still-active oneshot whose worker exits is
  # re-dispatched on the next poll (resuming the prior transcript on a dirty
  # death). When a worker dies almost immediately — a stale/unresumable session,
  # a wrong project_dir, a TCC-blocked cwd — that re-dispatch produces another
  # near-instant death, and the fiber churns ~every poll forever (observed: one
  # fiber resumed 125× in a day). The breaker counts CONSECUTIVE rapid exits
  # (worker lived < threshold) per fiber; after `max` it pauses autonomous
  # dispatch for a cooldown and surfaces the fiber as `blocked` so a human looks.
  # A healthy run (lived ≥ threshold) or a human force-dispatch clears the count.
  # Lifetime-based on purpose: it needs no handoff signal from the worker.
  @resume_loop_rapid_exit_threshold_ms 90_000
  @resume_loop_max_rapid_exits 5
  @resume_loop_cooldown_ms 600_000

  # The dispatch preflight (`Shuttle.Dispatcher`) refuses before anything spawns
  # when the agent's wrapper does not resolve in a login bash, or the work
  # directory is not on this host. Both are HOST CONFIG facts: re-testing them 30
  # seconds later cannot change the answer, and each retry spawns a fresh
  # `bash -l` synchronously inside this GenServer — seconds per tick on a host
  # with a heavy login profile.
  #
  # They also fall through the resume-loop breaker above, which is why they need
  # their own. That breaker counts worker EXITS, and a refused dispatch never
  # spawns a worker to exit.
  #
  # So a refusal parks the fiber, same shape as the breaker: it already surfaces
  # as `blocked`, a human force-dispatch bypasses `eligible?/2` entirely, and a
  # successful dispatch drops the entry. Shorter window than the resume loop —
  # the fix is usually a one-line config edit, and re-testing costs one probe.
  @preflight_cooldown_ms 300_000

  defmodule State do
    @moduledoc false
    defstruct [
      # Stable reference for cross-process messaging (e.g. WorkerWatcher →
      # Poller exit notifications). Captured from the Poller's registered
      # name in init/1, falling back to self()'s pid if unnamed (test
      # scenarios). Watchers store this as `:poller` and `send/2` resolves
      # the registered atom at delivery time, which survives a Poller
      # supervisor restart — pids do not (the old pid is dead, sends are
      # silently dropped, and `state.running` ghosts forever).
      :self_ref,
      :poll_interval_ms,
      :max_concurrent_workers,
      :heartbeat_interval_ms,
      :tick_timer_ref,
      :tick_token,
      :stall_timeout_ms,
      :stall_timeout_base_ms,
      :full_scan_budget_ms,
      :full_scan_min_interval_ms,
      :full_scan_timeout_ms,
      :poll_stall_timer_ref,
      :poll_token,
      :poll_task_pid,
      # List of felt store directories, in resolution-priority order.
      :felt_stores,
      # Machine identity used by shuttle.host dispatch affinity.
      :own_host_id,
      # When true, felt_stores is re-read from env + persisted registration on
      # each poll cycle. Set true when :felt_stores opt isn't passed to
      # start_link; false when the caller passed an explicit list (tests,
      # manual overrides — respect them).
      :auto_discover_felt_stores,
      :runner,
      poll_check_in_progress: false,
      poll_stalls: 0,
      last_poll_stalled_at: nil,
      # Monotonic count of poll cycles APPLIED (a cycle whose reads came back
      # and were folded into state — success or logged read failure alike).
      # Per-cycle observations (`orphans`, rebuilt from scratch by every
      # `reconcile/1`) are only meaningful relative to the cycle that produced
      # them, so an observer needs to know a cycle boundary was crossed rather
      # than infer it from wall-clock. Never reset.
      poll_cycles: 0,
      # In-memory watcher registry, keyed by intrinsic UID when known; metadata
      # carries :fiber_id as the felt address used for CLI shell-outs and public
      # API payloads. NOT persisted — tmux is the
      # source of truth for liveness, so a restart re-derives `running` by
      # adopting live shuttle sessions (`adopt_orphans`) and every poll
      # reconciles entries whose tmux session has died.
      running: %{},
      standing_roles: [],
      orphans: [],
      # %{fiber_id => felt_store} — populated by discover_candidates/1 on each
      # poll cycle. Entries are never evicted.
      fiber_store_cache: %{},
      # %{uid => slug} — boundary uid→slug RESOLUTION index, rebuilt each poll
      # from the candidate rows (every row carries both `id` and `uid`). It lets
      # a uid-shaped public call (the kanban action-menu hot path — the UI posts
      # uid, and most cards aren't running) resolve to felt's slug address with
      # an O(1) map hit instead of a synchronous cross-store `felt ls` walk
      # inside the GenServer. This serves felt I/O ONLY; runtime state stays
      # keyed by uid, and a cold miss falls through to felt.
      uid_slug_index: %{},
      # %{uid_or_fiber_id => %{modified_at: String.t() | nil, entry: map()}} —
      # daemon-local document cache for the kanban feed. Each poll builds
      # entries from the widened Shuttle listing projection and reuses unchanged
      # entries by modified_at.
      document_cache: %{},
      document_cache_stats: %{hits: 0, misses: 0, evictions: 0, entries: 0},
      document_cache_ready: false,
      # Memoized owner-feed filter+sort: `{document_cache_it_was_built_from,
      # base_rows}`, `nil` until first computed. `owner_feed_base/1` recomputes
      # iff `state.document_cache` is no longer the SAME term this was built
      # from — self-healing against every mutation path (`apply_poll_cycle/2`,
      # `refresh_document_entry/2`, and any test harness that pokes
      # `document_cache` directly via `:sys.replace_state`) without each one
      # having to remember to also touch a derived field. Under login-node CPU
      # contention, redoing the filter+sort (an O(entries) Enum pass) on every
      # hit of the 5s-polled owner feed is enough on its own to push a "pure
      # state read" past callers' timeouts (see felt fiber
      # felt/debug/fibers-endpoint-login-node-contention).
      # `stamp_runtime/2` (cheap; a no-op when nothing is running) still runs
      # per-request over the memoized base so live worker status stays
      # request-fresh.
      owner_feed_cache: nil,
      # When the document cache was last rebuilt (nil until the first poll warms
      # it) and how long that rebuild took. Surfaced in the owner-feed envelope's
      # `cache` metadata (state/refreshed_at/entries/last_refresh_ms) so a viewer
      # renders "stale as of T" instead of "down", and in the poller snapshot's
      # `document_cache` stats for observability.
      document_cache_refreshed_at: nil,
      document_cache_last_refresh_ms: 0,
      # `true` when this tick's cache was built while at least one store's felt
      # listing FAILED (its rows served from `last_known_listings`). The feed's
      # `cache.state` reports "partial" instead of "fresh" so a viewer knows the
      # world is stale for some store, and `refreshed_at` is NOT advanced on a
      # partial tick (staleness stays honest).
      document_cache_partial: false,
      # One-shot guard so the "served from a cold cache" log fires once per cold
      # PERIOD, not once per request (a remote viewer polls every 5s). Reset to
      # false when the first poll flips `document_cache_ready` true.
      cold_feed_logged: false,
      # %{runtime_key => %{reason: term, attempted_at: DateTime.t, attempts:
      # pos_integer, fiber_id: slug, uid: String.t() | nil}} — fibers the
      # dispatcher rejected with an error other than :already_running. Keyed by
      # runtime key (uid when present, else slug), matching `running`; the entry
      # carries the slug + uid so the snapshot's `blocked` rows expose both.
      # Surfaced in the snapshot's `blocked` list so the kanban shows *why* a
      # fiber isn't progressing instead of leaving the poll-cycle warning to
      # scroll unread in the daemon log. Entries clear on successful dispatch or
      # when the fiber's eligibility changes (frontmatter edit, pause, close).
      dispatch_failures: %{},
      # %{runtime_key => %{count: pos_integer, opened_at: DateTime.t | nil,
      # fiber_id: slug, uid: String.t | nil}} — the resume-loop circuit breaker's
      # per-fiber state. `count` is consecutive rapid worker exits (lived <
      # @resume_loop_rapid_exit_threshold_ms); `opened_at` is set once count
      # crosses @resume_loop_max_rapid_exits, pausing autonomous dispatch for
      # @resume_loop_cooldown_ms. Cleared by a healthy run, a force-dispatch, or
      # the fiber leaving the active candidate set. NOT persisted — a restart is a
      # clean slate (and re-adopts live workers rather than re-dispatching).
      resume_loop: %{},
      # Boot quarantine: a daemon restart is NOT dispatch authority for a FRESH
      # launch. An overloaded login node once crashed the daemon repeatedly, and
      # each restart's first poll dispatched every active, host-owned,
      # workerless fiber — ~8 token-burning fresh launches in 4 minutes, several
      # redundant. While true, the autonomous tick parks every *genuinely-fresh*
      # candidate (`parked_launches`) and dispatches nothing fresh; release is
      # PURE MANUAL — `release_boot_quarantine/0` / POST
      # /api/v1/quarantine/release — with no stabilization timer.
      #
      # In-flight work this daemon OBSERVED running under its own uptime is NOT
      # held: a candidate whose runtime key is in `was_running` (adopted at boot,
      # or dispatched/claimed since) is the sanctioned continuation of work that
      # was demonstrably alive moments ago, so it re-dispatches normally even
      # while quarantined (resume-vs-fresh unchanged — `continuation.ex` still
      # decides). Only NEVER-seen candidates are parked. The predicate is
      # runtime-observation, never on-disk markers, so a stale `dispatched_at`
      # can never masquerade as a resume and dispatch FRESH.
      #
      # Human force-dispatch bypasses (and does not clear) the quarantine. Set at
      # init from the `:boot_quarantine` opt / app config (default true;
      # config/test.exs disables it).
      #
      # ONE automatic exit exists, it is not a timer, and it is per-host opt-in
      # (`quarantine_auto_release` below): a daemon that was killed HARD (an
      # rlimit SIGKILL) and is back within seconds releases itself at boot when
      # it can prove the bounce (`Shuttle.DaemonHeartbeat.verdict/2`, read
      # before adoption and judged after it): the heartbeat is this machine's,
      # from another VM, fresh and released, the recorded workers are still
      # live BY THIS DAEMON'S OWN observation, and the previous incarnation was
      # not in a crash loop. It fails closed. Every SIGTERM'd restart — each
      # deploy and operator restart — touches the stop marker
      # (`Shuttle.Application.prep_stop/1`, and the stop scripts before they
      # signal) and so holds, as do an unreleased hold, a real gap, a crash
      # loop, or no evidence at all: a restart is not dispatch authority.
      boot_quarantine: false,
      # Where this daemon records its own liveness, how often, when THIS
      # incarnation booted (epoch ms), and the ring of recent boot times carried
      # forward from the previous incarnation's file. All four exist only to
      # serve the next boot's verdict; see `Shuttle.DaemonHeartbeat`.
      daemon_heartbeat_file: nil,
      daemon_heartbeat_interval_ms: nil,
      # Whether this host opts in to the automatic release at all
      # (`Shuttle.Host.quarantine_auto_release?/0`, host.json). Off: the
      # heartbeat is still written, but no verdict is asked for.
      quarantine_auto_release: false,
      # The heartbeat writer currently in flight, if any (see
      # `write_daemon_heartbeat/1`).
      daemon_heartbeat_writer: nil,
      daemon_booted_at: nil,
      daemon_boots: [],
      # True once boot adoption has scanned tmux and rebuilt `running` from what
      # it found. The auto-release judges worker continuity against `running`,
      # so it holds while this is false: a reorder that ran the verdict before
      # adoption, or a boot whose tmux scan came back unknown, fails closed.
      adopted?: false,
      # `Shuttle.Contract.check/1`'s result, probed ONCE at `init/1`: the
      # daemon shells `shuttle contract` and compares it to
      # `Shuttle.Contract.expected_level/0`. `ok: false` (a mismatched level,
      # unparseable stdout, or a nonzero exit, including an unknown subcommand)
      # means every shelled write this daemon makes is
      # suspect, so the skew is caught once at boot instead of failing one
      # shelled write at a time. Gates the autonomous
      # dispatch tick the same way `boot_quarantine` does (park fresh, let
      # already-observed work resume) — see `apply_poll_cycle/2`'s cond. No
      # self-clearing: a restart is what re-probes, after the CLI/daemon pair
      # is actually fixed.
      contract_check: %{expected: 0, observed: nil, ok: true, reason: nil},
      # Runtime keys this daemon has OBSERVED with a live worker under its own
      # uptime — the union of every key that ever entered `state.running` (boot
      # adoption, per-poll adoption, dispatch, claim). Durable for the daemon's
      # lifetime: NEVER removed on worker exit, so "was running" outlives "is
      # running". Sole consumer is the boot-quarantine gate
      # (`park_autonomous_launches/2`): members auto-resume, only non-members
      # park. Not persisted — a restart re-seeds it from `adopt_orphans`.
      was_running: MapSet.new(),
      # %{runtime_key => %{fiber_id: slug, uid: String.t() | nil, parked_at:
      # DateTime.t}} — every genuinely-fresh autonomous launch the boot
      # quarantine is withholding, surfaced in the snapshot as `pending_launch`
      # rows (first-class, not `blocked`: nothing failed — the daemon is
      # withholding launch authority until a human releases it) and as the
      # board's per-fiber `held` indicator. Rebuilt each poll cycle from the
      # current fresh-candidate set (a fiber that closes, pauses, or reclassifies
      # as was-running simply drops out); `parked_at` is preserved across cycles.
      # Emptied on release. `park_autonomous_launches/2` splits the dispatchable
      # set by `was_running` — members re-dispatch, only non-members land here
      # (runtime-observation, never stale on-disk markers).
      parked_launches: %{},
      # %{store => rows} — the last SUCCESSFUL `shuttle ls` listing per
      # store, retained VERBATIM (no reshape: `created_at`, `tempered`, `slug`,
      # … survive exactly as Shuttle emitted them). Refreshed on every successful
      # listing; served by `discover_candidates/1` when a store's listing fails
      # (timeout, transient exec error), so an outage degrades to yesterday's
      # truth instead of blanking the store or serving a lossy six-key shadow.
      # The retention is OUTAGE-LONG, not one-tick: rows persist until the
      # store's next successful listing replaces them (only a successful
      # listing that omits a fiber is deletion evidence). Safe because these
      # rows only nominate candidates — `Dispatcher.dispatch` re-fetches the
      # fiber and re-verifies status before any launch.
      last_known_listings: %{},
      # The immutable id source for hot scans: only a successful full listing
      # replaces this map; successful hot rows never widen the hot set.
      last_full_listings: %{},
      # Per-store full-scan cadence.
      discovery: %{}
    ]
  end

  # ── Client ──

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    # `name: nil` starts an unnamed instance (tests address theirs through
    # `Shuttle.Env.server/1`).
    case Keyword.get(opts, :name, __MODULE__) do
      nil -> GenServer.start_link(__MODULE__, opts)
      name -> GenServer.start_link(__MODULE__, opts, name: name)
    end
  end

  @spec snapshot() :: map()
  def snapshot, do: snapshot(Shuttle.Env.server(__MODULE__))

  @spec snapshot(GenServer.server()) :: map()
  def snapshot(server) do
    GenServer.call(server, :snapshot)
  end

  @spec snapshot(GenServer.server(), non_neg_integer()) :: map()
  def snapshot(server, timeout_ms) when is_integer(timeout_ms) and timeout_ms >= 0 do
    GenServer.call(server, :snapshot, timeout_ms)
  end

  @spec cached_fiber_documents(keyword() | GenServer.server()) :: {:ok, map()} | {:error, term()}
  def cached_fiber_documents(opts) when is_list(opts),
    do: cached_fiber_documents(Shuttle.Env.server(__MODULE__), opts)

  def cached_fiber_documents(server), do: cached_fiber_documents(server, [])

  @spec cached_fiber_documents(GenServer.server(), keyword()) :: {:ok, map()} | {:error, term()}
  def cached_fiber_documents(server, opts) do
    GenServer.call(server, {:cached_fiber_documents, opts}, @orchestrator_state_call_timeout_ms)
  end

  @doc """
  Returns the serve-time held overlay for boot-quarantine-parked launches.

  The parked-launch analog of the runtime overlay (`Snapshot.runtime_index/2`,
  applied by `stamp_runtime/2`): keyed by fiber_id/uid so the
  owning host's per-fiber feed can stamp a `held` marker onto a card WITHOUT any
  board-side lookup of the daemon-global `pending_launch`. A parked (fresh,
  awaiting-release) launch reads as `held` on its card; released or reclassified
  work carries no entry and the marker clears.
  """
  @spec parked_index(GenServer.server()) :: map()
  def parked_index(server \\ Shuttle.Env.server(__MODULE__)) do
    GenServer.call(server, :parked_index, @orchestrator_state_call_timeout_ms)
  catch
    :exit, _ -> %{}
  end

  @doc """
  Re-read one fiber from disk and replace (or evict) its entry in the document
  cache — the single post-mutation seam.

  The kanban serves card state (status, tempered, outcome, tags, …) from this
  cache, refreshed on the poll. Any action that mutates a fiber document
  (transition pause/reopen/close, accept-run, force-dispatch re-arm, set-outcome,
  set-model) must call this immediately after the write so the UI's
  post-mutation refetch sees the new state instead of snapping back to stale
  cached state until the next poll tick. A re-read (not a field patch) keeps the
  cache a faithful mirror of disk for every field, with no per-verb drift. A
  fiber that no longer resolves (uninstalled / deleted) is evicted. Always
  `:ok` — a refresh failure logs and leaves the stale entry for the poll to
  reconcile rather than failing the mutation the user already committed.
  """
  @spec refresh_document(GenServer.server(), String.t()) :: :ok
  def refresh_document(server \\ Shuttle.Env.server(__MODULE__), fiber_id)
      when is_binary(fiber_id) do
    GenServer.call(server, {:refresh_document, fiber_id}, @orchestrator_state_call_timeout_ms)
  catch
    # Best-effort by contract: if the Poller is unavailable (not started, e.g. a
    # controller unit test, or restarting), the mutation the caller already
    # committed must still succeed — the next poll reconciles the cache. Never
    # let a cache refresh fail the write.
    :exit, _ -> :ok
  end

  # ── Agent-API Client ──

  @spec worker_status(String.t()) :: map() | nil
  def worker_status(fiber_id), do: worker_status(Shuttle.Env.server(__MODULE__), fiber_id)

  @spec worker_status(GenServer.server(), String.t()) :: map() | nil
  def worker_status(server, fiber_id) do
    GenServer.call(server, {:worker_status, fiber_id})
  end

  @doc """
  The harness session UUID currently stamped on `fiber_id`'s
  `shuttle.runtime.session_uuid`, read from the document cache, or `nil`.

  What the dispatch endpoint answers with so a client knows WHICH session its
  dispatch just started — the tmux session name is `<leaf>-<uid>-shuttle` and
  is the same string before and after a fresh dispatch, so it cannot tell the
  new session from the one it replaced. Read after `refresh_document/2`, this
  is the new UUID for a Claude worker (pre-specified at launch) and `nil` for a
  codex/pi worker, whose UUID is scraped and backfilled seconds later.

  `nil` (not an error) when the Poller is unavailable or the fiber is not in
  the cache — the caller degrades to comparing against the previous value.
  """
  @spec session_uuid(String.t()) :: String.t() | nil
  def session_uuid(fiber_id), do: session_uuid(Shuttle.Env.server(__MODULE__), fiber_id)

  @spec session_uuid(GenServer.server(), String.t()) :: String.t() | nil
  def session_uuid(server, fiber_id) when is_binary(fiber_id) do
    GenServer.call(server, {:session_uuid, fiber_id})
  catch
    :exit, _ -> nil
  end

  @doc """
  The messaging identity of `fiber_id`'s live worker: its session, the harness
  conversation id (`session_uuid`, `nil` until known) and the agent's `cli`, or
  `nil` when no worker is running.
  """
  @spec live_worker(String.t()) ::
          %{session: String.t(), session_uuid: String.t() | nil, cli: String.t() | nil} | nil
  def live_worker(fiber_id), do: live_worker(Shuttle.Env.server(__MODULE__), fiber_id)

  @spec live_worker(GenServer.server(), String.t()) :: map() | nil
  def live_worker(server, fiber_id) when is_binary(fiber_id) do
    GenServer.call(server, {:live_worker, fiber_id})
  end

  @spec dispatch_fiber(String.t(), keyword()) :: {:ok, String.t()} | {:error, atom()}
  def dispatch_fiber(fiber_id, opts \\ []),
    do: dispatch_fiber(Shuttle.Env.server(__MODULE__), fiber_id, opts)

  @spec dispatch_fiber(GenServer.server(), String.t(), keyword()) ::
          {:ok, String.t()} | {:error, atom()}
  def dispatch_fiber(server, fiber_id, opts) do
    GenServer.call(server, {:dispatch, fiber_id, opts}, dispatch_call_timeout_ms())
  end

  @doc "The timeout of the Poller's worker-changing calls, in milliseconds."
  @spec dispatch_call_timeout_ms() :: timeout()
  def dispatch_call_timeout_ms,
    do: Shuttle.Env.app(:dispatch_call_timeout_ms, @dispatch_call_timeout_ms)

  @doc """
  First-class claim: register an already-live tmux session as the running
  worker for `fiber_id`, exactly as if the daemon had dispatched it.

  The write-and-claim path for capture sessions (a session that authored its
  own fiber claims itself), and generally any externally-spawned worker.
  Validates the fiber (exists, not closed, no live worker) and the tmux
  session, renames the session to the canonical `<leaf>-<uid>-shuttle` name
  (so restart re-adoption, liveness, and the kanban treat it
  identically to a dispatched worker), starts a watcher, and writes the same
  per-host dispatch marker the dispatcher writes at spawn (when `:session_uuid`
  is provided) so resume works.

  Options: `:agent` (optional execution agent asserted by the claimant; the
  fiber's shuttle.agent remains the display fallback),
  `:session_uuid` (the harness transcript UUID, for the dispatch marker),
  `:meeting` (the launch id of the meeting a capture scribes, stamped as
  `shuttle.runtime.meeting` so the meeting's daemon can find the fiber).
  """
  @spec claim_session(String.t(), String.t(), keyword()) :: {:ok, map()} | {:error, term()}
  def claim_session(fiber_id, tmux_session, opts \\ []),
    do: claim_session(Shuttle.Env.server(__MODULE__), fiber_id, tmux_session, opts)

  @spec claim_session(GenServer.server(), String.t(), String.t(), keyword()) ::
          {:ok, map()} | {:error, term()}
  def claim_session(server, fiber_id, tmux_session, opts) do
    GenServer.call(
      server,
      {:claim_session, fiber_id, tmux_session, opts},
      dispatch_call_timeout_ms()
    )
  end

  @doc """
  Hard-kill a fiber's live worker and tear down its runtime state synchronously.

  The user-gesture twin of a natural worker exit: the kanban fires this when a
  card is dragged off the in-flight column. The worker is stopped
  (`Shuttle.WorkerBackend.stop/2`), the liveness watcher is stopped, and the running entry + claim are
  dropped NOW (not on the watcher's next 5s poll) so the very next composite
  feed reads the card as not-running. Crucially this does NOT write a lifecycle
  verdict — unlike `handle_worker_exit`, which marks a cyclical role
  awaiting-review on a natural exit. A user kill-and-drag means the drag *target*
  is the verdict, so the frontend's subsequent column write is the sole status
  authority; the kill only stops the process. Idempotent: `{:ok, :no_session}`
  when nothing is running for the fiber.

  The stop succeeds once the worker's processes are gone, whether or not tmux
  could still see its session (`Shuttle.Tmux.stop/2`). A failed stop means a
  worker may have survived it; tracking is left in place — no `{:ok, ...}`
  reply and no runtime teardown — so the board doesn't show a stopped card
  while a worker keeps mutating the fiber.
  """
  @spec kill_session(String.t()) :: {:ok, String.t() | :no_session} | {:error, String.t()}
  def kill_session(fiber_id), do: kill_session(Shuttle.Env.server(__MODULE__), fiber_id)

  @spec kill_session(GenServer.server(), String.t()) ::
          {:ok, String.t() | :no_session} | {:error, String.t()}
  def kill_session(server, fiber_id) do
    GenServer.call(server, {:kill_session, fiber_id}, dispatch_call_timeout_ms())
  end

  @doc """
  Spawn-without-constitution: launch a capture session (free-text prompt, no
  pre-existing fiber) in `work_dir`. See `Shuttle.Dispatcher.capture/2`.

  Options: `:agent`, `:work_dir` (required), `:felt_store` (defaults to the
  daemon's primary store), `:meeting` (the launch id of the meeting the
  capture scribes).
  """
  @spec capture(String.t(), keyword()) :: {:ok, map()} | {:error, term()}
  def capture(yap, opts \\ []), do: capture(Shuttle.Env.server(__MODULE__), yap, opts)

  @spec capture(GenServer.server(), String.t(), keyword()) :: {:ok, map()} | {:error, term()}
  def capture(server, yap, opts) do
    GenServer.call(server, {:capture, yap, opts}, dispatch_call_timeout_ms())
  end

  @doc """
  Run Shuttle's `accept` / `resume` / `rest` / `seat` writer (`Shuttle.LifecycleService.write/3`)
  inside the Poller, serialized with its state changes, then refresh the
  fiber's document-cache entry so the board reads the transition at once. A
  poll read in flight sees the old document or the new one, whose status and
  `handed_off_at` land in one atomic write.
  """
  @spec lifecycle_transition(GenServer.server(), Shuttle.LifecycleService.verb(), String.t(), [
          String.t()
        ]) ::
          Shuttle.Felt.result()
  def lifecycle_transition(server \\ Shuttle.Env.server(__MODULE__), verb, fiber_id, args \\ []) do
    GenServer.call(
      server,
      {:lifecycle_transition, verb, fiber_id, args},
      dispatch_call_timeout_ms()
    )
  end

  @spec orchestrator_state(GenServer.server(), non_neg_integer()) :: map()
  def orchestrator_state(server, timeout_ms) when is_integer(timeout_ms) and timeout_ms >= 0 do
    GenServer.call(server, :orchestrator_state, timeout_ms)
  end

  @doc """
  Releases the boot quarantine — the human "go" that restores autonomous
  dispatch authority to a restarted daemon. While quarantined, the daemon
  grants no autonomous dispatches of any kind (only explicit force-dispatch
  bypasses); steady-state resume of workers that die while the daemon is
  healthy is unaffected.

  Idempotent. On release the parked set is dropped and a poll tick is
  scheduled immediately, so parked fibers dispatch without waiting out the
  poll interval. Served over HTTP as `POST /api/v1/quarantine/release`.
  """
  @spec release_boot_quarantine() :: :ok
  def release_boot_quarantine, do: release_boot_quarantine(Shuttle.Env.server(__MODULE__))

  @spec release_boot_quarantine(GenServer.server()) :: :ok
  def release_boot_quarantine(server) do
    GenServer.call(server, :release_boot_quarantine)
  end

  # ── Server ──

  @impl true
  def init(opts) do
    sweep_stale_ids_dirs()

    {felt_stores, auto_discover} =
      case Keyword.fetch(opts, :felt_stores) do
        {:ok, hosts} -> {hosts, false}
        :error -> {Shuttle.FeltStores.configured_stores(), true}
      end

    runner = Keyword.get(opts, :runner, Shuttle.Runner.Default)

    own_host_id =
      Keyword.get_lazy(opts, :own_host_id, fn -> resolve_own_host_id(runner: runner) end)

    # Use the registered name (atom) when available so cross-process sends
    # survive a supervisor restart of this Poller. Process.info/2 returns
    # `{:registered_name, atom}` for named processes and `{:registered_name, []}`
    # for unnamed ones (typical in tests started without a `name:` opt; we fall
    # back to self() pid so behavior is unchanged in that case).
    self_ref =
      case Process.info(self(), :registered_name) do
        {:registered_name, name} when is_atom(name) -> name
        _ -> self()
      end

    own_host_id = to_string(own_host_id)

    # Freeze this instance's own_host_id into a persistent_term keyed by
    # its self_ref, so `own_host_id/1`'s public accessor never re-resolves
    # the identity per call — see that function's doc. Keyed
    # per-instance (not one global slot) so distinct named Pollers in the same
    # BEAM (multi-host tests) never stomp on each other's frozen identity.
    :persistent_term.put({@own_host_pt_namespace, self_ref}, own_host_id)

    state = %State{
      self_ref: self_ref,
      poll_interval_ms: Keyword.get(opts, :poll_interval_ms, @default_poll_interval_ms),
      max_concurrent_workers:
        Keyword.get(opts, :max_concurrent_workers, @default_max_concurrent_workers),
      heartbeat_interval_ms:
        Keyword.get(opts, :heartbeat_interval_ms, @default_heartbeat_interval_ms),
      tick_timer_ref: nil,
      tick_token: nil,
      felt_stores: felt_stores,
      own_host_id: own_host_id,
      auto_discover_felt_stores: auto_discover,
      runner: runner,
      full_scan_budget_ms:
        Keyword.get(
          opts,
          :full_scan_budget_ms,
          Shuttle.Env.app(:full_scan_budget_ms, @default_full_scan_budget_ms)
        ),
      full_scan_min_interval_ms:
        Keyword.get(
          opts,
          :full_scan_min_interval_ms,
          Shuttle.Env.app(:full_scan_min_interval_ms, @default_full_scan_min_interval_ms)
        ),
      full_scan_timeout_ms:
        Keyword.get(
          opts,
          :full_scan_timeout_ms,
          Shuttle.Env.app(:full_scan_timeout_ms, @default_full_scan_timeout_ms)
        ),
      stall_timeout_ms:
        Keyword.get(
          opts,
          :stall_timeout_ms,
          Shuttle.Env.app(:stall_timeout_ms, @default_poll_stall_timeout_ms)
        ),
      stall_timeout_base_ms:
        Keyword.get(
          opts,
          :stall_timeout_ms,
          Shuttle.Env.app(:stall_timeout_ms, @default_poll_stall_timeout_ms)
        ),
      # Restart is not dispatch authority: quarantine every autonomous
      # dispatch until a human releases the hold (see the State field
      # comment). Opt wins over app config so tests can exercise the
      # quarantine per-poller; the default lives in @default_boot_quarantine.
      boot_quarantine:
        Keyword.get(
          opts,
          :boot_quarantine,
          Shuttle.Env.app(:boot_quarantine, @default_boot_quarantine)
        ),
      # Boot-time version handshake: probe ONCE here, before the first
      # tick, so a skewed CLI is caught (and fresh dispatch held) before any
      # autonomous work is even considered. Runner-bounded, so a slow/wedged
      # `shuttle` degrades to a logged skew rather than hanging boot.
      contract_check: Shuttle.Contract.check_and_log(runner),
      # Where this daemon records its OWN liveness, and how often — the evidence
      # the next boot reads to tell a fast bounce (a kernel rlimit kill nobody
      # asked for, respawned seconds later) from a real gap. Nothing to do with
      # `heartbeat_interval_ms` above, which is WorkerWatcher's per-worker
      # backend probe; `Shuttle.DaemonHeartbeat` owns this cadence and the
      # freshness grace it must stay well under. Both opts are test injection
      # points.
      daemon_heartbeat_file:
        Keyword.get(opts, :daemon_heartbeat_file, DaemonHeartbeat.default_path()),
      daemon_heartbeat_interval_ms:
        Keyword.get(
          opts,
          :daemon_heartbeat_interval_ms,
          DaemonHeartbeat.default_write_interval_ms()
        ),
      daemon_booted_at: System.system_time(:millisecond),
      quarantine_auto_release:
        Keyword.get_lazy(opts, :quarantine_auto_release, &Shuttle.Host.quarantine_auto_release?/0)
    }

    Logger.info("configured felt stores: #{inspect(felt_stores)}")

    # Read the PREVIOUS incarnation's heartbeat before this one overwrites it —
    # the only evidence that distinguishes a fast bounce from a real gap.
    previous_heartbeat = DaemonHeartbeat.read(state.daemon_heartbeat_file)

    # Daemon state is derived and disposable. Rebuild
    # `running` from tmux by adopting any live shuttle sessions — a restart
    # re-scans tmux and is immediately correct, and running work survives because
    # tmux owns the worker process.
    state = SessionReconciliation.adopt_orphans(state)

    # Adoption has run, so `state.running` is this daemon's OWN observation of
    # what is live — which is what the continuity condition is checked against.
    state = maybe_auto_release_boot_quarantine(state, previous_heartbeat)

    # Carry the previous ring forward with this boot appended, then write
    # immediately: an incarnation that dies seconds in still leaves its own
    # `booted_at`, which is what lets the next boot see a crash loop.
    boots =
      case previous_heartbeat do
        {:ok, hb} -> DaemonHeartbeat.push_boot(hb["boots"] || [], state.daemon_booted_at)
        {:error, _} -> [state.daemon_booted_at]
      end

    state = write_daemon_heartbeat(%{state | daemon_boots: boots})

    state = schedule_tick(state, 0)
    {:ok, state}
  end

  # Auto-release: the one non-human exit from the boot quarantine, for the
  # restart the daemon can PROVE was a fast bounce of a healthy incarnation (see
  # the `boot_quarantine` State field comment and `Shuttle.DaemonHeartbeat`).
  #
  # A contract skew is NOT auto-releasable: it has no release endpoint by design,
  # because a skewed CLI makes every shelled write suspect, so the daemon does
  # not even ask for a verdict — the hold stands until the pair is fixed and the
  # daemon restarted. Nothing here touches `contract_check`, so even a released
  # quarantine keeps parking fresh launches while skewed.
  defp maybe_auto_release_boot_quarantine(%State{boot_quarantine: false} = state, _hb), do: state

  defp maybe_auto_release_boot_quarantine(%State{quarantine_auto_release: false} = state, _hb) do
    Logger.info(
      "boot quarantine held: automatic release is off for this host " <>
        "(host.json \"quarantine_auto_release\")"
    )

    state
  end

  defp maybe_auto_release_boot_quarantine(%State{adopted?: false} = state, _hb) do
    Logger.info("boot quarantine held: boot adoption has not established the live workers")
    state
  end

  defp maybe_auto_release_boot_quarantine(%State{contract_check: %{ok: false}} = state, _hb) do
    Logger.info("boot quarantine held: contract skew is not auto-releasable")
    state
  end

  defp maybe_auto_release_boot_quarantine(%State{} = state, heartbeat) do
    observed = %{
      now_ms: System.system_time(:millisecond),
      live: Map.keys(state.running),
      host: state.own_host_id,
      node: DaemonHeartbeat.node_name(),
      os_pid: System.pid(),
      app:
        for(
          {key, meta} <- state.running,
          Shuttle.AppWorkers.app?(Map.get(meta, :session)),
          do: key
        ),
      machine_booted_at_ms: DaemonHeartbeat.machine_booted_at_ms(),
      stopped_at_s: DaemonHeartbeat.stopped_at_s(state.daemon_heartbeat_file)
    }

    case DaemonHeartbeat.verdict(heartbeat, observed) do
      {:release, reason} ->
        Logger.info("boot quarantine auto-released (#{reason}); fresh dispatch resumes")

        %{state | boot_quarantine: false, parked_launches: %{}}

      {:hold, reason} ->
        Logger.info("boot quarantine held (#{reason}); awaiting `shuttle daemon release`")
        state
    end
  end

  # Record this incarnation's liveness. Best-effort by contract — the write runs
  # in a linked writer and never raises, so a misbehaving filesystem costs the
  # next boot its evidence (holding the quarantine, the safe direction) and
  # never stalls the Poller. A tick whose previous writer is still alive skips,
  # so writers never pile up behind a stalled filesystem.
  defp write_daemon_heartbeat(%State{daemon_heartbeat_writer: pid} = state)
       when is_pid(pid) do
    if Process.alive?(pid),
      do: schedule_daemon_heartbeat(state),
      else: write_daemon_heartbeat(%{state | daemon_heartbeat_writer: nil})
  end

  defp write_daemon_heartbeat(%State{} = state) do
    state |> record_daemon_heartbeat() |> schedule_daemon_heartbeat()
  end

  # One write, no rescheduling — for the tick above and for the moment a hold
  # comes off, so a hard kill seconds after a human release is not judged by a
  # record that still says "held". `held` covers a contract skew too: fresh work
  # parked behind a skew is as unreleased as work parked behind the quarantine.
  defp record_daemon_heartbeat(%State{} = state) do
    pid =
      DaemonHeartbeat.write_async(state.daemon_heartbeat_file,
        booted_at: state.daemon_booted_at,
        host: state.own_host_id,
        node: DaemonHeartbeat.node_name(),
        held: state.boot_quarantine or not state.contract_check.ok,
        os_pid: System.pid(),
        workers: Map.keys(state.running),
        boots: state.daemon_boots
      )

    %{state | daemon_heartbeat_writer: pid}
  end

  defp schedule_daemon_heartbeat(%State{daemon_heartbeat_interval_ms: interval} = state)
       when is_integer(interval) and interval > 0 do
    Process.send_after(self(), :write_daemon_heartbeat, interval)
    state
  end

  defp schedule_daemon_heartbeat(state), do: state

  @impl true
  # Zombie-watcher prevention: `Shuttle.WatcherSupervisor` is a GLOBAL,
  # application-scoped `DynamicSupervisor` — a watcher this Poller instance
  # started under it is NOT automatically stopped when this Poller stops (a
  # test's `start_supervised!`, `restart: :temporary`, ExUnit's on_exit
  # teardown; equally a production restart). Left running, it keeps firing
  # its heartbeat timer against a `poller:` name that's no longer registered
  # (the "poller ... not registered" warning) and keeps shelling its Runner
  # every interval — in tests, that Runner is the shared per-file MockRunner
  # Agent, so a zombie watcher from an EARLIER test competes for that Agent's
  # mailbox with whatever test is CURRENTLY running, occasionally pushing a
  # `wait_until`/`assert_eventually` ceiling past its bound under load. Stop
  # every watcher this instance tracked in `running` — same cleanup
  # `handle_worker_exit`/`remove_running` do per-entry, just for all of them
  # at once on the way out.
  def terminate(_reason, %State{} = state) do
    stop_poll_task(state.poll_task_pid)
    Enum.each(state.running, fn {_runtime_key, meta} -> stop_watcher(meta) end)
    :ok
  end

  @impl true
  def handle_info({:tick, tick_token}, %{tick_token: tick_token} = state)
      when is_reference(tick_token) do
    state = %{
      state
      | tick_timer_ref: nil,
        tick_token: nil
    }

    :ok = schedule_poll_cycle()
    {:noreply, state}
  end

  def handle_info({:tick, _}, state), do: {:noreply, state}

  # The daemon's own liveness tick. Deliberately its own timer rather than a
  # rider on the poll cycle: a poll can stall for minutes behind a wedged felt
  # read (the read runs in a Task, so this GenServer stays responsive), and what
  # the next boot needs to know is that THIS process was alive and serving, which
  # is exactly what handling this message proves.
  def handle_info(:write_daemon_heartbeat, state) do
    {:noreply, write_daemon_heartbeat(state)}
  end

  def handle_info(:run_poll_cycle, %{poll_check_in_progress: true} = state), do: {:noreply, state}

  def handle_info(:run_poll_cycle, state) do
    parent = self()
    poll_token = make_ref()
    state = %{state | stall_timeout_ms: state.stall_timeout_base_ms}

    # The Task does only the slow, READ-ONLY work (felt-store walk + remote
    # SSH discovery) and returns plain data — never a `%State{}`, never a
    # mutation, never an armed timer. Keeping the slow I/O off the GenServer
    # thread preserves daemon responsiveness; making it pure means there is
    # only one mutable state (the GenServer's), so there is nothing to merge
    # when the Task completes. See `poll_reads/1` and `apply_poll_cycle/2`.
    case start_poll_plan_task(parent, poll_token, state) do
      {:ok, task_pid} ->
        stall_timer_ref =
          Process.send_after(self(), {:poll_stalled, poll_token}, state.stall_timeout_ms)

        {:noreply,
         %{
           state
           | poll_check_in_progress: true,
             poll_token: poll_token,
             poll_task_pid: task_pid,
             poll_stall_timer_ref: stall_timer_ref
         }}

      {:error, reason} ->
        Logger.error("Could not start poll task: #{inspect(reason)}")
        {:noreply, schedule_tick(state, state.poll_interval_ms)}
    end
  end

  def handle_info(
        {:poll_plan, poll_token, result},
        %{poll_check_in_progress: true, poll_token: poll_token} = state
      ) do
    case result do
      {:ok, stores} ->
        if stores != state.felt_stores do
          Logger.info(
            "felt_stores updated from env/config: #{inspect(state.felt_stores)} → #{inspect(stores)}"
          )
        end

        read_state = %{state | felt_stores: stores}
        stall_timeout_ms = poll_stall_timeout(read_state)
        read_state = %{read_state | stall_timeout_ms: stall_timeout_ms}
        state = cancel_poll_stall_timer(state)

        case start_poll_read_task(self(), poll_token, read_state) do
          {:ok, task_pid} ->
            timer_ref = Process.send_after(self(), {:poll_stalled, poll_token}, stall_timeout_ms)

            {:noreply,
             %{
               state
               | poll_task_pid: task_pid,
                 stall_timeout_ms: stall_timeout_ms,
                 poll_stall_timer_ref: timer_ref
             }}

          {:error, reason} ->
            Logger.error("Could not start poll task: #{inspect(reason)}")

            state =
              state
              |> Map.put(:poll_check_in_progress, false)
              |> Map.put(:poll_token, nil)
              |> Map.put(:poll_task_pid, nil)
              |> schedule_tick(state.poll_interval_ms)

            {:noreply, state}
        end

      {:error, reason} ->
        Logger.error("Could not prepare poll cycle: #{inspect(reason)}")

        state =
          state
          |> cancel_poll_stall_timer()
          |> Map.put(:poll_check_in_progress, false)
          |> Map.put(:poll_token, nil)
          |> Map.put(:poll_task_pid, nil)
          |> schedule_tick(state.poll_interval_ms)

        {:noreply, state}
    end
  end

  # The poll Task finished its reads. Apply the world it observed to the
  # GenServer's CURRENT state — anything that changed during the Task (a sync
  # :dispatch, a claim, a :worker_exited) is already reflected
  # and is simply respected by the re-validating apply, never clobbered by a
  # stale snapshot.
  def handle_info(
        {:poll_world, poll_token, result},
        %{poll_check_in_progress: true, poll_token: poll_token} = state
      ) do
    applied =
      case result do
        {:ok, world} ->
          state |> cancel_poll_stall_timer() |> apply_poll_cycle(world)

        {:error, reason} ->
          Logger.error("Poll cycle failed: #{reason}")
          cancel_poll_stall_timer(state)
      end

    state =
      applied
      |> Map.put(:poll_check_in_progress, false)
      |> Map.put(:poll_token, nil)
      |> Map.put(:poll_task_pid, nil)
      |> Map.update!(:poll_cycles, &(&1 + 1))
      |> schedule_tick(state.poll_interval_ms)

    {:noreply, state}
  end

  # A slow read no longer owns the poller's clock forever. Reap its supervised,
  # unlinked task first, then advance with a fresh token. The token fence below
  # still matters for a result that crossed the mailbox boundary at the same
  # instant as the watchdog.
  def handle_info(
        {:poll_stalled, poll_token},
        %{poll_check_in_progress: true, poll_token: poll_token} = state
      ) do
    Logger.error("Poll cycle stalled after #{state.stall_timeout_ms}ms; advancing poller")

    state =
      state
      |> stop_poll_task()
      |> Map.put(:poll_check_in_progress, false)
      |> Map.put(:poll_token, nil)
      |> Map.put(:poll_stall_timer_ref, nil)
      |> Map.update!(:poll_stalls, &(&1 + 1))
      |> Map.put(:last_poll_stalled_at, DateTime.utc_now())
      |> schedule_tick(state.poll_interval_ms)

    {:noreply, state}
  end

  # Replies from an abandoned cycle (including a timer or task message racing
  # the next cycle) are inert. Matching the token is the single-flight fence;
  # without it, a late world could overwrite current state and re-arm the tick.
  def handle_info({:poll_plan, _poll_token, _result}, state), do: {:noreply, state}
  def handle_info({:poll_world, _poll_token, _result}, state), do: {:noreply, state}
  def handle_info({:poll_stalled, _poll_token}, state), do: {:noreply, state}

  def handle_info({:worker_exited, fiber_id, watcher, session, _reason}, state) do
    case running_worker(state, fiber_id) do
      %{pid: ^watcher, session: ^session} -> {:noreply, handle_worker_exit(state, fiber_id)}
      _ -> {:noreply, state}
    end
  end

  def handle_info({:app_worker_missing, fiber_id, session}, state) do
    case running_key(state, fiber_id) do
      nil ->
        {:noreply, state}

      key ->
        meta = Map.fetch!(state.running, key)

        if meta.session == session do
          error =
            "The app conversation no longer exists. Start a new session or stop this worker."

          meta = Map.merge(meta, %{state: "blocked", launch_error: error})
          {:noreply, %{state | running: Map.put(state.running, key, meta)}}
        else
          {:noreply, state}
        end
    end
  end

  def handle_info(msg, state) do
    Logger.debug("Poller ignored message: #{inspect(msg)}")
    {:noreply, state}
  end

  @impl true
  def handle_call(:snapshot, _from, state) do
    {:reply, add_poll_health(Snapshot.build_snapshot(state), state), state}
  end

  def handle_call(:parked_index, _from, state) do
    {:reply, Snapshot.parked_index(state.parked_launches), state}
  end

  def handle_call({:cached_fiber_documents, opts}, _from, state) do
    # Serve-from-cache-ALWAYS: this reply is a pure read of GenServer state, so
    # it never blocks on the filesystem. A cold cache (before the first poll
    # warms it) returns an empty feed with `cache.state == "cold"` rather than an
    # error — the request path stays microsecond-fast on a slow filesystem and
    # the viewer renders "warming" from the metadata instead of falling through
    # to a live `felt ls` that could stall 5-12s on an overloaded login node.
    #
    # Owner-only kanban feed: the document cache holds every shuttle fiber
    # PHYSICALLY ROOTED in a configured store, which includes fibers pinned to
    # another host's `shuttle.host:`. The feed serves strictly this daemon's
    # owned rows (the same predicate the direct FiberDocuments path applies), so
    # a viewer reading us as a remote origin gets only what we own — no
    # peer-mirror rows to merge or elect.
    #
    # `owner_feed_base/1` memoizes the filter+sort against `document_cache`'s own
    # identity, so a request reuses it in O(1) whenever `document_cache` hasn't
    # changed since the last request. Only the cheap runtime overlay
    # (`stamp_runtime/2`, a no-op when nothing is running) runs fresh every time.
    {entries, state} =
      if state.document_cache_ready do
        {base, state} = owner_feed_base(state)
        {stamp_runtime(base, state.running), state}
      else
        # Log once per cold period, not once per (5s-cadence) request.
        state =
          if state.cold_feed_logged do
            state
          else
            Logger.info("owner feed served from COLD document cache (poll not yet warmed)")
            %{state | cold_feed_logged: true}
          end

        {[], state}
      end

    stores = Keyword.get(opts, :felt_stores, state.felt_stores)
    cache_meta = document_cache_meta(state)
    {:reply, {:ok, Shuttle.FiberDocuments.envelope(stores, entries, cache_meta)}, state}
  end

  def handle_call({:refresh_document, fiber_id}, _from, state) do
    # A cold cache means no poll has populated it yet; the first poll will read
    # disk fresh, so there is nothing to patch. Once warm, re-read this one fiber.
    if state.document_cache_ready do
      {:reply, :ok, refresh_document_entry(state, fiber_id)}
    else
      {:reply, :ok, state}
    end
  end

  def handle_call({:session_uuid, fiber_id}, _from, state) do
    worker = running_worker(state, fiber_id)
    {:reply, worker_session_uuid(worker, cached_fiber(state, fiber_id)), state}
  end

  def handle_call({:live_worker, fiber_id}, _from, state) do
    reply =
      case running_worker(state, fiber_id) do
        nil ->
          nil

        worker ->
          id = Map.get(worker, :fiber_id) || fiber_id

          fiber =
            case fetch_fiber_full(id, state) do
              {:ok, fiber} -> fiber
              {:error, _} -> cached_fiber(state, id)
            end

          %{
            session: worker.session,
            session_uuid: worker_session_uuid(worker, fiber),
            cli: fiber && get_in(fiber, ["shuttle", "resolved", "agent", "cli"])
          }
      end

    {:reply, reply, state}
  end

  def handle_call({:worker_status, fiber_id}, _from, state) do
    # `running_worker` resolves a uid or slug input through `running_key`'s scan.
    {:reply, running_worker(state, fiber_id), state}
  end

  def handle_call({:claim_session, fiber_id, tmux_session, opts}, _from, state) do
    {runtime_key, slug} = resolve_identity(state, fiber_id)
    uid = resolved_uid(state, slug, runtime_key)

    {state, reply} =
      if Keyword.get(opts, :surface) == "app" do
        do_claim_app_session(state, slug, uid, Keyword.get(opts, :session_uuid), opts)
      else
        do_claim_session(state, slug, uid, tmux_session, opts)
      end

    {:reply, reply, state}
  end

  def handle_call({:kill_session, fiber_id}, _from, state) do
    {reply, state} = stop_tracked_worker(state, fiber_id)
    {:reply, reply, state}
  end

  def handle_call({:capture, yap, opts}, _from, state) do
    felt_store = Keyword.get(opts, :felt_store) || List.first(state.felt_stores)

    # Guard rather than fetch!: a malformed call (or no configured store) must
    # fail the request, not crash the Poller (and its in-memory running map).
    work_dir = Keyword.get(opts, :work_dir)

    cond do
      not (is_binary(work_dir) and work_dir != "") ->
        {:reply, {:error, :work_dir_required}, state}

      not is_binary(felt_store) ->
        {:reply, {:error, :no_felt_stores}, state}

      true ->
        result =
          Dispatcher.capture(yap,
            runner: state.runner,
            work_dir: work_dir,
            felt_store: felt_store,
            agent: Keyword.get(opts, :agent),
            effort: Keyword.get(opts, :effort),
            chrome: Keyword.get(opts, :chrome) == true,
            surface: Keyword.get(opts, :surface),
            host: state.own_host_id,
            meeting: Keyword.get(opts, :meeting)
          )

        {:reply, result, state}
    end
  end

  def handle_call({:dispatch, fiber_id, opts}, _from, state) do
    {runtime_key, fiber_id} = resolve_identity(state, fiber_id)
    state = reconcile_running_fiber(state, fiber_id)
    uid = resolved_uid(state, fiber_id, runtime_key)

    # Every check, and the fiber's arm, before any session is cut.
    case prepare_forced_start(state, fiber_id, runtime_key, uid, opts) do
      {:ok, state} -> dispatch_prepared(state, fiber_id, runtime_key, uid, opts)
      {:error, reason, state} -> {:reply, {:error, reason}, state}
    end
  end

  def handle_call({:lifecycle_transition, verb, fiber_id, args}, _from, state) do
    {_runtime_key, slug} = resolve_identity(state, fiber_id)

    result =
      LifecycleService.write(verb, slug,
        runner: state.runner,
        felt_store: owning_store(slug, state),
        args: args
      )

    # A rest disarms first (the write above lands `status: open` before any
    # stop), then stops the worker, so its exit cannot be read as a reason to
    # relaunch. A failed stop is reported; the document is already at rest.
    {result, state} =
      case {verb, result} do
        {:rest, {:ok, output}} ->
          case stop_tracked_worker(state, slug) do
            {{:ok, :no_session}, state} -> {{:ok, output}, state}
            {{:ok, session}, state} -> {{:ok, output <> "  worker: stopped #{session}\n"}, state}
            {{:error, reason}, state} -> {{:error, reason}, state}
          end

        _ ->
          {result, state}
      end

    state =
      case result do
        {:ok, _} when state.document_cache_ready -> refresh_document_entry(state, slug)
        _ -> state
      end

    {:reply, result, state}
  end

  def handle_call(:orchestrator_state, _from, state) do
    {:reply, add_poll_health(Snapshot.build_full_state(state), state), state}
  end

  def handle_call(:release_boot_quarantine, _from, %{boot_quarantine: false} = state) do
    {:reply, :ok, state}
  end

  def handle_call(:release_boot_quarantine, _from, state) do
    Logger.info("boot quarantine released; fresh dispatch resumes on the next tick")
    state = record_daemon_heartbeat(%{state | boot_quarantine: false, parked_launches: %{}})

    # Tick now so parked fibers dispatch immediately, not a poll interval later.
    {:reply, :ok, schedule_tick(state, 0)}
  end

  # ── Snapshot ──

  @doc false
  def runtime_key_for_fiber(fiber) when is_map(fiber) do
    fiber_id = fiber_address(fiber)
    metadata_uid(fiber) || fiber_id
  end

  @doc false
  # Record `runtime_key` as "observed running under this daemon's uptime." The
  # single seam that maintains `state.was_running`; called at every insertion
  # into `state.running` (boot adoption, per-poll adoption, dispatch, claim).
  # Membership is durable — never removed on exit — so the boot-quarantine gate
  # auto-resumes in-flight work while still parking genuinely-fresh launches.
  # Runtime-observation, never on-disk markers.
  #
  # Also drops any `parked_launches` entry for the key: a fiber that just entered
  # `running` (force-dispatch or claim, not only the poll's own re-dispatch) is
  # no longer held, so the board's `held` indicator clears the instant the worker
  # exists rather than lingering — co-rendered with the "aloft" pill — until the
  # next poll rebuilds the parked map. Same key-space (`parked_launches` is keyed
  # by `runtime_key`), so this keeps held ⟺ not-running synchronous.
  def note_running(%State{} = state, runtime_key) do
    %{
      state
      | was_running: MapSet.put(state.was_running, runtime_key),
        parked_launches: Map.delete(state.parked_launches, runtime_key)
    }
  end

  # Resolve any public identifier (a uid from the UI, a slug from the CLI) to
  # `{runtime_key, slug}`: the runtime key is what `running`/`claimed`/
  # `dispatch_failures` are keyed by (uid when the fiber has one, else slug),
  # and the slug is felt's address for I/O. Resolution order, each step cheaper
  # than a felt shell-out before it:
  #   1. the running registry (`running_key`'s scan) — a live fiber answers from
  #      its own metadata;
  #   2. the poll-refreshed `uid_slug_index` — a uid-shaped input maps to its
  #      slug with an O(1) hit (the kanban hot path), no felt walk;
  #   3. `FeltStores.resolve_fiber/2` — the cold-miss fallback only (a uid not
  #      seen since the last poll, or a slug input). Falls back to
  #      `{identifier, identifier}` — the input as-is — when felt can't resolve.
  # This is the single uid↔slug seam; felt stays slug-addressed throughout.
  defp resolve_identity(%State{} = state, identifier) when is_binary(identifier) do
    case running_key(state, identifier) do
      nil ->
        case Map.get(state.uid_slug_index, identifier) do
          slug when is_binary(slug) ->
            {identifier, slug}

          _ ->
            case Shuttle.FeltStores.resolve_fiber(identifier, state.felt_stores) do
              {:ok, %{uid: uid, fiber_id: slug}} when is_binary(uid) and uid != "" -> {uid, slug}
              {:ok, %{fiber_id: slug}} -> {slug, slug}
              _ -> {identifier, identifier}
            end
        end

      runtime_key ->
        {runtime_key, fiber_address(Map.get(state.running, runtime_key))}
    end
  end

  # Builds the boundary uid→slug resolution index from the poll's candidates.
  # Every candidate row carries both its slug `id` and intrinsic `uid`. A
  # felt-I/O resolution aid ONLY — runtime state stays keyed by uid.
  defp build_uid_slug_index(candidates) do
    Enum.reduce(candidates, %{}, fn fiber, acc ->
      case {Map.get(fiber, "uid"), Map.get(fiber, "id")} do
        {uid, slug} when is_binary(uid) and uid != "" and is_binary(slug) and slug != "" ->
          Map.put(acc, uid, slug)

        _ ->
          acc
      end
    end)
  end

  # Where felt reads each polled UID: its listing store and traversal id.
  defp polled_addresses(candidates, store_map) do
    for %{"uid" => uid, "id" => id} <- candidates,
        is_binary(uid) and uid != "" and is_binary(id),
        store = Map.get(store_map, id),
        is_binary(store),
        into: %{},
        do: {uid, {store, id}}
  end

  @doc false
  def fiber_address(metadata) when is_map(metadata) do
    case Map.get(metadata, :fiber_id) || Map.get(metadata, "fiber_id") ||
           Map.get(metadata, "id") || Map.get(metadata, :id) do
      fiber_id when is_binary(fiber_id) and fiber_id != "" -> fiber_id
      _ -> ""
    end
  end

  @doc false
  def running_key(%State{} = state, fiber_id) when is_binary(fiber_id) do
    if Map.has_key?(state.running, fiber_id) do
      fiber_id
    else
      Enum.find_value(state.running, fn {key, metadata} ->
        if fiber_id in [fiber_address(metadata), metadata_uid(metadata)], do: key
      end)
    end
  end

  def running_key(_, _), do: nil

  # An app worker is addressed by its conversation id; any other worker by the
  # harness session the daemon stamped on the fiber.
  defp worker_session_uuid(worker, fiber) do
    (worker && Shuttle.AppWorkers.id(worker.session)) ||
      case fiber && get_in(fiber, ["shuttle", "runtime", "session_uuid"]) do
        value when is_binary(value) and value != "" -> value
        _ -> nil
      end
  end

  defp cached_fiber(%State{} = state, fiber_id) do
    Enum.find_value(state.document_cache, fn {_key, %{entry: entry}} ->
      fiber = Map.get(entry, :fiber, %{})
      if fiber_id in [Map.get(fiber, "id"), Map.get(fiber, "uid")], do: fiber
    end)
  end

  defp running_worker(%State{} = state, fiber_id) do
    case running_key(state, fiber_id) do
      nil -> nil
      key -> Map.get(state.running, key)
    end
  end

  @doc false
  def metadata_uid(metadata) when is_map(metadata) do
    case {Map.get(metadata, :uid), Map.get(metadata, "uid")} do
      {uid, _} when is_binary(uid) and uid != "" -> uid
      {_, uid} when is_binary(uid) and uid != "" -> uid
      _ -> nil
    end
  end

  def metadata_uid(_), do: nil

  # ── Dispatch ──

  # READ-ONLY poll work, run inside the poll Task. Walks felt stores (local +
  # remote over SSH) to discover candidate fibers; returns plain data. It never
  # mutates state, runs an effect, or arms a timer — so there is nothing to
  # merge back when it completes (`apply_poll_cycle/2` does the mutating work on
  # the live GenServer). The rescue/catch turns a felt/SSH explosion into a
  # logged `{:error, _}` rather than a crash that would take the linked poller
  # down with the Task.
  defp poll_reads(%State{} = state) do
    {candidates, store_map, store_listings, full_listings, discovery} =
      discover_candidates(state)

    # The poll-cycle document cache lives in `Shuttle.Poller.DocumentCache`; the
    # cache itself stays on `State`. Entries are built directly from the candidate
    # rows the poll already discovered — one `shuttle ls` per store, no per-miss
    # `felt show` and no filesystem stat.
    {refresh_us, {document_cache, document_cache_stats}} =
      :timer.tc(fn -> Shuttle.Poller.DocumentCache.refresh(state, candidates, store_map) end)

    {:ok,
     %{
       felt_stores: state.felt_stores,
       candidates: candidates,
       store_map: store_map,
       store_listings: store_listings,
       full_listings: full_listings,
       discovery: discovery,
       document_cache: document_cache,
       document_cache_stats: document_cache_stats,
       document_cache_refresh_ms: div(refresh_us, 1000)
     }}
  rescue
    error ->
      {:error, Exception.format(:error, error, __STACKTRACE__)}
  catch
    kind, reason ->
      {:error, Exception.format(kind, reason, __STACKTRACE__)}
  end

  # Apply an observed `world` (from `poll_reads/1`) to the GenServer's CURRENT
  # state. This is the only place the poll cycle reconciles and dispatches, and
  # it runs on the live GenServer process — so anything that changed during the
  # Task's read is reflected in `state` and respected here, never overwritten
  # from a stale snapshot. Reconcile runs against the current `running`, not
  # the Task's snapshot.
  defp apply_poll_cycle(%State{} = state, %{
         felt_stores: felt_stores,
         candidates: candidates,
         store_map: new_store_map,
         store_listings: store_listings,
         full_listings: full_listings,
         discovery: discovery,
         document_cache: document_cache,
         document_cache_stats: document_cache_stats,
         document_cache_refresh_ms: document_cache_refresh_ms
       }) do
    log_discovery_mode_changes(state.discovery, discovery)
    log_document_cache_refresh(state, document_cache_stats, document_cache_refresh_ms)

    # The Task built `document_cache` from a PRE-mutation snapshot. A
    # `{:refresh_document, …}` patch that landed on the live cache mid-poll must
    # NOT be reverted by installing the Task build wholesale: merge per key,
    # preferring the live entry when its `modified_at` is strictly newer. Only
    # keys the Task build carries survive — a fiber the Task evicted (deleted /
    # uninstalled) is not resurrected.
    document_cache = merge_document_cache(state.document_cache, document_cache)

    # A partial tick — at least one store's listing FAILED (its rows came from
    # `last_known_listings`) — reports `cache.state == "partial"` and does NOT
    # advance `refreshed_at`, so staleness stays honest for the failed store.
    listings_ok? = map_size(store_listings) == length(felt_stores)

    refreshed_at =
      if listings_ok?, do: DateTime.utc_now(), else: state.document_cache_refreshed_at

    # One tmux + process scan per cycle, shared by orphan adoption and the
    # dead-standing-role pass below.
    sessions = list_shuttle_sessions(state)

    state = %{
      state
      | felt_stores: felt_stores,
        last_known_listings:
          state.last_known_listings |> Map.merge(store_listings) |> Map.take(felt_stores),
        last_full_listings:
          state.last_full_listings |> Map.merge(full_listings) |> Map.take(felt_stores),
        discovery: discovery
    }

    state = reconcile(state, sessions)

    standing_roles = StandingRoles.standing_roles_from_candidates(candidates)
    Shuttle.FiberAddresses.put_polled(polled_addresses(candidates, new_store_map))

    # Merge newly resolved store entries into the cache. Existing entries
    # are not evicted — earlier-configured stores win for ID collisions,
    # and cache entries are stable for the daemon's lifetime.
    state = %{
      state
      | fiber_store_cache: Map.merge(new_store_map, state.fiber_store_cache),
        # Rebuilt (not merged) each poll so a rename or delete can't leave a
        # stale uid→slug entry; an as-yet-unseen uid falls through to felt.
        uid_slug_index: build_uid_slug_index(candidates),
        document_cache: document_cache,
        document_cache_stats: document_cache_stats,
        document_cache_ready: true,
        document_cache_refreshed_at: refreshed_at,
        document_cache_last_refresh_ms: document_cache_refresh_ms,
        document_cache_partial: not listings_ok?,
        # Ready is (re)established this tick: re-arm the cold-serve log guard so a
        # future cold period (only reachable in tests) logs once again.
        cold_feed_logged: false,
        standing_roles: standing_roles,
        dispatch_failures: evict_stale_by_candidates(state.dispatch_failures, candidates),
        resume_loop: evict_stale_by_candidates(state.resume_loop, candidates)
    }

    # Downtime recovery: a standing constitution whose tmux session is gone but whose
    # document is still armed (status:active, no verdict) never fired
    # `handle_worker_exit` (the daemon was down across the exit). Mark such
    # roles awaiting (status:closed) so the armed document does not re-fire.
    # Oneshots need no analog: a status:active oneshot with no live session is
    # simply eligible again on the next tick — retries collapsed into the poll
    # loop.
    state = StandingRoles.reconcile_dead_standing_roles(state, candidates, sessions)

    # Parking is dispatch-authority bookkeeping, not capacity accounting: while
    # quarantined, the parked map is rebuilt from the current dispatchable set
    # on EVERY cycle (a closed fiber drops out, a newly-active one appears)
    # even when the slots are full — only actual dispatching is slot-gated.
    # The eligibility sweep runs only when its result is consumed: to park
    # (quarantine) or to dispatch (free slots).
    {dispatchable, state} =
      cond do
        state.boot_quarantine or not state.contract_check.ok ->
          # Splits the dispatchable set by `was_running`: in-flight work this
          # daemon observed running (adopted at boot / dispatched since)
          # re-dispatches through the reduce below, while genuinely-fresh
          # launches are parked. A just-restarted daemon grants NO fresh
          # autonomous dispatch until a human releases the hold, but never
          # strands work that was demonstrably alive moments ago. A CLI/daemon
          # contract skew rides the SAME gate: every shelled write is
          # suspect, so fresh launches are held the same way, but read-only
          # polling and already-observed resumes stay alive. Unlike boot
          # quarantine, skew has no release endpoint — a restart (after the
          # skew is actually fixed) is what re-probes and clears it.
          candidates
          |> filter_eligible(state)
          |> sort_candidates()
          |> park_autonomous_launches(state)

        available_slots(state) > 0 ->
          {candidates |> filter_eligible(state) |> sort_candidates(),
           %{state | parked_launches: %{}}}

        true ->
          # Slots full, no quarantine: nothing to park, nothing to dispatch.
          {[], %{state | parked_launches: %{}}}
      end

    # Two fibers sharing a project_dir both survive the eligibility sweep (it is
    # pure — it never looks at the filesystem), so the project_dir check runs
    # inside `do_dispatch_fiber/3`, once per fiber actually being dispatched.
    # Both may take the same checkout: workers sharing a project_dir is
    # allowed, and shuttle has no opinion about it.
    Enum.reduce(dispatchable, state, fn fiber, state_acc ->
      if available_slots(state_acc) <= 0 do
        state_acc
      else
        {new_state, _result} = do_dispatch_fiber(state_acc, fiber)
        new_state
      end
    end)
  end

  # ── Orphan Resurrection ──

  # Drops dispatch_failures / resume_loop entries for fibers shuttle no longer
  # intends to dispatch — closed, paused (status not in {open, active}), shuttle
  # block removed, or absent from the felt store entirely. Without this, the
  # `blocked` snapshot would carry stale entries the user has no remaining
  # handle on, and a config fix or pause would not clear a paused resume loop
  # without waiting out the cooldown. Active fibers with persistent failures
  # keep their entry across cycles so the kanban can show the failure count.
  #
  # Entries are keyed by runtime key and kept only under the candidate's
  # CURRENT key, so an entry recorded under a fiber's slug is dropped once the
  # fiber gains a uid (a `:uid_missing` refusal cleared by `felt backfill-ids`).
  defp evict_stale_by_candidates(map, candidates) do
    active_keys =
      candidates
      |> Enum.filter(fn fiber -> Map.get(fiber, "status") in ["open", "active"] end)
      |> Enum.map(&runtime_key_for_fiber/1)
      |> MapSet.new()

    Map.filter(map, fn {key, _entry} -> MapSet.member?(active_keys, key) end)
  end

  # Discovers candidate fibers by asking Shuttle for a narrow fiber projection
  # per configured store and keeping the ones physically rooted in that store.
  # No tag predicate — the shuttle: block is the source of truth, matching the
  # same contract every other surface reads.
  #
  # Returns {fibers, store_map, store_listings, full_listings, discovery} where:
  #   fibers        — [%{"id" => id, "uid" => uid, "status" => status, "path" => …}] across all stores
  #   store_map     — %{fiber_id => felt_store} for store resolution
  #   store_listings — %{store => rows} for stores successfully listed this poll.
  #                   Hot listings are merged with retained rows; full listings
  #                   replace them. A failed store is absent.
  #   full_listings — %{store => rows} only for successful full scans; this is
  #                   the fixed source for future hot-set ids.
  #   discovery     — updated per-store mode and full-scan cadence, returned as
  #                   plain data for `apply_poll_cycle/2` to install.
  #
  # Each fiber row carries its own "uid", so callers that need the intrinsic
  # identity read it off the candidate directly — no separate uid map.
  #
  # ## Symlink discipline
  #
  # The same physical fiber file is often reachable from multiple felt stores via
  # symlinks. Two cases that occur in practice:
  #
  # 1. A project store (`~/work/project-a`) whose `.felt/` is a symlink into
  #    `~/loom/.felt/work/project-a/`. The same `task-board.md` is reachable as
  #    `task-board` (project view) and `work/project-a/task-board` (loom view).
  #
  # 2. A project-canonical felt store (lightcone) whose own `.felt/` is a real
  #    directory, with loom symlinking *into* it at
  #    `~/loom/.felt/ai-futures/lightcone -> ~/lightcone/.felt`. The same fiber
  #    is reachable as `lightcone-ui/...` (lightcone view) and
  #    `ai-futures/lightcone/lightcone-ui/...` (loom view).
  #
  # If both views were enumerated, dispatch would race: each "different" id
  # passes `tmux has-session` independently → multiple workers on one file.
  #
  # **Rule: a fiber is enumerated only by the store where it is physically
  # rooted.** `list_shuttle_fibers/2` enforces this by reading felt's carried
  # `path` (absolute, symlink-resolved) and keeping a fiber iff that path lives
  # under `realpath(store)/.felt/` — so case 2's loom view drops the fiber (its
  # realpath roots in lightcone) and the lightcone store claims it. A store
  # whose own `.felt/` is a symlink (case 1) owns nothing; the target store
  # enumerates it. Ownership is read from felt's path, never reverse-derived.
  @doc false
  def discover_candidates(state) do
    {all_fibers, store_map, store_listings, full_listings, discovery} =
      Enum.reduce(state.felt_stores, {[], %{}, %{}, %{}, %{}}, fn store,
                                                                  {all, stores, listings, fulls,
                                                                   modes} ->
        previous = Map.get(state.discovery, store, %{})
        now = System.system_time(:millisecond)
        full? = full_scan_due?(previous, state, now)
        started = System.monotonic_time(:millisecond)
        hot_ids = hot_ids_for_store(store, previous, state)

        result =
          if full?,
            do: list_shuttle_fibers(store, state, nil, state.full_scan_timeout_ms),
            else: list_shuttle_fibers(store, state, hot_ids, nil)

        duration = System.monotonic_time(:millisecond) - started
        retained = Map.get(state.last_known_listings, store, [])

        {rows, next_listings, next_fulls, info} =
          case result do
            {:ok, %{rows: listed, foreign_ids: foreign_ids}} ->
              merged = if full?, do: listed, else: merge_hot_rows(retained, listed, foreign_ids)

              next_info =
                if full? do
                  due =
                    if duration > state.full_scan_budget_ms,
                      do: now + max(state.full_scan_min_interval_ms, 5 * duration),
                      else: nil

                  %{
                    mode: if(is_nil(due), do: :full, else: :hot),
                    last_full_duration_ms: duration,
                    last_full_completed_at: now + duration,
                    next_full_due_at: due,
                    last_full_timed_out: false
                  }
                else
                  previous
                  |> Map.delete(:boot_seeded)
                  |> Map.put(
                    :mode,
                    if(Map.get(previous, :boot_seeded, false),
                      do: Map.get(previous, :mode, :full),
                      else: :hot
                    )
                  )
                end

              next_fulls = if full?, do: Map.put(fulls, store, shuttle_rows(listed)), else: fulls
              {merged, Map.put(listings, store, merged), next_fulls, next_info}

            {:error, reason} ->
              Logger.warning(
                "fiber discovery failed for #{store} (#{inspect(reason)}); " <>
                  "carrying #{length(retained)} last-known fiber(s) for this tick"
              )

              next_info =
                if full? and reason == :timeout do
                  %{
                    mode: :hot,
                    last_full_duration_ms: duration,
                    last_full_completed_at: Map.get(previous, :last_full_completed_at),
                    next_full_due_at:
                      now + max(state.full_scan_min_interval_ms, 5 * max(duration, 1)),
                    last_full_timed_out: true
                  }
                else
                  Map.delete(previous, :boot_seeded)
                end

              {retained, listings, fulls, next_info}
          end

        baseline = Map.get(next_fulls, store, Map.get(state.last_full_listings, store, []))
        info = Map.put(info, :hot_size, length(baseline))
        stores = Map.merge(Map.new(rows, &{&1["id"], store}), stores)
        {all ++ rows, stores, next_listings, next_fulls, Map.put(modes, store, info)}
      end)

    {all_fibers, store_map, store_listings, full_listings, discovery}
  end

  @doc false
  def boot_discover_candidates(%State{} = state) do
    Enum.reduce(state.felt_stores, state, fn store, acc ->
      if Map.has_key?(acc.last_full_listings, store) do
        acc
      else
        now = System.system_time(:millisecond)
        started = System.monotonic_time(:millisecond)
        result = list_shuttle_fibers(store, acc, nil, nil)
        duration = System.monotonic_time(:millisecond) - started

        case result do
          {:ok, %{rows: rows}} ->
            due =
              if duration > acc.full_scan_budget_ms,
                do: now + max(acc.full_scan_min_interval_ms, 5 * duration),
                else: nil

            info = %{
              mode: if(is_nil(due), do: :full, else: :hot),
              last_full_duration_ms: duration,
              last_full_completed_at: now + duration,
              next_full_due_at: due,
              last_full_timed_out: false,
              hot_size: length(shuttle_rows(rows)),
              boot_seeded: true
            }

            %{
              acc
              | last_known_listings: Map.put(acc.last_known_listings, store, rows),
                last_full_listings: Map.put(acc.last_full_listings, store, shuttle_rows(rows)),
                discovery: Map.put(acc.discovery, store, info)
            }

          {:error, :timeout} ->
            info = %{
              mode: :hot,
              last_full_duration_ms: duration,
              last_full_completed_at: nil,
              next_full_due_at: now,
              last_full_timed_out: true,
              hot_size: length(Map.get(acc.last_known_listings, store, []))
            }

            %{acc | discovery: Map.put(acc.discovery, store, info)}

          {:error, _reason} ->
            acc
        end
      end
    end)
  end

  defp log_discovery_mode_changes(previous, current) do
    Enum.each(current, fn {store, info} ->
      old_mode = get_in(previous, [store, :mode]) || :full
      new_mode = Map.get(info, :mode, :full)

      if old_mode != new_mode do
        Logger.info("fiber discovery mode for #{store}: #{new_mode}")
      end
    end)
  end

  defp poll_stall_timeout(state) do
    cmd_timeout_ms = Shuttle.Env.app(:cmd_timeout_ms, 60_000)
    now = System.system_time(:millisecond)

    planned_ms =
      Enum.reduce(state.felt_stores, 0, fn store, total ->
        if full_scan_due?(Map.get(state.discovery, store, %{}), state, now) do
          total + 3 * state.full_scan_timeout_ms
        else
          total + cmd_timeout_ms
        end
      end)

    max(state.stall_timeout_base_ms, planned_ms + @poll_stall_margin_ms)
  end

  defp full_scan_due?(previous, state, now) do
    due = Map.get(previous, :next_full_due_at)

    cond do
      Map.get(previous, :boot_seeded, false) -> false
      is_nil(Map.get(previous, :last_full_duration_ms)) -> true
      Map.get(previous, :last_full_timed_out, false) -> is_nil(due) or now >= due
      Map.get(previous, :last_full_duration_ms) <= state.full_scan_budget_ms -> true
      true -> is_nil(due) or now >= due
    end
  end

  defp shuttle_rows(rows), do: Enum.filter(rows, &is_map(Map.get(&1, "shuttle")))

  defp hot_ids_for_store(store, _previous, state) do
    state.last_full_listings
    |> Map.get(store, [])
    |> Enum.map(&Map.get(&1, "id"))
    |> Enum.filter(&is_binary/1)
    |> Enum.uniq()
  end

  defp merge_hot_rows(previous, listed, foreign_ids) do
    returned_ids = MapSet.new(listed, &Map.get(&1, "id"))

    returned_uids =
      listed |> Enum.map(&Map.get(&1, "uid")) |> Enum.reject(&is_nil/1) |> MapSet.new()

    foreign_ids = MapSet.new(foreign_ids)

    retained =
      Enum.reject(previous, fn row ->
        MapSet.member?(returned_ids, Map.get(row, "id")) or
          MapSet.member?(foreign_ids, Map.get(row, "id")) or
          (not is_nil(Map.get(row, "uid")) and
             MapSet.member?(returned_uids, Map.get(row, "uid")))
      end)

    Map.new(retained ++ listed, &{Map.get(&1, "id"), &1}) |> Map.values()
  end

  # Owner-only feed gate for a cached document entry: keep it iff its
  # `shuttle.host` equals this daemon's `own_host_id`. The same `host_owned?`
  # predicate the dispatch plane uses, so the feed and dispatch agree on the
  # single owner of each fiber.
  #
  # The host-less kinds the aux walks admit (`due:` cards, `cycle` fibers) have
  # no `shuttle.host:` to compare, so they pass on the property that admitted
  # them instead. They are local by construction — every candidate row cleared
  # `owned_by_store?` against a configured store — and there is no peer daemon
  # that could also claim them, so no cross-host election is being skipped here.
  # A fiber WITH a shuttle block pinned elsewhere still fails: the aux clause
  # widens admission for kinds that have no owner, never for work that has one —
  # `kanban_aux_admissible?/1` checks `shuttle.host` is absent before it looks at
  # `due:`/`cycle` at all. Without it, a synced loom puts every foreign-host
  # constitution that carries a `due:` into this daemon's feed, where the board
  # collapses it onto the local mirror and loses its worker and write routing.
  defp owned_feed_entry?(%{fiber: %{"shuttle" => shuttle} = fiber}, own_host_id)
       when is_map(shuttle) and map_size(shuttle) > 0 do
    host_owned?(shuttle, own_host_id) or Shuttle.FiberDocuments.kanban_aux_admissible?(fiber)
  end

  defp owned_feed_entry?(%{fiber: fiber}, _own_host_id),
    do: Shuttle.FiberDocuments.kanban_aux_admissible?(fiber)

  defp owned_feed_entry?(_, _), do: false

  # The owner-feed's filter+sort, memoized against `document_cache`'s identity.
  # A cache hit (`document_cache` unchanged since the last call) is a plain
  # equality check against the stored term — cheap, and BEAM short-circuits it
  # on pointer equality before ever attempting a structural comparison, so an
  # unchanged multi-hundred-entry cache costs this check nothing close to
  # re-deriving it. A miss (poll cycle landed, `refresh_document/2` patched one
  # fiber, or anything else replaced `document_cache`) recomputes once and
  # re-memoizes — there is no separate derived field for a mutation path to
  # forget to update.
  defp owner_feed_base(%State{owner_feed_cache: {cache, base}, document_cache: cache} = state) do
    {base, state}
  end

  defp owner_feed_base(%State{document_cache: document_cache, own_host_id: own_host_id} = state) do
    base =
      document_cache
      |> Map.values()
      |> Enum.map(& &1.entry)
      |> Enum.filter(&owned_feed_entry?(&1, own_host_id))
      |> Enum.sort_by(&get_in(&1, [:fiber, "id"]))

    {base, %{state | owner_feed_cache: {document_cache, base}}}
  end

  # The owner-feed envelope's `cache` metadata block: the freshness signal a
  # viewer renders instead of a binary up/down. `state` is "cold" until the
  # first poll warms the cache, then "fresh" — or "partial" when this tick built
  # the cache with at least one store served from last-known rows (a listing
  # failure). `refreshed_at` reflects the last ALL-stores-fresh tick. The
  # snapshot's `document_cache` block carries the same fields.
  @doc false
  def document_cache_meta(%State{} = state) do
    %{
      state: document_cache_state(state),
      refreshed_at: iso8601_or_nil(state.document_cache_refreshed_at),
      entries: map_size(state.document_cache),
      last_refresh_ms: state.document_cache_last_refresh_ms
    }
  end

  defp document_cache_state(%State{document_cache_ready: false}), do: "cold"
  defp document_cache_state(%State{document_cache_partial: true}), do: "partial"
  defp document_cache_state(_state), do: "fresh"

  defp iso8601_or_nil(%DateTime{} = dt), do: DateTime.to_iso8601(dt)
  defp iso8601_or_nil(_), do: nil

  # Merge the Task-built cache over the live cache, preferring a live entry whose
  # `modified_at` is strictly newer (a mid-poll `refresh_document` patch that the
  # Task's pre-mutation snapshot could not see). Only keys the Task build carries
  # are kept — a fiber the Task evicted (deleted / uninstalled) is not
  # resurrected from the live cache.
  defp merge_document_cache(live, task_built) do
    Map.new(task_built, fn {key, task_entry} ->
      case Map.get(live, key) do
        %{modified_at: live_mt} = live_entry when is_binary(live_mt) ->
          if modified_after?(live_mt, Map.get(task_entry, :modified_at)),
            do: {key, live_entry},
            else: {key, task_entry}

        _ ->
          {key, task_entry}
      end
    end)
  end

  # Strictly-newer comparison of two ISO8601 mtimes. Parses both so mixed offsets
  # compare correctly; if either is unparseable, prefer the live patch on any
  # difference (it is the more recent disk read).
  defp modified_after?(live_mt, task_mt) do
    with {:ok, live_dt, _} <- DateTime.from_iso8601(live_mt),
         true <- is_binary(task_mt),
         {:ok, task_dt, _} <- DateTime.from_iso8601(task_mt) do
      DateTime.compare(live_dt, task_dt) == :gt
    else
      _ -> live_mt != task_mt
    end
  end

  # Stamp serve-time tmux liveness onto each owned feed row. The owner is the
  # only daemon that knows its own running workers (`state.running`), so it
  # carries that truth on the same `/api/v1/fibers` rows a viewer already reads
  # — closing the cross-host read plane: a remote viewer renders `▸ aloft` for
  # this fiber exactly when we run a live worker for it.
  #
  # This is COMPUTED at serve time from the in-memory watcher registry, never
  # persisted to the document (the no-daemon-state-on-the-fiber invariant holds:
  # `:runtime` is a wire field on the served envelope row, not frontmatter). The
  # join keys by `uid` (rename-safe) — `state.running` is keyed by the fiber's
  # runtime_key (uid when present), and we also index by the meta's address so a
  # uid-less fiber still matches. A row with no live worker carries no `:runtime`.
  defp stamp_runtime(entries, running) when map_size(running) == 0, do: entries

  defp stamp_runtime(entries, running) do
    # `activity` is the `session => %{last_event_at, phase}` map derived from
    # this host's events.jsonl — the real last-activity timestamp and phase
    # category ("attention" / "waiting" / "working") of each tracked session.
    # Only running workers get stamped, so a session that signals and then dies
    # never leaves a stale runtime — it's already gone from `running`.
    activity = session_activity()
    index = Snapshot.runtime_index(running, activity)
    Enum.map(entries, &Snapshot.put_runtime(&1, index))
  end

  # The activity source. Defaults to the host-local event stream; overridable
  # via app env so tests inject a deterministic `session => %{last_event_at,
  # phase}` map without writing to the real events.jsonl.
  defp session_activity do
    case Shuttle.Env.app(:waiting_phases_source) do
      fun when is_function(fun, 0) -> fun.()
      _ -> Shuttle.EventStream.session_activity()
    end
  end

  defp refresh_document_entry(%State{} = state, fiber_id) do
    # A document's `id` is the fiber's uid, so a slug-addressed refresh matches
    # on the carried `slug` too.
    without_fiber =
      :maps.filter(
        fn _key, %{entry: entry} ->
          fiber = Map.get(entry, :fiber, %{})
          fiber_id not in [Map.get(fiber, "id"), Map.get(fiber, "uid"), Map.get(fiber, "slug")]
        end,
        state.document_cache
      )

    case Shuttle.FiberDocuments.get_shuttle(fiber_id, felt_stores: state.felt_stores) do
      {:ok, %{fibers: [entry | _]}} ->
        fiber = Map.get(entry, :fiber, %{})
        key = Shuttle.Poller.DocumentCache.cache_key(fiber)
        cached = %{modified_at: Map.get(fiber, "modified_at"), entry: entry}
        %{state | document_cache: Map.put(without_fiber, key, cached)}

      {:ok, %{fibers: []}} ->
        # Fiber no longer resolves (uninstalled / deleted): drop it from the feed.
        %{state | document_cache: without_fiber}

      {:error, reason} ->
        Logger.warning("refresh_document #{fiber_id} skipped: #{inspect(reason)}")
        state
    end
  end

  # One :info line per refresh: store count, entry/hit/miss counts, rebuild
  # duration, and the cold→fresh transition (the pre-update `state` still reads
  # cold on the warming tick). This is the operator's window into the owner-feed
  # cache without shelling into the daemon.
  defp log_document_cache_refresh(%State{} = state, stats, refresh_ms) do
    transition = if state.document_cache_ready, do: "", else: " cold→fresh"

    Logger.info(
      "document cache refresh#{transition}: stores=#{length(state.felt_stores)} " <>
        "entries=#{Map.get(stats, :entries, 0)} hits=#{Map.get(stats, :hits, 0)} " <>
        "misses=#{Map.get(stats, :misses, 0)} refresh_ms=#{refresh_ms}"
    )
  end

  # Read one store's shuttle fibers via Shuttle's JSON, keeping only those
  # PHYSICALLY ROOTED in this store. Ownership is read from felt's carried
  # `path` (absolute, symlink-resolved) — a fiber belongs to `store` iff its
  # path lives under `realpath(store)/.felt/`. felt enumerates symlink-traversed
  # fibers too (loom listing a project whose `.felt` is symlinked in), so the
  # path-prefix check is what keeps each fiber owned by exactly the store that
  # physically roots it, read from the CLI response, never reverse-derived. A store
  # whose own `.felt/` is a symlink owns nothing here: the target store
  # enumerates it canonically.
  defp list_shuttle_fibers(store, state, ids_from, timeout_ms) do
    felt_dir = Path.join(store, ".felt")

    case File.lstat(felt_dir) do
      {:ok, %File.Stat{type: :symlink}} ->
        {:ok, %{rows: [], foreign_ids: []}}

      {:ok, %File.Stat{type: :directory}} ->
        # An empty store has nothing to enumerate; skip the Shuttle shell-out so a
        # store with no fibers costs nothing (and so a daemon polling an empty
        # configured store doesn't shell Shuttle every tick).
        if empty_dir?(felt_dir) do
          {:ok, %{rows: [], foreign_ids: []}}
        else
          run_shuttle_listing(store, state, ids_from, timeout_ms)
        end

      _ ->
        {:ok, %{rows: [], foreign_ids: []}}
    end
  end

  defp empty_dir?(dir) do
    case File.ls(dir) do
      {:ok, entries} -> entries == []
      _ -> true
    end
  end

  defp run_shuttle_listing(store, state, ids_from, timeout_ms) do
    case run_shuttle_ls_for_shuttle(store, state, ids_from, timeout_ms) do
      {:ok, output} ->
        with {:ok, fibers} when is_list(fibers) <- Jason.decode(output) do
          owned_prefix = Shuttle.FeltStores.store_felt_realpath(store) <> "/"

          # Per-row isolation: Shuttle skips and warns on unparseable fibers
          # (warning on stderr, valid JSON of the rest on stdout, exit 0), so a
          # single malformed fiber never poisons the blob. The `is_map/1` guard
          # is the same posture on our side of the wire — one non-map row is
          # dropped, never the whole store's listing.
          shuttle_rows = Enum.filter(fibers, &(is_map(&1) and is_map(Map.get(&1, "shuttle"))))

          kept = Enum.filter(shuttle_rows, &owned_by_store?(&1, owned_prefix))

          foreign_ids =
            shuttle_rows
            |> Enum.filter(fn row ->
              is_binary(Map.get(row, "path")) and not owned_by_store?(row, owned_prefix)
            end)
            |> Enum.map(&Map.get(&1, "id"))
            |> Enum.filter(&is_binary/1)

          aux =
            if is_nil(ids_from),
              do: aux_rows(store, state, owned_prefix, timeout_ms),
              else: []

          {:ok,
           %{
             rows: Shuttle.FiberDocuments.union_by_id(kept, aux),
             foreign_ids: foreign_ids
           }}
        else
          _ -> {:error, :invalid_json}
        end

      {:error, reason} ->
        {:error, reason}
    end
  end

  # A fiber is owned by this store iff the carried physical `path` lives under
  # `realpath(store)/.felt/`. Without a path, ownership cannot be confirmed, so
  # the fiber is conservatively dropped.
  defp owned_by_store?(%{"path" => path}, owned_prefix) when is_binary(path) and path != "" do
    String.starts_with?(path, owned_prefix)
  end

  defp owned_by_store?(_, _), do: false

  # The non-`shuttle:` half of the kanban's admitted set: human `due:` cards and
  # `cycle` fibers, neither of which carries a `shuttle:` block and so neither of
  # which the primary walk has ever seen. One `felt ls` per aux filter (felt's
  # `--has-field` is AND, not OR — see `FiberDocuments.kanban_walks/0`), same
  # projection, same store-ownership gate as the primary rows.
  #
  # Fails SOFT, per walk: an aux filter that errors or times out logs and
  # contributes nothing, leaving the primary listing — and therefore every
  # dispatchable fiber — untouched. Only the primary walk can fail a store.
  defp aux_rows(store, state, owned_prefix, timeout_ms) do
    [_primary | aux] = Shuttle.FiberDocuments.kanban_walks()
    Enum.flat_map(aux, &aux_walk_rows(store, state, owned_prefix, &1, timeout_ms))
  end

  defp aux_walk_rows(store, state, owned_prefix, filter, timeout_ms) do
    fields = Enum.join(Shuttle.FiberDocuments.kanban_fields(), ",")
    args = ["ls", "--json"] ++ filter ++ ["--json-field", fields]

    opts = if timeout_ms, do: [timeout_ms: timeout_ms], else: []

    with {:ok, output} <- run_felt(store, state.runner, args, opts),
         {:ok, rows} when is_list(rows) <- Jason.decode(output) do
      Enum.filter(rows, &(is_map(&1) and owned_by_store?(&1, owned_prefix)))
    else
      error ->
        Logger.warning(
          "kanban aux walk #{inspect(filter)} failed for #{store}: #{inspect(error)}"
        )

        []
    end
  end

  defp run_shuttle_ls_for_shuttle(store, state, ids_from, timeout_ms) do
    # Widened projection: shuttle filters by raw top-level frontmatter first,
    # then emits the FULL kanban field set (`FiberDocuments.kanban_fields/0` — a
    # superset of the fields the poller needs for eligibility, ownership, and
    # identity). Widening it lets the document cache build each entry DIRECTLY
    # from its candidate row (no per-miss `show`, no stat), so a poll tick costs
    # one `shuttle ls` per store. A failure degrades `discover_candidates/1` to
    # the store's last-known rows; the boot contract probe checks CLI parity.
    args = [
      "ls",
      "--json",
      "--has-field",
      "shuttle",
      "--json-field",
      Enum.join(Shuttle.FiberDocuments.kanban_fields(), ",")
    ]

    with_ids_file(ids_from, fn ids_path ->
      args = if ids_path, do: args ++ ["--ids-from", ids_path], else: args
      opts = if timeout_ms, do: [timeout_ms: timeout_ms], else: []
      run_shuttle(store, state.runner, args, opts)
    end)
  end

  # The autonomous-tick eligibility filter: the shared `eligible?` predicate,
  # uniform across kinds. Force-dispatch bypasses it entirely.
  defp filter_eligible(candidates, state) do
    Enum.filter(candidates, &eligible?(&1, state))
  end

  # Boot quarantine gate on the autonomous tick (see the State field comment):
  # a just-restarted daemon grants no *fresh* autonomous dispatch, but never
  # strands in-flight work it observed running, and never holds a due standing
  # role (cron is the human's pre-given "go"; see the split below). Splits the dispatchable set by
  # `was_running` (runtime keys this daemon saw alive under its own uptime —
  # adopted at boot, or dispatched/claimed since):
  #
  #   - Members re-dispatch: they are the sanctioned continuation of work that
  #     was demonstrably alive moments ago, so they flow out as the returned
  #     dispatchable list and the reduce launches them (resume-vs-fresh is
  #     `Dispatcher.check_resume_intent/2`'s). Once running they leave the
  #     candidate set, so there is no repeated dispatch.
  #   - Non-members park into `parked_launches` for the snapshot's
  #     `pending_launch` rows (and the board's `held` indicator).
  #
  # The predicate is runtime-observation, never on-disk markers: classifying on
  # cached `dispatched_at`/`handed_off_at` rows would let a stale dirty-death
  # row slip the gate and dispatch FRESH. A fiber the daemon never saw running
  # is parked no matter what its markers say. The parked map is rebuilt from the
  # current fresh set each cycle (a fiber that closes/pauses/reclassifies as
  # was-running drops out on its own); `parked_at` is preserved for fibers that
  # stay parked. Only this tick path is gated: the explicit `{:dispatch, …}` call
  # (kanban force-dispatch, claim) never routes here. Called only while
  # quarantined OR contract-skewed (`apply_poll_cycle`'s cond clears the
  # parked map on the other branches).
  defp park_autonomous_launches(dispatchable, %State{} = state) do
    now = DateTime.utc_now()

    # A due standing constitution also flows through the boot quarantine: its cron
    # occurrence is a fixed-time authorization the human already gave, and a
    # restart that happens to straddle 09:00 must not silently eat the run
    # (the schedule is bounded — one occurrence, never a stale backlog).
    # Contract skew is the exception: there every shelled write is suspect,
    # so the role holds like everything else until a restart clears it.
    {resume, fresh} =
      Enum.split_with(dispatchable, fn fiber ->
        MapSet.member?(state.was_running, runtime_key_for_fiber(fiber)) or
          (state.contract_check.ok and StandingRoles.standing_role_due?(fiber))
      end)

    parked =
      Map.new(fresh, fn fiber ->
        key = runtime_key_for_fiber(fiber)

        {key,
         Map.get(state.parked_launches, key) ||
           %{fiber_id: fiber_address(fiber), uid: metadata_uid(fiber), parked_at: now}}
      end)

    {resume, %{state | parked_launches: parked}}
  end

  # Does this constitution's worker exit close it to awaiting-review? Only a
  # STANDING (cron-driven) one does. Marking it awaiting on exit is an
  # anti-re-fire gate — `status: closed` is what stops the cron from
  # re-dispatching it again this cycle.
  defp standing?(fiber), do: fiber_kind(fiber) == "standing"

  # PURE — fiber frontmatter and in-memory runtime maps only. Every gate that
  # needs the filesystem (only one: does the project_dir exist) lives in
  # `do_dispatch_fiber/3`, which runs only for a fiber that is actually being
  # dispatched. That is the whole TCC story: a project_dir
  # hosted in a macOS file provider (iCloud Drive, `~/Library/CloudStorage`)
  # raises an un-grantable "access data from other apps" prompt on every touch,
  # so a fiber the poller merely LOOKS at each tick must never be touched at
  # all — however many ticks it sits there, parked, closed, or refused.
  defp eligible?(fiber, state) do
    shuttle = Map.get(fiber, "shuttle")
    status = Map.get(fiber, "status", "")
    fiber_id = Map.get(fiber, "id", "")

    cond do
      # Must target this daemon. Exactly `block.host == own_host_id`; an
      # absent host is unowned and ineligible everywhere (no wildcard, no
      # "local" default).
      not host_owned?(shuttle, state.own_host_id) ->
        false

      # `status: active` is the SOLE dispatch gate. A fiber is shuttle-managed
      # iff it carries a shuttle: block;
      # it dispatches iff status is active. `open` is a draft/paused (not
      # dispatched); `closed` is the awaiting-review / anti-oscillation gate —
      # a oneshot terminus, or a standing constitution that ran this cycle and is
      # `status: closed` + untempered pending a human verdict. Re-arming is an
      # explicit accept that writes `status: active`. This keeps tempered
      # fibers from ever oscillating back to dispatching on a later poll (the
      # citation-audit-skill tempered-never-reverts invariant).
      status != "active" ->
        false

      tracked?(state, fiber_id, runtime_key_for_fiber(fiber)) ->
        false

      # Resume-loop circuit breaker is open: this fiber's workers keep dying
      # almost immediately, so autonomous re-dispatch is paused for a cooldown
      # (it surfaces as `blocked`). A human force-dispatch bypasses eligible?
      # entirely and clears the breaker; a healthy run clears it on exit.
      resume_loop_open?(state, runtime_key_for_fiber(fiber)) ->
        false

      # A dispatch preflight refused this fiber recently — its agent's wrapper
      # does not resolve in a login bash, or its work directory is not on this
      # host. Neither changes between ticks, and re-probing costs a fresh
      # `bash -l` every time, so the fiber is parked for a cooldown (it surfaces
      # as `blocked`, carrying the message that names the fix). A force-dispatch
      # bypasses eligible? entirely; a successful dispatch drops the entry.
      preflight_cooldown_open?(state, runtime_key_for_fiber(fiber)) ->
        false

      # Standing constitutions have additional preconditions; a oneshot that reaches
      # here has passed every gate. `depends_on` has no dispatch meaning — it
      # is a board-only ordering annotation ("filed after that"), read solely
      # by the UI fold and by `shuttle check`'s shape validation.
      block_kind(shuttle) == "standing" ->
        StandingRoles.standing_role_due?(fiber)

      true ->
        true
    end
  end

  # Eligibility for an explicit dispatch call (POST /api/v1/dispatch).
  #
  # Two modes, in priority order:
  #
  #   1. `force: true` — manual human-triggered dispatch from the kanban
  #      "New session" / "Resume" buttons. Bypasses every condition except
  #      the one intent *can't* override: the shuttle block must be owned by
  #      this host (no block, or one homed elsewhere, cannot spawn here).
  #      Status, kind, schedule and the breaker cooldowns are all overridden:
  #      closed, draft and not-yet-due fibers dispatch on force. `depends_on`
  #      carries no dispatch meaning at all, forced or not.
  #
  #   2. Default — the full `eligible?` check (host, status, liveness,
  #      breakers, standing schedule).
  #
  # There is no third `ad_hoc`-without-`force` mode: every caller that sets
  # `ad_hoc` also sets `force` (the controller folds `force: force or ad_hoc`,
  # `Shuttle.Transition` passes both), and the autonomous tick reaches
  # `do_dispatch_fiber/2` directly without ever entering this call.
  defp dispatch_eligible?(fiber, state, opts) do
    if Keyword.get(opts, :force, false) do
      force_dispatch_eligible?(fiber, state)
    else
      eligible?(fiber, state)
    end
  end

  # Force-dispatch predicate: only the irreducible requirements. The user
  # explicitly clicked dispatch; honor the intent.
  defp force_dispatch_eligible?(fiber, state) do
    host_owned?(Map.get(fiber, "shuttle"), state.own_host_id)
  end

  # Names WHY a dispatch was refused so the kanban can say something true
  # instead of the catch-all "disabled, not yet due, or closed". The most
  # common confusing case is a remote-homed fiber dispatched against the wrong
  # daemon: a force-dispatch of a `host: <remote>` fiber that reaches any daemon
  # whose `own_host_id` differs fails `host_owned?` and is reported as
  # `:homed_elsewhere`. The reason atoms (`:homed_elsewhere`, `:project_dir_missing`,
  # `:disabled`, `:closed`, `:no_shuttle_block`,
  # `:not_due_or_blocked`) are surfaced to the UI as accurate copy.
  #
  # A fiber parked by a preflight refusal is the other case worth naming: the
  # refusal already knows exactly what is wrong and how to fix it, and reporting
  # "not yet due" instead would send the human to the clock for the length of
  # the cooldown. `remembered_preflight_refusal/2` hands the recorded refusal
  # back verbatim, so an explicit dispatch during the cooldown produces the same
  # 422 (same tag, same message) the autonomous refusal did.
  #
  # Only called on the ineligible branch, so the eligible (dispatch-now) path is
  # untouched. For a force/ad_hoc dispatch the irreducible gate is `force_*`'s;
  # for a plain dispatch the fuller `eligible?` rules apply, so the reason is
  # computed against the same `force` intent the caller passed.
  defp dispatch_ineligible_reason(fiber, state, opts) do
    shuttle = Map.get(fiber, "shuttle")
    status = Map.get(fiber, "status", "")
    forced? = Keyword.get(opts, :force, false)

    # Only for a non-forced dispatch: a force bypasses the cooldown outright
    # (`force_dispatch_eligible?/2`), so it can never be what blocks one.
    remembered = if forced?, do: nil, else: remembered_preflight_refusal(state, fiber)

    cond do
      not is_map(shuttle) ->
        {:not_eligible, :no_shuttle_block}

      not host_owned?(shuttle, state.own_host_id) ->
        {:not_eligible, {:homed_elsewhere, Map.get(shuttle, "host"), state.own_host_id}}

      # These two only gate a NON-forced dispatch (force overrides status): a
      # draft (status: open) or a closed/awaiting fiber is reported so a plain
      # dispatch failure is legible. The one filesystem refusal
      # (`:project_dir_missing`) is not computed here at all — it comes back
      # from the dispatch attempt itself, in this same
      # `{:not_eligible, reason}` shape.
      not forced? and status == "closed" ->
        {:not_eligible, :closed}

      not forced? and status != "active" ->
        {:not_eligible, :disabled}

      remembered != nil ->
        remembered

      true ->
        {:not_eligible, :not_due_or_blocked}
    end
  end

  # The refusal `preflight_cooldown_open?/2` is parking this fiber on, in the
  # shape its own surface already renders:
  #
  #   * the three message-carrying refusals come back as `{tag, message}` —
  #     exactly what `Dispatcher.dispatch/2` returned when it refused, so the
  #     dispatch controller's preflight clause renders the 422 with the tag and
  #     the operator message rather than a flat `not_eligible`
  #   * `:project_dir_missing` carries a path, not a message, and the controller
  #     already renders it as an ineligibility detail, so it keeps that shape
  #
  # `nil` when no cooldown is open, or when the recorded reason is something
  # else (a bare atom like `:watcher_start_failed`) — the caller then falls
  # through to its own reasons.
  defp remembered_preflight_refusal(%State{} = state, fiber) do
    runtime_key = runtime_key_for_fiber(fiber)

    if preflight_cooldown_open?(state, runtime_key) do
      case Map.get(state.dispatch_failures, runtime_key) do
        %{reason: {tag, message}} when Dispatcher.refusal?(tag, message) ->
          {tag, message}

        %{reason: {:project_dir_missing, _dir} = reason} ->
          {:not_eligible, reason}

        _ ->
          nil
      end
    end
  end

  # THE single host-ownership predicate. A fiber is owned by this daemon when
  # its shuttle block carries an explicit `host:` equal to this daemon's
  # `own_host_id`. There is no `nil`-as-wildcard and no `"local"` default: an
  # absent or empty `host:` is unowned everywhere and therefore ineligible on
  # every daemon — loud (the fiber simply never dispatches and the absence is
  # visible in its frontmatter), never silently mis-dispatched on the wrong
  # machine. Every dispatch path (poll, force, standing, orphan-resurrection)
  # routes through this one function. Strict equality: a block is owned by
  # exactly one named host — no `"local"` default, no `nil`-pin wildcard.
  @doc false
  def host_owned?(shuttle, own_host_id) when is_map(shuttle) do
    case Map.get(shuttle, "host") do
      host when is_binary(host) and host != "" -> host == own_host_id
      _ -> false
    end
  end

  def host_owned?(_, _), do: false

  # The declared `project_dir`, expanded. PURE — `Path.expand/1` and nothing
  # else, so it costs nothing to call for any fiber on any tick. Whether the
  # directory EXISTS is `project_dir_for_dispatch/1`'s question, asked once, at
  # the dispatch. An absent/empty project_dir is governed by install-time
  # validation (armed installs must carry one), not re-litigated here.
  defp declared_project_dir(shuttle) when is_map(shuttle) do
    case Map.get(shuttle, "project_dir") do
      dir when is_binary(dir) and dir != "" -> Shuttle.Env.expand(dir)
      _ -> nil
    end
  end

  defp declared_project_dir(_), do: nil

  # ── The project_dir touch ──
  #
  # The place the poller touches `shuttle.project_dir` on disk (with its twin
  # for a human's start, `check_start_directory/3`), and it runs for a fiber
  # that has passed every pure gate and is about to have a worker spawned into
  # that directory. Everything upstream — eligibility,
  # parking, the snapshot — reads frontmatter and runtime maps alone, so a
  # fiber the poller merely LOOKS at each tick is never stat'd, however long it
  # sits there.
  #
  # That is a TCC rule, not an optimization: a project_dir in a macOS file
  # provider (iCloud Drive, `~/Library/CloudStorage`) answers every touch with
  # an "access data from other apps" prompt that cannot be granted to a
  # launchd-run daemon, so the cost of a touch is a dialog on someone's screen,
  # not a syscall. Here the spawn would raise it anyway.
  #
  # Returns `{:ok, work_dir}` — the declared `project_dir` when it exists here,
  # else `nil`, meaning an autonomous worker starts in the fiber's owning felt
  # store (a forced start has already refused a block without one, see
  # `prepare_forced_start/5`). A declared `project_dir` must exist on THIS host:
  # present-but-missing means the checkout lives on another machine, and the
  # dispatch refuses with `:project_dir_missing` rather than downgrading the
  # worker's cwd to a felt store.
  #
  # There is deliberately NO exclusion between workers sharing a checkout: two
  # (or ten) workers may run in one project_dir.
  defp project_dir_for_dispatch(fiber) do
    declared = declared_project_dir(Map.get(fiber, "shuttle"))

    cond do
      is_nil(declared) -> {:ok, nil}
      File.dir?(declared) -> {:ok, declared}
      true -> {:error, {:project_dir_missing, declared}}
    end
  end

  @doc """
  This daemon's `own_host_id` — the identity it advertises for the
  `shuttle.host` dispatch filter. Public so other callers (e.g.
  `ShuttleWeb.FiberController` when stamping a `host:` on a new fiber) share
  the exact same resolution.

  This is the daemon's one source of its host identity. Every surface that
  stamps or matches `shuttle.host` — the dispatch filter, the
  `/api/v1/fibers` owned feed, the `host:` stamp on new fibers, the
  state/snapshot endpoints — goes through here, so a daemon's advertised
  identity is single-valued by construction. Do not derive a hostname
  anywhere else in the daemon: the identity comes from `SHUTTLE_HOST` or from
  `shuttle host --json`, the same resolver the CLI stamps with.

  A pure `:persistent_term` read, never a shell. `server`'s own slot (the
  value its `init/1` froze) wins; otherwise this reads the daemon identity
  `freeze_daemon_host_id!/1` resolved once at application start, before the
  endpoint bound. Post-launch drift (an operator editing `~/.shuttle/host`
  while the daemon runs, a respawn exporting a different `SHUTTLE_HOST`)
  therefore cannot split routing from ownership mid-run.

  `own_host_id/0` targets the default-named `#{inspect(__MODULE__)}` — the
  production singleton every external consumer (controllers, `Shuttle.Kitty`,
  `Shuttle.FiberDocuments`, `Shuttle.OriginRouter`) means by
  "this daemon's identity". `own_host_id/1` targets a specific `server` for
  a test poller started under a different name.
  """
  @spec own_host_id() :: String.t()
  def own_host_id, do: own_host_id(Shuttle.Env.server(__MODULE__))

  @spec own_host_id(GenServer.server()) :: String.t()
  def own_host_id(server) do
    case :persistent_term.get({@own_host_pt_namespace, server}, nil) do
      nil -> daemon_host_id()
      frozen -> frozen
    end
  end

  @doc """
  Resolves this daemon's identity and freezes it for the daemon's life.

  `Shuttle.Application.start/2` calls this once, before any child starts, so
  no request, poll read or per-row feed filter ever shells Shuttle for it; the
  production Poller receives the frozen value as its `:own_host_id`. Raises
  when Shuttle cannot answer: a daemon with no identity would match no
  `shuttle.host` and dispatch nothing, silently, so it does not boot.
  `cli_opts` go to `Shuttle.CLI.run/2`.
  """
  @spec freeze_daemon_host_id!(keyword()) :: String.t()
  def freeze_daemon_host_id!(cli_opts \\ []) do
    id = resolve_own_host_id(cli_opts)
    :persistent_term.put(@daemon_host_key, id)
    id
  end

  @doc """
  The daemon identity frozen at application start. Code running with no
  application (a bare script, a unit test that stopped it) resolves and
  freezes it on first use, so even there Shuttle is asked at most once.
  """
  @spec daemon_host_id() :: String.t()
  def daemon_host_id do
    case :persistent_term.get(@daemon_host_key, nil) do
      nil -> freeze_daemon_host_id!()
      frozen -> frozen
    end
  end

  # `SHUTTLE_HOST` (trimmed) when set — the explicit override and the test
  # seam — else the answer from `shuttle host --json`. Shuttle resolves the host
  # identity and OS-hostname fallback, so the CLI's `host:` stamp and this
  # daemon's dispatch predicate cannot disagree about which machine this is.
  # Runs once per daemon (`freeze_daemon_host_id!/1`) and once per Poller
  # started without an `:own_host_id` opt (test pollers; `init/1` passes its
  # `:runner`).
  #
  # Raises when Shuttle cannot answer: a daemon with no identity would match no
  # `shuttle.host` and dispatch nothing, silently.
  @spec resolve_own_host_id(keyword()) :: String.t()
  defp resolve_own_host_id(cli_opts) do
    case String.trim(Shuttle.Env.get("SHUTTLE_HOST", "")) do
      "" -> shuttle_host_id(cli_opts)
      env -> env
    end
  end

  defp shuttle_host_id(cli_opts) do
    with {:ok, output} <- Shuttle.CLI.run(["host", "--json"], cli_opts),
         {:ok, %{"id" => id}} when is_binary(id) and id != "" <- Jason.decode(output) do
      id
    else
      other ->
        raise "Shuttle.Poller could not resolve own_host_id from `shuttle host --json`: " <>
                "#{inspect(other)}. Set SHUTTLE_HOST=<name> or run `shuttle host seed`."
    end
  end

  # Resolves which configured felt store owns `fiber_id` — the store root used
  # to shell subsequent felt commands.
  #
  # Resolution order:
  # 1. State cache (fast; populated by discover_candidates/1 each poll cycle)
  # 2. Ask felt: `FeltStores.store_for_fiber/2` (against THIS daemon's
  #    `state.felt_stores`) shells `felt show -j` (or a uid scan) and reports the
  #    owning store directly, reading felt's carried path rather than
  #    reconstructing or globbing candidate files.
  #
  # Returns {:ok, store} for the store that owns the fiber, or {:error,
  # :not_found | :timeout} when no configured store claims it.
  #
  # The poll cycle fills the cache from discover_candidates/1's store map; a
  # resolution here is not cached.
  defp store_for_fiber(fiber_id, state) do
    case Map.get(state.fiber_store_cache, fiber_id) do
      store when is_binary(store) -> {:ok, store}
      nil -> Shuttle.FeltStores.store_for_fiber(fiber_id, state.felt_stores)
    end
  end

  # The fiber's owning felt store, falling back to the first configured store
  # when resolution fails (callers need some store to shell Shuttle against).
  defp owning_store(fiber_id, state) do
    case store_for_fiber(fiber_id, state) do
      {:ok, h} -> h
      {:error, _} -> List.first(state.felt_stores)
    end
  end

  # The agent id for snapshot metadata, read off Shuttle's resolved record.
  # Prefers the effective `shuttle.resolved.agent.id`, falls back to the raw
  # `shuttle.agent` name, then `"unknown"` — this is a display/metadata label,
  # never a dispatch decision, so a best-effort label is correct when Shuttle
  # emitted no resolution.
  @doc false
  def agent_id_from_fiber(fiber) when is_map(fiber) do
    get_in(fiber, ["shuttle", "resolved", "agent", "id"]) ||
      get_in(fiber, ["shuttle", "agent"]) || "unknown"
  end

  defp collaboration_snapshot(fiber) do
    case Collaboration.snapshot(fiber) do
      {:ok, snapshot} -> snapshot
      {:error, _} -> nil
    end
  end

  # A fiber's configured agent is an execution recipe. It makes a useful
  # running-card label, but it cannot prove what an external claimant was
  # actually running. Ledger provenance therefore carries only an explicit
  # claimant assertion, or an agent id already persisted by AppWorkers.
  defp explicit_claim_agent(opts) do
    agent_presence(Keyword.get(opts, :agent))
  end

  defp app_claim_agent(id, opts) do
    case Shuttle.AppWorkers.get(id) do
      {:ok, %{"agent_id" => agent}} ->
        agent_presence(agent) || explicit_claim_agent(opts)

      _ ->
        explicit_claim_agent(opts)
    end
  end

  defp agent_presence(agent) when is_binary(agent) do
    if String.trim(agent) == "", do: nil, else: agent
  end

  defp agent_presence(_), do: nil

  # `created_at` is an INSTANT, and the store legitimately holds mixed offsets —
  # a fiber created in Paris reads `+02:00`, the same second in Berkeley reads
  # `-07:00`. String order resolves inside the time field long before it reaches
  # the offset suffix, so comparing the raw strings orders by local wall clock
  # rather than by instant: "2026-07-27T09:00:00-07:00" sorts BELOW
  # "2026-07-27T18:00:00+02:00" though both are 16:00Z. Parse to a comparable
  # instant and compare numerically. This is a comparator fix only — the mixed
  # offsets are correct data that was being read wrongly, so nothing migrates.
  # A missing or unparseable value keeps its previous position (first), then
  # ties break on id, so ordering stays total and deterministic.
  @doc false
  def sort_candidates(candidates) do
    Enum.sort_by(candidates, fn fiber ->
      {created_at_key(Map.get(fiber, "created_at")), Map.get(fiber, "id", "")}
    end)
  end

  defp created_at_key(value) do
    case iso_to_unix_ms(value) do
      ms when is_integer(ms) -> {1, ms}
      _ -> {0, 0}
    end
  end

  # The dispatch once a forced start is prepared: a fresh start cuts any open
  # session, then the worker launches (or a live app turn resumes).
  defp dispatch_prepared(state, fiber_id, runtime_key, uid, opts) do
    # "New session" on an OPEN session is a CUT, not a refusal: a forced fresh
    # dispatch (force + resume_mode:"fresh" — the kanban New-session button and
    # drag-launch) stamps the clean-exit marker, kills the live tmux, and drops
    # the runtime entry, then FALLS THROUGH to the fresh dispatch below instead
    # of bouncing off `:already_running`. See cut_open_session_for_fresh/5.
    state = cut_open_session_for_fresh(state, fiber_id, runtime_key, uid, opts)

    current = running_worker(state, fiber_id)

    cond do
      current != nil and Shuttle.AppWorkers.app?(current.session) and
          Keyword.get(opts, :resume_mode) == "previous" ->
        with {:ok, fiber} <- fetch_fiber_full(fiber_id, state),
             :ok <-
               ensure_app_claim_marker(
                 state,
                 fiber_id,
                 fiber,
                 Shuttle.AppWorkers.id(current.session)
               ),
             {:ok, _} <-
               start_app_turn(
                 current.session,
                 Keyword.get(opts, :user_message) || "Continue the work on fiber #{fiber_id}."
               ) do
          key = running_key(state, fiber_id)
          meta = Map.merge(current, %{state: "running", launch_error: nil})
          {:reply, {:ok, current.session}, %{state | running: Map.put(state.running, key, meta)}}
        else
          error -> {:reply, error, state}
        end

      open_session?(state, fiber_id, runtime_key, uid) ->
        {:reply, {:error, :already_running}, state}

      true ->
        case fetch_fiber_full(fiber_id, state) do
          {:ok, fiber} ->
            if dispatch_eligible?(fiber, state, opts) do
              {new_state, result} = do_dispatch_fiber(state, fiber, opts)
              {:reply, result, new_state}
            else
              {:reply, {:error, dispatch_ineligible_reason(fiber, state, opts)}, state}
            end

          {:error, reason} ->
            {:reply, {:error, reason}, state}
        end
    end
  end

  # ── A forced start: checked, then armed, before anything else happens ──
  #
  # A human's start that will launch a worker (a fresh one, or any start with
  # no live session to resume) runs every check before any session is cut or
  # any document is written, then arms the fiber in a single write:
  #
  #   1. eligibility (host ownership);
  #   2. the directory, which a worker never goes without — a forced start never
  #      runs in the felt store:
  #        * a directory the human confirmed is resolved by
  #          `shuttle resolve-dir`, which expands `$VARS` and `~` as
  #          `--project-dir` does and writes nothing;
  #        * otherwise the block's `project_dir` must be declared and be a
  #          directory on this host;
  #   3. the arm: a confirmed directory rides `shuttle reopen --project-dir
  #      --conclude-run` — the same raw input `resolve-dir` checked, so the CLI
  #      expands it to the same path — which saves it and arms the fiber in one
  #      write, concluding a standing constitution's run as the re-arm below does, so a
  #      start refused after the write leaves it armed. Without one, a closed
  #      or paused standing constitution is re-armed (`LifecycleStore.rearm`)
  #      and a closed
  #      oneshot reopened (`shuttle reopen`).
  #
  # A refusal is `{:arm_refused, %{message, needs}}`. `needs: "project_dir"` is
  # set only from the directory checks in step 2, which the daemon made itself;
  # a refused arm write carries the CLI's own words and asks for nothing.
  #
  # The fiber the dispatch then reads is fetched afresh, so the worker's cwd is
  # the `project_dir` the CLI saved.
  defp prepare_forced_start(%State{} = state, fiber_id, runtime_key, uid, opts) do
    launches? =
      Keyword.get(opts, :force, false) and
        (Keyword.get(opts, :resume_mode) == "fresh" or
           not open_session?(state, fiber_id, runtime_key, uid))

    if launches? do
      case fetch_fiber_full(fiber_id, state) do
        {:ok, fiber} ->
          result =
            with :ok <- forced_eligibility(fiber, state, opts),
                 {:ok, directory} <- check_start_directory(state, fiber, opts) do
              arm_start(state, fiber, directory)
            end

          case result do
            :ok ->
              {:ok, state}

            {:error, {:arm_refused, _} = reason} ->
              {:error, reason, record_dispatch_failure(state, fiber, reason)}

            {:error, reason} ->
              {:error, reason, state}
          end

        {:error, reason} ->
          {:error, reason, state}
      end
    else
      {:ok, state}
    end
  end

  defp forced_eligibility(fiber, state, opts) do
    if dispatch_eligible?(fiber, state, opts),
      do: :ok,
      else: {:error, dispatch_ineligible_reason(fiber, state, opts)}
  end

  defp check_start_directory(state, fiber, opts) do
    fiber_id = Map.get(fiber, "id", "")

    case Keyword.get(opts, :project_dir) do
      raw when is_binary(raw) ->
        case Shuttle.CLI.run(["resolve-dir", raw], runner: state.runner) do
          {:ok, _resolved} ->
            {:ok, {:confirmed, raw}}

          {:command_error, code, output} ->
            arm_refused(
              fiber_id,
              cli_text(output, "`shuttle resolve-dir` exited #{code}"),
              "project_dir"
            )

          {:error, reason} ->
            arm_refused(fiber_id, "`shuttle resolve-dir` could not run: #{inspect(reason)}", nil)
        end

      nil ->
        case declared_project_dir(Map.get(fiber, "shuttle")) do
          nil ->
            arm_refused(
              fiber_id,
              "#{fiber_id} has no project_dir in its shuttle: block, and a worker never " <>
                "starts in the felt store. Choose the directory it works in.",
              "project_dir"
            )

          dir ->
            if File.dir?(dir),
              do: {:ok, :declared},
              else:
                arm_refused(
                  fiber_id,
                  "#{fiber_id}'s project_dir #{dir} is not a directory on this host.",
                  "project_dir"
                )
        end
    end
  end

  # The raw input, not `resolve-dir`'s answer: the CLI expands it the same way
  # both times, so the directory checked is the directory saved.
  defp arm_start(state, fiber, {:confirmed, raw}),
    do: cli_reopen(state, Map.get(fiber, "id", ""), ["--project-dir", raw, "--conclude-run"])

  defp arm_start(state, fiber, :declared) do
    fiber_id = Map.get(fiber, "id", "")
    status = Map.get(fiber, "status")

    cond do
      status == "active" ->
        :ok

      fiber_kind(fiber) == "standing" ->
        rearm_standing(state, fiber_id)

      status == "closed" ->
        cli_reopen(state, fiber_id, [])

      # A oneshot draft: the dispatcher's best-effort reopen moves its card.
      true ->
        :ok
    end
  end

  # Re-arm a closed or paused standing constitution so the board's start both
  # spawns it now and leaves it armed for its schedule. A failed re-arm is
  # logged and the start proceeds.
  defp rearm_standing(state, fiber_id) do
    case LifecycleStore.rearm(fiber_id, runner: state.runner, felt_stores: state.felt_stores) do
      {:ok, msg} -> Logger.info("force-dispatch re-arm #{fiber_id}: #{String.trim(msg)}")
      {:error, reason} -> Logger.warning("force-dispatch re-arm #{fiber_id} failed: #{reason}")
    end

    :ok
  end

  defp cli_reopen(state, fiber_id, args) do
    case Shuttle.CLI.run_lifecycle("reopen", fiber_id, args,
           runner: state.runner,
           felt_store: owning_store(fiber_id, state)
         ) do
      {:ok, output} ->
        Logger.info("Force-dispatch armed #{fiber_id}: #{String.trim(output)}")
        :ok

      {:command_error, code, output} ->
        arm_refused(fiber_id, cli_text(output, "`shuttle reopen` exited #{code}"), nil)

      {:error, reason} ->
        arm_refused(fiber_id, "`shuttle reopen` could not run: #{inspect(reason)}", nil)
    end
  end

  defp cli_text(output, fallback) do
    case String.trim(to_string(output)) do
      "" -> fallback
      text -> text
    end
  end

  defp arm_refused(fiber_id, message, needs) do
    Logger.error("Force-dispatch of #{fiber_id} refused before anything changed: #{message}")
    {:error, {:arm_refused, %{message: message, needs: needs}}}
  end

  defp do_dispatch_fiber(%State{} = state, fiber, opts \\ []) do
    fiber_id = Map.get(fiber, "id", "")

    case project_dir_for_dispatch(fiber) do
      {:error, reason} ->
        {record_dispatch_failure(state, fiber, reason), {:error, {:not_eligible, reason}}}

      {:ok, project_dir} ->
        # The runtime key (uid when the fiber carries one, else slug) keys every
        # runtime map — running, dispatch_failures. felt I/O below stays
        # addressed by the slug `fiber_id`.
        runtime_key = runtime_key_for_fiber(fiber)

        # A human force-dispatch ("New session" / "Resume" / drag-to-inFlight)
        # is an explicit "go" — clear any open resume-loop breaker so the worker
        # spawns now rather than sitting out the cooldown.
        state =
          if Keyword.get(opts, :force, false),
            do: clear_resume_loop(state, runtime_key),
            else: state

        # The project_dir is the worker's cwd, so it loads that project's
        # CLAUDE.md; an autonomous worker without one starts in its felt store
        # (a forced start refused that case in `prepare_forced_start/5`).
        felt_store = owning_store(fiber_id, state)
        work_dir = project_dir || felt_store
        spawn_worker(state, fiber, fiber_id, runtime_key, felt_store, work_dir, opts)
    end
  end

  # The spawn itself, once the work directory has been vouched for.
  defp spawn_worker(state, fiber, fiber_id, runtime_key, felt_store, work_dir, opts) do
    prompt_context = dispatch_prompt_context(fiber, opts)

    case Dispatcher.dispatch(
           fiber_id,
           runner: state.runner,
           work_dir: work_dir,
           prompt_context: prompt_context,
           felt_store: felt_store,
           force: Keyword.get(opts, :force, false),
           # The user's directive + continuation mode ride the dispatch
           # call (no persisted review-comment). The dispatcher inlines the
           # message into the prompt at launch and honors resume_mode.
           user_message: Keyword.get(opts, :user_message),
           resume_mode: Keyword.get(opts, :resume_mode)
         ) do
      {:ok, session} ->
        running_meta =
          fiber_id
          |> new_running_meta(fiber, session, agent_id_from_fiber(fiber), felt_store)
          |> Map.merge(running_prompt_metadata(prompt_context))

        case register_running(state, fiber_id, runtime_key, running_meta) do
          {:ok, state} ->
            {state, {:ok, session}}

          {:error, reason} ->
            # Watcher start failed: the worker may be alive in tmux. Record the
            # failure for the `blocked` snapshot; the next poll re-evaluates the
            # fiber (status:active + no watcher → eligible / adopted again).
            Logger.error("Failed to start watcher for #{fiber_id}: #{inspect(reason)}")
            state = record_dispatch_failure(state, fiber, :watcher_start_failed)
            {state, {:error, :watcher_start_failed}}
        end

      {:error, :already_running} ->
        # Session exists but we don't have a watcher — adopt it
        state = SessionReconciliation.adopt_session(state, fiber_id)
        state = %{state | dispatch_failures: Map.delete(state.dispatch_failures, runtime_key)}
        {state, {:error, :already_running}}

      {:error, reason} ->
        Logger.warning("Dispatch failed for #{fiber_id}: #{inspect(reason)}")
        state = record_dispatch_failure(state, fiber, reason)
        {state, {:error, reason}}
    end
  end

  defp do_claim_app_session(state, fiber_id, uid, id, opts) do
    session = if is_binary(id), do: Shuttle.AppWorkers.ref(id)
    running = running_worker(state, fiber_id)
    other = live_session_for_fiber(state, fiber_id, uid)

    with true <- is_binary(id) and id != "",
         {:ok, fiber} <- fetch_fiber_full(fiber_id, state),
         true <- Map.get(fiber, "status") != "closed",
         true <- get_in(fiber, ["shuttle", "surface"]) == "app",
         true <- get_in(fiber, ["shuttle", "host"]) == state.own_host_id,
         true <- is_nil(other) or other == session,
         true <- is_nil(running) or running.session == session,
         :ok <-
           Shuttle.AppWorkers.claim_or_adopt(id, fiber, owning_store(fiber_id, state),
             agent_id: explicit_claim_agent(opts)
           ),
         :ok <- ensure_app_claim_marker(state, fiber_id, fiber, id) do
      meta =
        new_running_meta(
          fiber_id,
          fiber,
          session,
          Keyword.get(opts, :agent) || agent_id_from_fiber(fiber),
          owning_store(fiber_id, state)
        )

      if running do
        {state, {:ok, %{session: session, agent_id: meta.agent_id}}}
      else
        case register_running(state, fiber_id, runtime_key_for_fiber(fiber), meta) do
          {:ok, state} ->
            Shuttle.SessionLedger.record(
              fiber: fiber_id,
              uid: fiber["uid"],
              session: Shuttle.AppWorkers.transcript_id(id),
              thread_id: id,
              harness: "codex",
              kind: :claim,
              agent: app_claim_agent(id, opts),
              collaboration: collaboration_snapshot(fiber)
            )

            {refresh_document_entry(state, fiber_id),
             {:ok, %{session: session, agent_id: meta.agent_id}}}

          {:error, reason} ->
            {state, {:error, reason}}
        end
      end
    else
      false -> {state, {:error, :invalid_app_claim}}
      {:error, reason} -> {state, {:error, reason}}
    end
  end

  defp ensure_app_claim_marker(state, fiber_id, fiber, id) do
    if Shuttle.Continuation.resumable_session_id(fiber) == id do
      :ok
    else
      Shuttle.Continuation.write_dispatch(
        state.runner,
        owning_store(fiber_id, state),
        fiber_id,
        %{session_uuid: id}
      )
    end
  end

  # The claim verb's local branch: validate fiber + live session, rename the
  # session to the canonical worker name, register it in `running` with a
  # watcher, log the dispatch-shaped history event, and refresh the document
  # cache so the board reflects the claim immediately.
  defp do_claim_session(%State{} = state, fiber_id, uid, tmux_session, opts) do
    state = reconcile_running_fiber(state, fiber_id)

    running = running_worker(state, fiber_id)

    # Pass the resolved uid so the pre-check sees the fiber's
    # `<leaf>-<uid>-shuttle` name — a live session under it for a
    # not-yet-running fiber is then refused with :already_running instead of
    # degrading to a rename collision.
    live_session = live_session_for_fiber(state, fiber_id, uid)

    cond do
      # Idempotent retry: the fiber's running worker is this very session —
      # either by name, or the requested name no longer exists because the
      # first (successful) claim already renamed it. A lost claim response
      # must be retryable with the same body.
      running != nil and
          (running.session == tmux_session or
             not already_running_session?(state, tmux_session)) ->
        {state, {:ok, %{session: running.session, agent_id: Map.get(running, :agent_id)}}}

      running != nil ->
        {state, {:error, :already_running}}

      # A live canonical-name session that is NOT the claimer means another
      # worker is already on the fiber. When the claimer *is* the canonical
      # session (a prior claim renamed it but the watcher failed to start),
      # fall through — registration is the recovery path.
      live_session != nil and live_session != tmux_session ->
        {state, {:error, :already_running}}

      not already_running_session?(state, tmux_session) ->
        {state, {:error, :session_not_found}}

      true ->
        case fetch_fiber_full(fiber_id, state) do
          {:error, _} ->
            {state, {:error, :not_found}}

          {:ok, fiber} ->
            cond do
              Map.get(fiber, "status") == "closed" ->
                {state, {:error, :closed}}

              # The claim stamps `shuttle.runtime` (dispatched_at, session_uuid)
              # through `shuttle mark-runtime`, which needs an installed
              # block to nest under. Claiming an uninstalled fiber would
              # register a worker whose runtime never lands — no Resume
              # previous, no meeting-to-card link — so install comes first.
              not is_map(Map.get(fiber, "shuttle")) ->
                {state, {:error, :not_installed}}

              # The claimed session is renamed to the worker name, which is
              # keyed by the fiber's uid; without one there is no name to take.
              Dispatcher.session_name(fiber_id, Map.get(fiber, "uid")) == nil ->
                {state, {:error, :uid_missing}}

              true ->
                register_claimed_session(state, fiber_id, fiber, tmux_session, opts)
            end
        end
    end
  end

  defp register_claimed_session(%State{} = state, fiber_id, fiber, tmux_session, opts) do
    # The session is already live; we only need a label for the running-state
    # entry. Prefer the claim's explicit `:agent` (the worker names itself),
    # else Shuttle's resolved id, else the raw name / "unknown" — a best-effort
    # display label, never a dispatch decision.
    agent_id = Keyword.get(opts, :agent) || agent_id_from_fiber(fiber)

    # Rename to the worker name `<leaf>-<uid>-shuttle` so everything
    # downstream — restart re-adoption, liveness, the kanban's runtime stamp —
    # treats the claimed session exactly like a dispatched one.
    canonical = Dispatcher.session_name(fiber_id, Map.get(fiber, "uid"))

    rename_result =
      if tmux_session == canonical do
        {:ok, canonical}
      else
        case state.runner.cmd(
               "tmux",
               ["rename-session", "-t", "=" <> tmux_session, canonical],
               stderr_to_stdout: true
             ) do
          {_, 0} ->
            {:ok, canonical}

          {output, _} ->
            # Fail the claim rather than registering under a non-canonical
            # name: the restart re-adoption scan and liveness only see
            # `<leaf>-<uid>-shuttle` names, so a degraded
            # registration would go invisible on daemon restart and a
            # duplicate worker would dispatch alongside it.
            Logger.warning("claim: rename #{tmux_session} → #{canonical} failed: #{output}")
            {:error, :rename_failed}
        end
      end

    case rename_result do
      {:error, _} = error ->
        {state, error}

      {:ok, session} ->
        register_renamed_session(state, fiber_id, fiber, session, agent_id, opts)
    end
  end

  defp register_renamed_session(%State{} = state, fiber_id, fiber, session, agent_id, opts) do
    running_meta =
      new_running_meta(fiber_id, fiber, session, agent_id, owning_store(fiber_id, state))

    case register_running(state, fiber_id, runtime_key_for_fiber(fiber), running_meta) do
      {:ok, state} ->
        log_worker_claim(state, fiber_id, opts)

        # The structural half: the claim is the moment this host learns that
        # this externally-spawned session belongs to this fiber. `record/1`
        # drops a claim that carried no session UUID — there is no pairing to
        # record then, only a run window, which `log_worker_claim` already
        # stamped.
        Shuttle.SessionLedger.record(
          fiber: fiber_id,
          uid: Map.get(fiber, "uid"),
          session: Keyword.get(opts, :session_uuid),
          tmux: session,
          harness:
            Shuttle.SessionLedger.harness_for_cli(
              get_in(fiber, ["shuttle", "resolved", "agent", "cli"])
            ),
          kind: :claim,
          agent: explicit_claim_agent(opts),
          collaboration: collaboration_snapshot(fiber)
        )

        state = refresh_document_entry(state, fiber_id)
        Logger.info("Claimed session #{session} for #{fiber_id} (agent=#{agent_id})")
        {state, {:ok, %{session: session, agent_id: agent_id}}}

      {:error, reason} ->
        Logger.error("Failed to start watcher for claimed #{fiber_id}: #{inspect(reason)}")
        {state, {:error, :watcher_start_failed}}
    end
  end

  # The claim-time analog of the dispatcher's dispatch write: a self-claimed /
  # chat-captured session stamps (refreshes) the fiber's `shuttle.runtime`
  # dispatch fields so the continuation heuristic and "Resume previous" can
  # recover its session UUID. Routes through `shuttle mark-runtime`. The store/scoped-id pair mirrors the dispatch
  # path: `store_for_fiber` (the same owning-store the poll enumerated this fiber
  # from), falling back to the primary configured store. A claim with no captured
  # session_uuid still stamps `dispatched_at` (the run-window anchor) so a clean
  # handoff can later be compared against it. A meeting capture's claim also
  # stamps the meeting's launch id, which is how the meeting finds its fiber.
  defp log_worker_claim(%State{} = state, fiber_id, opts) do
    felt_store = owning_store(fiber_id, state)

    Shuttle.Continuation.write_dispatch(state.runner, felt_store, fiber_id, %{
      session_uuid: present_string(Keyword.get(opts, :session_uuid)),
      meeting: present_string(Keyword.get(opts, :meeting))
    })
  end

  defp present_string(value) when is_binary(value) and value != "", do: value
  defp present_string(_value), do: nil

  # Records (or refreshes the attempt count on) a dispatch failure. The map
  # entry is surfaced in `build_snapshot/1` under `blocked` so the kanban can
  # show why a fiber is stuck — replacing the silent-warning-log failure mode
  # where a `:missing_session_id` block could persist for days unnoticed.
  defp record_dispatch_failure(%State{} = state, fiber, reason) do
    now = DateTime.utc_now()
    runtime_key = runtime_key_for_fiber(fiber)
    slug = fiber_address(fiber)
    uid = metadata_uid(fiber)

    entry =
      case Map.get(state.dispatch_failures, runtime_key) do
        %{reason: ^reason, attempts: n} = e ->
          %{e | attempts: n + 1, attempted_at: now}

        _ ->
          %{
            reason: reason,
            attempts: 1,
            attempted_at: now,
            first_attempted_at: now,
            fiber_id: slug,
            uid: uid
          }
      end

    %{state | dispatch_failures: Map.put(state.dispatch_failures, runtime_key, entry)}
  end

  # ── Reconciliation ──

  # Orphan adoption maps sessions through a FRESH store walk, not this poll's
  # candidates: the candidates were read before `reconcile_fiber_closures/1`'s
  # fresh reads, so a worker that closed its fiber mid-poll would still look
  # active in them, be re-adopted, and be killed during its own final act.
  # `sessions` is this cycle's `list_shuttle_sessions/1` scan.
  defp reconcile(%State{} = state, sessions) do
    state = %{state | orphans: []}
    state = reconcile_fiber_closures(state)
    state = reconcile_missing_running_sessions(state)
    SessionReconciliation.reconcile_orphaned_sessions(state, sessions)
  end

  defp reconcile_fiber_closures(%State{running: running} = state) when map_size(running) == 0 do
    state
  end

  defp reconcile_fiber_closures(%State{} = state) do
    Enum.reduce(state.running, state, fn {runtime_key, meta}, state_acc ->
      fiber_id = fiber_address(meta)

      case fetch_fiber_full(fiber_id, state_acc) do
        {:ok, fiber} ->
          app? = Shuttle.AppWorkers.app?(meta.session)
          handed_off? = app? and Shuttle.Continuation.clean_handoff_since_dispatch?(fiber)

          idle? =
            app? and (handed_off? or Map.get(fiber, "status") == "closed") and
              Shuttle.AppWorkers.client().state(Shuttle.AppWorkers.id(meta.session)) == :idle

          cond do
            handed_off? and idle? ->
              :ok = Shuttle.AppWorkers.deactivate(Shuttle.AppWorkers.id(meta.session))
              stop_watcher(meta)
              handle_worker_exit(state_acc, fiber_id)

            Map.get(fiber, "status") == "closed" and not app? ->
              stamp_handoff_if_stale(state_acc, fiber_id, fiber)
              Logger.info("Fiber closed externally: #{fiber_id}; stopping watcher")
              stop_watcher(meta)
              remove_running(state_acc, runtime_key)

            Map.get(fiber, "status") == "closed" and idle? ->
              stamp_handoff_if_stale(state_acc, fiber_id, fiber)
              :ok = Shuttle.AppWorkers.deactivate(Shuttle.AppWorkers.id(meta.session))
              stop_watcher(meta)
              remove_running(state_acc, runtime_key)

            true ->
              state_acc
          end

        {:error, _} ->
          state_acc
      end
    end)
  end

  # A fiber flipping to `status: closed` while its worker is still running IS
  # the worker's deliberate exit — a crash never changes status, so closed is
  # deliberate by construction. Every reap path that catches a closed fiber
  # with a live worker (the per-poll reaper above, and orphan/boot adoption in
  # `Shuttle.Poller.SessionReconciliation`) calls this to stamp
  # `shuttle.runtime.handed_off_at` exactly as `shuttle handoff` would, so
  # `Continuation.clean_handoff_since_dispatch?/1` reads the exit as clean
  # (fresh redispatch) rather than a dirty death (resume). Skipped when
  # `handed_off_at` is already present and not older than `dispatched_at` — a
  # worker (or a prior reap) already stamped its own clean exit, and this must
  # never clobber that stamp with a later `now`.
  def stamp_handoff_if_stale(%State{} = state, fiber_id, fiber) do
    dispatched_at = Shuttle.Continuation.dispatched_at(fiber)
    handed_off_at = Shuttle.Continuation.handed_off_at(fiber)

    stale? =
      is_nil(handed_off_at) or
        (not is_nil(dispatched_at) and DateTime.compare(handed_off_at, dispatched_at) == :lt)

    if stale? do
      Shuttle.Continuation.mark_handed_off(state.runner, owning_store(fiber_id, state), fiber_id)
    end

    :ok
  end

  defp reconcile_missing_running_sessions(%State{running: running} = state)
       when map_size(running) == 0 do
    state
  end

  defp reconcile_missing_running_sessions(%State{} = state) do
    Enum.reduce(state.running, state, fn {runtime_key, %{session: session} = meta}, state_acc ->
      fiber_id = fiber_address(meta)

      if already_running_session?(state_acc, session) do
        state_acc
      else
        Logger.info("Detected missing worker session: #{fiber_id} session=#{session}")
        stop_watcher(meta)

        state_acc
        |> record_orphaned_running_worker(fiber_id, meta)
        |> remove_running(runtime_key)
      end
    end)
  end

  defp record_orphaned_running_worker(%State{} = state, fiber_id, meta) do
    # Daemon-down analog of handle_worker_exit's standing branch. The caller —
    # `reconcile_missing_running_sessions` (the watcher missed the exit) —
    # lands here for a running entry whose tmux session is gone. For an
    # ordinary oneshot that's just an orphan to record; for a standing constitution it
    # is the exit that `handle_worker_exit` never got to run, so the armed
    # document would re-fire on the next poll. Mark it awaiting (status:closed,
    # untempered) here, keyed on the running-worker entry — a role with no
    # running row never reaches this path and cannot be regressed.
    mark_dead_standing_role_awaiting(state, fiber_id)

    orphan = %{
      fiber_id: fiber_id,
      tmux_session: Map.get(meta, :session),
      agent: Map.get(meta, :agent_id),
      reason: "missing_tmux_session",
      detected_at: DateTime.utc_now() |> DateTime.to_unix(:millisecond)
    }

    %{state | orphans: [orphan | state.orphans]}
  end

  # Write `status: closed` (untempered) to a standing constitution's document when its
  # worker died unobserved and the document is still armed. Only an owned,
  # armed (status:active, no verdict) STANDING constitution is touched: an armed
  # standing document would re-fire on the next cron tick, so it must be
  # closed. Oneshots, constitutions this daemon doesn't own, and
  # already-closed/tempered ones are left alone. The mark is
  # idempotent: once status flips to closed the running entry is gone (the
  # caller removes it) and the `status == "active"` guard short-circuits any
  # later pass.
  defp mark_dead_standing_role_awaiting(%State{} = state, fiber_id) do
    with {:ok, fiber} <- fetch_fiber_full(fiber_id, state),
         shuttle when is_map(shuttle) <- Map.get(fiber, "shuttle"),
         true <- host_owned?(shuttle, state.own_host_id),
         true <- standing?(fiber),
         "active" <- Map.get(fiber, "status", ""),
         true <- is_nil(Map.get(fiber, "tempered")) do
      Logger.info(
        "Standing constitution #{fiber_id} worker died unobserved (daemon-down or unwatched " <>
          "exit); marking awaiting (status:closed) so the armed document does not re-fire"
      )

      StandingRoles.mark_standing_awaiting(fiber_id)
    else
      _ -> :ok
    end
  end

  # A shuttle block's dispatch kind: `kind:`, else "oneshot". A retired kind
  # reads as the kind it stands for (`pinned` → "oneshot"), matching the CLI's
  # `shuttle.NormalizeKind`, so a document a daemon reads raw behaves the same
  # as one the CLI resolved.
  @doc false
  def block_kind(shuttle) do
    case Map.get(shuttle, "kind", "oneshot") do
      "pinned" -> "oneshot"
      kind -> kind
    end
  end

  # A fiber's dispatch kind; "oneshot" when it carries no shuttle block.
  @doc false
  def fiber_kind(fiber) do
    case Map.get(fiber, "shuttle") do
      shuttle when is_map(shuttle) -> block_kind(shuttle)
      _ -> "oneshot"
    end
  end

  # A worker nothing tracks — its watcher failed to start, or a restart has
  # not adopted it yet — is still a worker. Look for it where a launch would
  # have put it and stop whatever is live there: the app conversation whose
  # durable record carries this fiber's uid, or the tmux session named for its
  # canonical slug and uid.
  #
  # Identity first, and fail closed. The identifier (slug or uid) is resolved
  # to the canonical slug, then the fiber is read; a read that fails stops
  # nothing, because a lookup by slug alone could reach another fiber's worker
  # (an app record that kept a renamed fiber's old slug). A fiber with no uid
  # was never dispatchable, so nothing of its own can be live.
  defp stop_untracked_worker(state, identifier) do
    {_runtime_key, slug} = resolve_identity(state, identifier)

    case fetch_fiber_full(slug, state) do
      {:ok, fiber} ->
        case Map.get(fiber, "uid") do
          uid when is_binary(uid) and uid != "" ->
            stop_live_session(state, slug, untracked_session(state, fiber, slug, uid))

          _ ->
            {:ok, :no_session}
        end

      _ ->
        {:error,
         "could not verify the identity of #{identifier}; no untracked worker was stopped"}
    end
  end

  defp untracked_session(state, fiber, slug, uid) do
    case Enum.find(Shuttle.AppWorkers.active(), &(&1["uid"] == uid)) do
      %{"session_uuid" => id} when is_binary(id) ->
        Shuttle.AppWorkers.ref(id)

      _ ->
        # An app fiber on a host without tmux has no terminal session to
        # probe: asking tmux there reads as "unknown" and a stop would fail on
        # the missing binary instead of being the no-op it is (an app-only
        # host), the guard `live_session_for_fiber/3` keeps too. A terminal
        # fiber is always probed, even where tmux is not on PATH: its worker
        # can outlive the daemon that lost tmux, and a stop that cannot reach
        # it must fail rather than report nothing running.
        app_without_tmux? =
          get_in(fiber, ["shuttle", "surface"]) == "app" and
            Shuttle.Env.find_executable("tmux") == nil

        session = Dispatcher.session_name(slug, uid)

        if session && not app_without_tmux? && already_running_session?(state, session),
          do: session
    end
  end

  defp stop_live_session(_state, _slug, nil), do: {:ok, :no_session}

  defp stop_live_session(state, slug, session) do
    case Shuttle.WorkerBackend.stop(state.runner, session) do
      {_output, 0} ->
        {:ok, session}

      {output, status} ->
        Logger.error("stopping untracked #{slug}: stop exited #{inspect(status)}: #{output}")
        {:error, "stopping the worker failed (exit #{inspect(status)}): #{output}"}
    end
  end

  # Stop a fiber's worker through its backend (tmux, or an app conversation's
  # interrupt) and tear down its runtime entry, tracked or not. Writes no
  # status. Shared by `/kill` and the rest transition.
  defp stop_tracked_worker(state, fiber_id) do
    case running_key(state, fiber_id) do
      nil ->
        {stop_untracked_worker(state, fiber_id), state}

      runtime_key ->
        meta = Map.get(state.running, runtime_key)
        session = meta.session
        # Stop the watcher BEFORE the kill so its has-session poll doesn't also
        # report the exit and double-handle through handle_worker_exit.
        stop_watcher(meta)

        case Shuttle.WorkerBackend.stop(state.runner, session) do
          {_output, 0} ->
            # Pure runtime teardown — drop running entry + claim, no status write.
            state = remove_running(state, runtime_key)
            {{:ok, session}, state}

          {output, status} ->
            # A real failure: the worker is (or may still be) alive. Leave
            # tracking in place — no teardown — so the board doesn't show a
            # stopped card while a ghost worker keeps mutating the fiber.
            # But the watcher we stopped above is now gone too, and nothing
            # else will restart it — without re-arming it, a live session
            # nobody observes is a second ghost-worker flavor, invisible
            # until this daemon restarts. Re-start it against the same
            # session so the exit still gets handled eventually.
            Logger.error("kill_session #{fiber_id}: stop exited #{inspect(status)}: #{output}")

            state = restart_watcher_after_failed_kill(state, fiber_id, runtime_key, meta)

            {{:error, "stopping the worker failed (exit #{inspect(status)}): #{output}"}, state}
        end
    end
  end

  # ── Worker Exit Handling ──

  defp handle_worker_exit(%State{} = state, fiber_id) do
    case running_key(state, fiber_id) do
      nil ->
        state

      runtime_key ->
        {meta, running} = Map.pop(state.running, runtime_key)
        state = %{state | running: running}
        fiber_id = fiber_address(meta)

        case fetch_fiber_full(fiber_id, state) do
          {:ok, fiber} ->
            # The daemon does NOT write the handoff marker — the WORKER does,
            # via `shuttle handoff`, as its second-to-last act. A worker
            # that dies without handing off leaves no handoff marker, so the
            # next dispatch resumes its transcript while warm and starts fresh
            # once cold (`Dispatcher.check_resume_intent/2`). The clean/dirty
            # distinction lives entirely in the presence (and timestamp) of
            # the worker-written handoff marker; this exit path only drives
            # the document state machine below.
            status = Map.get(fiber, "status", "")

            cond do
              status == "closed" ->
                state

              standing?(fiber) ->
                # A STANDING (cron) worker's exit makes the role awaiting
                # review by writing `status: closed` (untempered) to the felt
                # document — the don't-re-fire gate and the human's accept
                # anchor, both doc-representable. Written on the exit path
                # itself, so a re-poll racing this exit reads `status: closed`
                # and skips re-dispatch.
                StandingRoles.mark_standing_awaiting(fiber_id)

                state

              true ->
                # A still-active ONESHOT continuation: the next poll re-picks
                # it (status:active + no live session → eligible) and
                # `Dispatcher.check_resume_intent/2` decides resume-vs-fresh.
                # Feed the worker's lifetime to the resume-loop breaker: a
                # rapid death (lived < threshold) increments the count and may
                # open the circuit; a healthy run clears it.
                note_worker_lifetime(state, runtime_key, fiber, meta)
            end

          {:error, _} ->
            # Can't read fiber — the next poll re-reads it.
            state
        end
    end
  end

  # ── Resume-loop circuit breaker ──

  # Record a finished worker's lifetime against the breaker. A healthy run
  # (lived ≥ threshold) clears the fiber's loop count; a rapid death increments
  # it and may open the circuit. Scoped to the still-active-oneshot exit branch
  # — the only path that auto-re-dispatches, hence the only one that can loop.
  defp note_worker_lifetime(%State{} = state, runtime_key, fiber, meta) do
    if worker_lifetime_ms(meta) >= @resume_loop_rapid_exit_threshold_ms do
      %{state | resume_loop: Map.delete(state.resume_loop, runtime_key)}
    else
      bump_resume_loop(state, runtime_key, fiber)
    end
  end

  # Wall-clock lifetime of a worker from its running metadata. Clamped to ≥ 0 so
  # a backward clock step (observed on this host) can't read as a huge lifetime
  # and mask a loop — a non-positive diff counts as a rapid exit. An absent
  # started_at is treated as healthy (don't trip on missing data).
  defp worker_lifetime_ms(meta) do
    case Map.get(meta, :started_at) do
      %DateTime{} = started -> max(0, DateTime.diff(DateTime.utc_now(), started, :millisecond))
      _ -> @resume_loop_rapid_exit_threshold_ms
    end
  end

  defp bump_resume_loop(%State{} = state, runtime_key, fiber) do
    now = DateTime.utc_now()

    entry =
      Map.get(state.resume_loop, runtime_key, %{
        count: 0,
        opened_at: nil,
        fiber_id: fiber_address(fiber),
        uid: metadata_uid(fiber)
      })

    count = entry.count + 1
    tripping? = count >= @resume_loop_max_rapid_exits

    if tripping? do
      Logger.warning(
        "Resume-loop breaker open for #{fiber_address(fiber)}: #{count} consecutive rapid " <>
          "worker exits (each < #{div(@resume_loop_rapid_exit_threshold_ms, 1000)}s) — pausing " <>
          "autonomous dispatch for #{div(@resume_loop_cooldown_ms, 60_000)}m (force-dispatch to override)"
      )
    end

    opened_at = if tripping?, do: now, else: entry.opened_at

    %{
      state
      | resume_loop:
          Map.put(state.resume_loop, runtime_key, %{entry | count: count, opened_at: opened_at})
    }
  end

  # True while the breaker is open AND inside its cooldown window. After the
  # cooldown elapses the fiber is eligible again (one retry); a healthy run then
  # clears the entry, while another rapid death re-opens it immediately (count is
  # already past the threshold), so a persistent loop is bounded to one attempt
  # per cooldown instead of one per poll.
  defp resume_loop_open?(%State{} = state, runtime_key) do
    case Map.get(state.resume_loop, runtime_key) do
      %{opened_at: %DateTime{} = opened} ->
        DateTime.diff(DateTime.utc_now(), opened, :millisecond) < @resume_loop_cooldown_ms

      _ ->
        false
    end
  end

  # Clear the breaker for a fiber — a human force-dispatch is an explicit "go",
  # overriding any paused loop, and the next poll's eviction also drops entries
  # for fibers that left the active candidate set.
  defp clear_resume_loop(%State{} = state, runtime_key) do
    %{state | resume_loop: Map.delete(state.resume_loop, runtime_key)}
  end

  # True while a dispatch-preflight refusal is still inside its cooldown window
  # (see `@preflight_cooldown_ms`). Read straight off `dispatch_failures` — the
  # refusal is already recorded there for the `blocked` snapshot, so the breaker
  # needs no state of its own.
  #
  # `record_dispatch_failure/3` refreshes `attempted_at` on each attempt, so the
  # window restarts from the last *attempt*: the fiber gets one retry per
  # cooldown while the problem persists, and the moment a dispatch succeeds the
  # entry is deleted and the fiber is immediately eligible again.
  #
  # `:project_dir_missing` rides the same breaker, and for the same reason with
  # sharper teeth: a checkout that is absent (or that this daemon is DENIED —
  # the two are one `File.dir?` answer) will not appear between two ticks, and
  # under a macOS file provider each re-stat costs a TCC prompt on someone's
  # screen. One attempt per cooldown, not one per tick.
  #
  # `:tmux_server_unavailable` rides it too: no tmux server and no reachable
  # kitty is a state only a human can leave (open kitty, or start a server by
  # hand), and each attempt pays a `kitty @ launch` round trip.
  #
  # `:uid_missing` rides it so a fiber without an id logs its refusal once per
  # cooldown rather than every tick until someone runs `felt backfill-ids`.
  defp preflight_cooldown_open?(%State{} = state, runtime_key) do
    case Map.get(state.dispatch_failures, runtime_key) do
      %{reason: {tag, _detail}, attempted_at: %DateTime{} = at}
      when tag in [
             :uid_missing,
             :wrapper_unresolved,
             :work_dir_missing,
             :project_dir_missing,
             :tmux_server_unavailable,
             :transcript_held
           ] ->
        DateTime.diff(DateTime.utc_now(), at, :millisecond) < @preflight_cooldown_ms

      _ ->
        false
    end
  end

  # ── Stale running entries ──

  # Drop `fiber_id`'s running entry when its session is gone, so an explicit
  # dispatch or claim never bounces off a worker that already died.
  defp reconcile_running_fiber(%State{} = state, fiber_id) do
    case running_key(state, fiber_id) do
      nil ->
        state

      runtime_key ->
        %{session: session} = meta = Map.fetch!(state.running, runtime_key)
        fiber_id = fiber_address(meta)

        if already_running_session?(state, session) do
          state
        else
          Logger.info("Clearing stale running worker: #{fiber_id} session=#{session}")
          stop_watcher(meta)
          remove_running(state, runtime_key)
        end
    end
  end

  # ── Helpers ──

  # The fiber's uid: the running entry's when one exists, else the caller's
  # runtime key when that key IS a uid (`resolve_identity/2` returns a ULID
  # runtime key only for a uid-addressed call).
  defp resolved_uid(state, fiber_id, runtime_key) do
    metadata_uid(running_worker(state, fiber_id)) ||
      if(Shuttle.ULID.valid?(runtime_key), do: runtime_key)
  end

  # Start a turn carrying `text` in a live Codex app conversation and mark the
  # app worker running again.
  defp start_app_turn("codex-app:" <> id = session, text) do
    case Shuttle.AppWorkers.client().start_turn(id, text, []) do
      {:ok, turn} ->
        :ok =
          Shuttle.AppWorkers.update(id, %{
            "launch_state" => "running",
            "last_error" => nil,
            "turn_id" => turn["id"]
          })

        {:ok, %{session: session, bytes: byte_size(text)}}

      error ->
        error
    end
  end

  # Is a worker present in this tmux session? `present?` treats an inconclusive
  # `has-session` as present, so reconcile won't drop a live worker's running
  # entry (nor free its name for a resume) on a transient tmux failure — only a
  # confirmed `:gone` does. The reconcile/liveness twin of dispatch's
  # check_not_running.
  defp already_running_session?(%State{} = state, session) do
    Shuttle.WorkerBackend.present?(state.runner, session)
  end

  # Does this daemon track a worker for the fiber? Matched by slug and by
  # runtime key: a fiber renamed mid-flight has the OLD slug in its running
  # meta, so only the uid-shaped runtime key finds it.
  defp tracked?(%State{} = state, fiber_id, runtime_key) do
    running_key(state, fiber_id) != nil or Map.has_key?(state.running, runtime_key)
  end

  # A tracked worker, or a live session under the fiber's name that nothing
  # tracks yet.
  defp open_session?(%State{} = state, fiber_id, runtime_key, uid) do
    tracked?(state, fiber_id, runtime_key) or
      live_session_for_fiber(state, fiber_id, uid) != nil
  end

  # The fiber's *live* worker session — an app worker's ref, or its tmux
  # session (`Dispatcher.session_name/2`) when that is live — else nil. `uid`
  # may be supplied by a caller that already resolved it (the dispatch and adopt
  # paths); otherwise it's read off a matching running entry. Without a uid the
  # fiber has no tmux name, so nothing is live under it.
  @doc false
  def live_session_for_fiber(%State{} = state, fiber_id, uid \\ nil) do
    case Shuttle.AppWorkers.for_fiber(fiber_id, uid) do
      %{"session_uuid" => id} ->
        Shuttle.AppWorkers.ref(id)

      _ ->
        app_without_tmux? =
          Shuttle.Env.find_executable("tmux") == nil and
            case fetch_fiber_full(fiber_id, state) do
              {:ok, fiber} -> get_in(fiber, ["shuttle", "surface"]) == "app"
              _ -> false
            end

        session =
          Dispatcher.session_name(
            fiber_id,
            uid || metadata_uid(running_worker(state, fiber_id))
          )

        if not app_without_tmux? and session != nil and already_running_session?(state, session),
          do: session
    end
  end

  defp available_slots(%State{} = state) do
    max(state.max_concurrent_workers - map_size(state.running), 0)
  end

  defp remove_running(%State{} = state, runtime_key) do
    %{state | running: Map.delete(state.running, runtime_key)}
  end

  # "New session" on a fiber that still holds an OPEN tmux session is a CUT, not
  # a refusal. A forced fresh dispatch (`force` + `resume_mode:"fresh"` — the
  # kanban New-session button and drag-launch both send these) stamps the
  # clean-exit marker, stops the live worker — waiting until its processes are
  # gone (`Shuttle.Tmux.stop/2`), since the fresh session reuses its name — and
  # drops the runtime entry, THEN lets the caller's `cond` fall through to a
  # fresh dispatch instead of returning `:already_running`. Without this,
  # starting fresh on an open session meant the costly resume →
  # reload-stale-transcript → handoff dance.
  #
  # Gated strictly on `force` + `resume_mode:"fresh"`: the autonomous poll never
  # carries `resume_mode`, so it can NEVER cut a live worker — only an explicit
  # human New-session can. A non-fresh force-dispatch (Resume, `"previous"`) is
  # untouched and still resumes the in-flight transcript.
  defp cut_open_session_for_fresh(%State{} = state, fiber_id, runtime_key, uid, opts) do
    forced_fresh? =
      Keyword.get(opts, :force, false) and Keyword.get(opts, :resume_mode) == "fresh"

    if forced_fresh? and open_session?(state, fiber_id, runtime_key, uid) do
      cut_open_session(state, fiber_id, uid)
    else
      state
    end
  end

  # The cut itself — the user-gesture twin of `kill_session`, plus the marker.
  # Terminal teardown stamps the clean-exit marker before killing the process.
  # An app stop must first confirm interruption: an uncertain network result
  # retains ownership and its existing marker so reconciliation cannot release
  # a conversation that may still be executing.
  defp cut_open_session(%State{} = state, fiber_id, uid) do
    key = running_key(state, fiber_id)
    meta = if key, do: Map.get(state.running, key)
    session = if meta, do: meta.session, else: live_session_for_fiber(state, fiber_id, uid)
    app? = Shuttle.AppWorkers.app?(session)

    if not app?,
      do:
        Shuttle.Continuation.mark_handed_off(
          state.runner,
          owning_store(fiber_id, state),
          fiber_id
        )

    result = if session, do: Shuttle.WorkerBackend.stop(state.runner, session), else: {"", 0}

    case result do
      {_, 0} ->
        if app?,
          do:
            Shuttle.Continuation.mark_handed_off(
              state.runner,
              owning_store(fiber_id, state),
              fiber_id
            )

        if meta, do: stop_watcher(meta)
        if key, do: remove_running(state, key), else: state

      {output, _} ->
        Logger.warning("Could not stop #{fiber_id} for a fresh dispatch: #{output}")
        state
    end
  end

  # The running entry for a worker that starts, or is claimed, now.
  defp new_running_meta(fiber_id, fiber, session, agent_id, felt_store) do
    now = DateTime.utc_now()

    %{
      fiber_id: fiber_id,
      session: session,
      agent_id: agent_id,
      uid: Map.get(fiber, "uid"),
      felt_store: felt_store,
      started_at: now,
      last_activity_at: now
    }
  end

  # The one "a worker just started for this fiber" seam, shared by dispatch and
  # claim: start the liveness watcher and, on success, register the entry.
  # `running` is an in-memory watcher registry, not persisted — tmux is the
  # source of truth; a restart re-adopts live sessions.
  defp register_running(%State{} = state, fiber_id, runtime_key, meta) do
    case start_watcher(state, fiber_id, meta) do
      {:ok, meta} ->
        state =
          %{
            state
            | running: Map.put(state.running, runtime_key, meta),
              dispatch_failures: Map.delete(state.dispatch_failures, runtime_key)
          }
          |> note_running(runtime_key)

        {:ok, state}

      {:error, reason} ->
        {:error, reason}
    end
  end

  @doc false
  def start_watcher(%State{} = state, fiber_id, metadata) do
    watcher_opts = [
      fiber_id: fiber_id,
      session: Map.fetch!(metadata, :session),
      poller: state.self_ref,
      runner: state.runner,
      uid: Map.get(metadata, :uid),
      felt_store: Map.get(metadata, :felt_store),
      heartbeat_interval_ms: state.heartbeat_interval_ms,
      callers: Shuttle.Env.callers()
    ]

    case DynamicSupervisor.start_child(Shuttle.WatcherSupervisor, {WorkerWatcher, watcher_opts}) do
      {:ok, watcher_pid} ->
        {:ok, Map.put(metadata, :pid, watcher_pid)}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp stop_watcher(meta) do
    if is_pid(meta.pid) and Process.alive?(meta.pid) do
      try do
        WorkerWatcher.stop(meta.pid)
      catch
        :exit, {:noproc, _} -> :ok
        :exit, :noproc -> :ok
      end
    end
  end

  # `kill_session` stops the watcher before attempting the kill (see its own
  # comment); when the kill then genuinely fails, the session survives but
  # nothing is watching it anymore. Re-arm a watcher against the still-live
  # session so its eventual exit is still handled, rather than silently
  # ghosting until this daemon restarts. Best-effort: a failure to restart is
  # logged, not raised — the kill_session caller already has an error to
  # surface, and the next poll cycle's reconciliation is the backstop.
  defp restart_watcher_after_failed_kill(%State{} = state, fiber_id, runtime_key, meta) do
    case start_watcher(state, fiber_id, meta) do
      {:ok, new_meta} ->
        %{state | running: Map.put(state.running, runtime_key, new_meta)}

      {:error, reason} ->
        Logger.error(
          "kill_session #{fiber_id}: failed to restart watcher after failed kill: #{inspect(reason)}"
        )

        state
    end
  end

  # Fetch a fiber's full JSON representation via shuttle so runtime decisions
  # see resolved Shuttle fields. Routes to the owning store via owning_store/2.
  @doc false
  def fetch_fiber_full(fiber_id, state) do
    host = owning_store(fiber_id, state)

    case run_shuttle(host, state.runner, ["show", fiber_id, "--json"]) do
      {:ok, output} ->
        case Jason.decode(output) do
          {:ok, fiber} -> {:ok, fiber}
          {:error, _} -> {:error, :invalid_json}
        end

      # run_shuttle reports the executable, command, store directory, and CLI
      # output. A common error is a store path that exists only on another host;
      # naming it makes that actionable instead of returning a blank 500.
      {:error, reason} ->
        {:error, reason}
    end
  end

  @doc false
  def iso_to_unix_ms(iso) when is_binary(iso) and iso != "" do
    case DateTime.from_iso8601(iso) do
      {:ok, dt, _} -> DateTime.to_unix(dt, :millisecond)
      _ -> nil
    end
  end

  def iso_to_unix_ms(_), do: nil

  defp dispatch_prompt_context(fiber, opts) do
    case StandingRoles.standing_role_from_fiber(fiber) do
      {:ok, role} ->
        if StandingRole.standing?(role) do
          now = DateTime.utc_now()

          if Keyword.get(opts, :ad_hoc, false) do
            {:standing_run, StandingRole.ad_hoc_run_id(now), :ad_hoc}
          else
            # A resumed run keeps the awaiting run's id; only a fresh scheduled
            # run mints a new id. The run id flows into the dispatch
            # marker. See StandingRole.dispatch_run_id.
            {:standing_run, StandingRole.dispatch_run_id(role, now)}
          end
        else
          :constitution
        end

      _ ->
        :constitution
    end
  end

  defp running_prompt_metadata({:standing_run, run_id}), do: %{state: "running", run_id: run_id}

  defp running_prompt_metadata({:standing_run, run_id, :ad_hoc}),
    do: %{state: "running", run_id: run_id, run_kind: "ad_hoc"}

  defp running_prompt_metadata(_), do: %{}

  # Run either CLI against an explicit store. Felt reads run from the store
  # directory; Shuttle receives its root `-C` flag. JSON consumers keep stderr
  # separate because a successful listing can warn about an unreadable fiber.
  defp run_felt(store, runner, args, opts), do: run_cli(:felt, store, runner, args, opts)

  defp run_shuttle(store, runner, args, opts \\ []),
    do: run_cli(:shuttle, store, runner, args, opts)

  defp with_ids_file(nil, fun), do: fun.(nil)

  defp with_ids_file(ids, fun) do
    dir =
      Path.join(
        System.tmp_dir!(),
        "shuttle-ids-#{Base.encode16(:crypto.strong_rand_bytes(16), case: :lower)}"
      )

    case File.mkdir(dir) do
      :ok ->
        try do
          :ok = File.chmod(dir, 0o700)
          path = Path.join(dir, "ids")

          case File.write(path, Enum.join(ids, "\n") <> if(ids == [], do: "", else: "\n"), [
                 :exclusive
               ]) do
            :ok -> fun.(path)
            {:error, reason} -> {:error, {:ids_file, reason}}
          end
        after
          File.rm_rf(dir)
        end

      {:error, reason} ->
        {:error, {:ids_directory, reason}}
    end
  end

  defp sweep_stale_ids_dirs do
    tmp_dir = System.tmp_dir!()
    cutoff = System.os_time(:second) - 3_600

    case File.ls(tmp_dir) do
      {:ok, names} ->
        Enum.each(names, fn name ->
          if String.starts_with?(name, "shuttle-ids-") do
            path = Path.join(tmp_dir, name)

            case File.lstat(path) do
              {:ok, %File.Stat{type: :directory, mtime: mtime}} ->
                mtime_seconds =
                  mtime
                  |> :calendar.datetime_to_gregorian_seconds()
                  |> Kernel.-(
                    :calendar.datetime_to_gregorian_seconds(
                      :calendar.system_time_to_universal_time(cutoff, :second)
                    )
                  )

                if mtime_seconds < 0, do: File.rm_rf(path)

              _ ->
                :ok
            end
          end
        end)

      {:error, _} ->
        :ok
    end
  end

  defp run_cli(_tool, nil, _runner, _args, _opts), do: {:error, :no_felt_store}

  defp run_cli(tool, store, runner, args, opts) when is_binary(store) do
    {result, scope} =
      case tool do
        :felt ->
          {Shuttle.CLI.run_felt(
             args,
             Keyword.merge([runner: runner, cd: store, stderr_to_stdout: false], opts)
           ), "cd #{store}"}

        :shuttle ->
          {Shuttle.CLI.run_in_store(
             store,
             args,
             Keyword.merge([runner: runner, stderr_to_stdout: false], opts)
           ), "-C #{store}"}
      end

    case result do
      {:ok, output} ->
        {:ok, output}

      {:command_error, :timeout, _output} ->
        # A timeout says nothing about the store's fibers: callers treat the
        # result as "world unknown", never as "fiber gone".
        {:error, :timeout}

      {:command_error, status, output} ->
        trimmed = String.trim(to_string(output))
        detail = if trimmed == "", do: "(no output)", else: trimmed
        {:error, "#{tool} #{Enum.join(args, " ")} (#{scope}) exited #{status}: #{detail}"}

      {:error, reason} ->
        {:error, "could not run #{tool} #{Enum.join(args, " ")} (#{scope}): #{reason}"}
    end
  end

  # Lists live shuttle worker sessions: those tmux lists, united with those
  # whose run script is still running (`Shuttle.WorkerProcess`), so a worker
  # whose tmux server lost its socket is still listed. Failure is classified
  # the same three ways as `Shuttle.Tmux.session_status/2` (see that
  # moduledoc): "no sessions" is a POSITIVE claim, made only when tmux answers
  # (exit 0, or its own absence message such as "no server running") AND the
  # process scan answers. Anything else — the runner's wall-clock `:timeout` (a
  # wedged tmux), an exec failure, an unrecognized error, or an empty tmux
  # answer the process scan could not check — returns `{:error, :unknown}`:
  # the world is UNCERTAIN, not empty. Conflating the two is how a single
  # wedged `tmux ls` mass-marked every live standing constitution dead
  # (reconcile_dead_standing_roles writes status flips to their fibers!) and
  # made boot adoption adopt nothing. Callers whose action on an empty list is
  # destructive or reconciling MUST skip the pass on `:unknown` — uncertainty
  # counts as present; the next healthy scan catches up. A listed session tmux
  # cannot see is adopted like any other; its watcher reads `:unknown` and
  # holds.
  @doc false
  def list_shuttle_sessions(state) do
    tmux =
      case state.runner.cmd("tmux", ["ls", "-F", "\#{session_name}"], stderr_to_stdout: true) do
        {output, 0} ->
          {:ok,
           output
           |> String.split("\n")
           |> Enum.map(&String.trim/1)
           |> Enum.filter(&Dispatcher.shuttle_session?/1)}

        {_output, :timeout} ->
          {:error, :unknown}

        {output, _status} ->
          # Genuine no-server exits non-zero WITH tmux's own absence message.
          # Any other failure is uncertainty.
          if Shuttle.Tmux.absence_message?(output), do: {:ok, []}, else: {:error, :unknown}
      end

    with {:ok, listed} <- tmux do
      case Shuttle.WorkerProcess.scan(state.runner) do
        {:ok, procs} -> {:ok, Enum.uniq(listed ++ Shuttle.WorkerProcess.sessions(procs))}
        {:error, :unknown} when listed == [] -> {:error, :unknown}
        {:error, :unknown} -> {:ok, listed}
      end
    end
  end

  defp schedule_tick(%State{} = state, delay_ms) when is_integer(delay_ms) and delay_ms >= 0 do
    if is_reference(state.tick_timer_ref) do
      Process.cancel_timer(state.tick_timer_ref)
    end

    tick_token = make_ref()
    timer_ref = Process.send_after(self(), {:tick, tick_token}, delay_ms)

    %{
      state
      | tick_timer_ref: timer_ref,
        tick_token: tick_token
    }
  end

  defp cancel_poll_stall_timer(%State{poll_stall_timer_ref: timer_ref} = state)
       when is_reference(timer_ref) do
    Process.cancel_timer(timer_ref)
    %{state | poll_stall_timer_ref: nil}
  end

  defp cancel_poll_stall_timer(%State{} = state), do: state

  # The store-plan task refreshes the configured list before discovery. The
  # Poller sizes the read watchdog against the returned set and each store's
  # next full/hot mode before starting the potentially long scan phase.
  defp start_poll_plan_task(parent, poll_token, %State{} = state) do
    Task.Supervisor.start_child(Shuttle.TaskSupervisor, fn ->
      result =
        try do
          {:ok, refreshed_felt_stores(state)}
        rescue
          error -> {:error, Exception.format(:error, error, __STACKTRACE__)}
        catch
          kind, reason -> {:error, Exception.format(kind, reason, __STACKTRACE__)}
        end

      send(parent, {:poll_plan, poll_token, result})
    end)
  catch
    :exit, reason -> {:error, reason}
  end

  # Poll reads are supervised but intentionally not linked to this GenServer:
  # the watchdog must be able to kill one wedged read without taking the
  # Poller down with it. Both the watchdog and terminate/2 reap the current phase.
  defp start_poll_read_task(parent, poll_token, %State{} = state) do
    Task.Supervisor.start_child(Shuttle.TaskSupervisor, fn ->
      send(parent, {:poll_world, poll_token, poll_reads(state)})
    end)
  catch
    :exit, reason -> {:error, reason}
  end

  defp stop_poll_task(nil), do: :ok

  defp stop_poll_task(task_pid) when is_pid(task_pid) do
    if Process.alive?(task_pid), do: Process.exit(task_pid, :kill)
    :ok
  end

  defp stop_poll_task(%State{} = state) do
    stop_poll_task(state.poll_task_pid)
    %{state | poll_task_pid: nil}
  end

  defp add_poll_health(snapshot, %State{} = state) do
    Map.put(snapshot, :poll_health, %{
      state: if(state.poll_check_in_progress, do: "reading", else: "idle"),
      stall_timeout_ms: state.stall_timeout_ms,
      discovery: discovery_snapshot(state),
      stalls: state.poll_stalls,
      last_stalled_at: iso8601_or_nil(state.last_poll_stalled_at)
    })
  end

  defp discovery_snapshot(state) do
    Map.new(state.felt_stores, fn store ->
      info = Map.get(state.discovery, store, %{})

      {store,
       %{
         mode: Map.get(info, :mode, :full),
         last_full_duration_ms: Map.get(info, :last_full_duration_ms),
         last_full_completed_at: epoch_iso(Map.get(info, :last_full_completed_at)),
         next_full_due_at: epoch_iso(Map.get(info, :next_full_due_at)),
         hot_set_size: Map.get(info, :hot_size, 0)
       }}
    end)
  end

  defp epoch_iso(ms) when is_integer(ms) do
    ms |> DateTime.from_unix!(:millisecond) |> DateTime.to_iso8601()
  end

  defp epoch_iso(_), do: nil

  defp schedule_poll_cycle do
    # Small delay to let any pending messages settle
    :timer.send_after(20, self(), :run_poll_cycle)
    :ok
  end

  @doc false
  def runtime_seconds(%DateTime{} = started_at, %DateTime{} = now) do
    max(0, DateTime.diff(now, started_at, :second))
  end

  def runtime_seconds(_, _), do: 0

  # Re-reads the configured host list each poll cycle, so registry or env changes
  # are picked up without a daemon restart. Runs inside the poll Task, which is
  # why the symlinked-substore walk belongs here too: `refresh_expanded_stores/0`
  # re-walks it on its own multi-minute cadence and publishes the result, leaving
  # `configured_stores/0` a pure cache read for the board's request path. No-op
  # when the caller passed an explicit :felt_stores opt.
  defp refreshed_felt_stores(%{auto_discover_felt_stores: false} = state),
    do: state.felt_stores

  defp refreshed_felt_stores(_state), do: Shuttle.FeltStores.refresh_expanded_stores()
end
