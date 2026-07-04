defmodule Shuttle.Poller do
  @moduledoc """
  Polls the felt fiber tree and dispatches workers for eligible constitutions.

  A single GenServer owns the dispatch tick, eligibility predicate, retry
  scheduling, and reconciliation. It starts `Shuttle.WorkerWatcher` processes
  under a `DynamicSupervisor` to track each worker's tmux session from outside.

  ## Multi-host support

  The Poller manages one or more felt stores on the same machine. Configure via:

      config :shuttle, felt_stores: ["~/some-store", "~/other-project"]
      # or env var (comma-separated, takes precedence over the persisted file):
      FELT_STORES=~/some-store,~/other-project
      # or persisted registration written through the HTTP API:
      ~/.config/felt/stores.json

  The registry is the source of truth: when no env or config hosts are set, the
  configured list comes straight from the registry (empty if none registered).

  Each fiber resolves to exactly one host: the first configured host whose
  `.felt/` directory contains the fiber file. The resolution is cached in
  `State.fiber_host_cache` for the daemon's lifetime. Call
  `bust_fiber_host_cache/1` or `POST /api/v1/cache/bust` to evict an entry
  when a fiber moves between hosts.
  """

  use GenServer
  require Logger

  alias Shuttle.{
    ActionQueries,
    Dispatcher,
    LifecycleStore,
    StandingRole,
    WorkerWatcher
  }

  alias Shuttle.Poller.Snapshot
  alias Shuttle.Poller.SessionReconciliation
  alias Shuttle.Poller.StandingRoles

  @default_poll_interval_ms 30_000
  @default_max_concurrent_workers 10
  @default_heartbeat_interval_ms 5_000
  # THE boot-quarantine default: a freshly (re)started daemon parks every
  # autonomous dispatch until a human releases it (POST
  # /api/v1/quarantine/release / `bin/shuttle release`) — no timeout, no
  # self-clearing. Single source of truth; config (`:boot_quarantine`) and the
  # start_link opt override it (config/test.exs sets false so dispatch tests
  # exercise the tick directly; quarantine tests opt back in per-poller).
  @default_boot_quarantine true
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
  # Lifetime-based on purpose: it needs no felt-history handoff signal, so it
  # survives the history-shed rework intact.
  @resume_loop_rapid_exit_threshold_ms 90_000
  @resume_loop_max_rapid_exits 5
  @resume_loop_cooldown_ms 600_000

  defmodule State do
    @moduledoc false
    defstruct [
      # Stable reference for cross-process messaging (e.g. WorkerWatcher →
      # Poller exit notifications). Captured from the Poller's registered
      # name in init/1, falling back to self()'s pid if unnamed (test
      # scenarios). Watchers store this as `:poller` and `send/2` resolves
      # the registered atom at delivery time, which survives a Poller
      # supervisor restart — pids do not (the old pid is dead, sends are
      # silently dropped, and `state.running` ghosts forever). See
      # [[ai-futures/shuttle/finding-ghost-workers-stuck-running]].
      :self_ref,
      :poll_interval_ms,
      :max_concurrent_workers,
      :heartbeat_interval_ms,
      :tick_timer_ref,
      :tick_token,
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
      # In-memory watcher registry, keyed by intrinsic UID when known; metadata
      # carries :fiber_id as the felt address used for CLI shell-outs and public
      # API payloads. NOT persisted — tmux is the
      # source of truth for liveness, so a restart re-derives `running` by
      # adopting live shuttle sessions (`adopt_orphans`) and every poll
      # reconciles entries whose tmux session has died.
      running: %{},
      # MapSet of runtime keys (uid when the fiber carries one, else slug —
      # identical to a `running` key) for fibers with a live or queued worker.
      # Re-keyed off slug in the identity cutover so it shares `running`'s key:
      # the only slug consumer left is felt I/O.
      claimed: MapSet.new(),
      reservations: %{},
      standing_roles: [],
      orphans: [],
      # %{fiber_id => felt_store} — populated by discover_candidates/1 on each
      # poll cycle and by host_for_fiber/2 on demand. Entries are never evicted
      # automatically; call bust_fiber_host_cache/1 when a fiber moves hosts.
      fiber_host_cache: %{},
      # %{uid => slug} — boundary uid→slug RESOLUTION index, rebuilt each poll
      # from the candidate rows (every row carries both `id` and `uid`). It lets
      # a uid-shaped public call (the kanban action-menu hot path — the UI posts
      # uid, and most cards aren't running) resolve to felt's slug address with
      # an O(1) map hit instead of a synchronous cross-store `felt ls` walk
      # inside the GenServer. This serves felt I/O ONLY; runtime state stays
      # keyed by uid. It is NOT the deleted `fiber_uid_cache`/`address_*`
      # runtime-keying bridge and carries none of its semantics — a cold miss
      # falls through to felt, never to a uid→slug runtime translation.
      uid_slug_index: %{},
      # %{uid_or_fiber_id => %{modified_at: String.t() | nil, entry: map()}} —
      # daemon-local document cache for the Portolan kanban feed. The poll task
      # diffs the cheap shuttle projection's modified_at against this cache and
      # runs full `felt show --json` only for cold or changed fibers.
      document_cache: %{},
      document_cache_stats: %{hits: 0, misses: 0, evictions: 0, entries: 0},
      document_cache_ready: false,
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
      # %{runtime_key => unix_ms} — the instant a standing role was re-armed by
      # accept/resume, keyed by runtime key (uid when present, else slug) so a
      # rename mid-cycle can't strand the stamp. One of the "last serviced"
      # signals the due rule anchors on (alongside the fiber's
      # dispatched_at/handed_off_at and its creation): it marks the just-served
      # occurrence so the role isn't immediately re-served when accept flips
      # closed→active. The within-lifetime fast path; the durable backstop is the
      # `shuttle.handed_off_at` the re-arm stamps (`LifecycleStore`). NOT
      # persisted; a restart loses nothing that field doesn't already carry.
      rearmed_at: %{},
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
      # runtime-observation, never on-disk markers: that is what makes it immune
      # to the stale-row escape that sank an earlier resume exemption (a stale
      # `dispatched_at` could masquerade as a resume and dispatch FRESH).
      #
      # Human force-dispatch bypasses (and does not clear) the quarantine. Set at
      # init from the `:boot_quarantine` opt / app config (default true;
      # config/test.exs disables it).
      # See [[ai-futures/shuttle/restart-not-dispatch-authority]].
      boot_quarantine: false,
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
      # %{host => rows} — the last SUCCESSFUL `felt ls` shuttle listing per
      # host, retained VERBATIM (no reshape: `created_at`, `tempered`, `slug`,
      # … survive exactly as felt emitted them). Refreshed on every successful
      # listing; served by `discover_candidates/1` when a host's listing fails
      # (timeout, transient exec error), so an outage degrades to yesterday's
      # truth instead of blanking the store or serving a lossy six-key shadow.
      # The retention is OUTAGE-LONG, not one-tick: rows persist until the
      # host's next successful listing replaces them (only a successful
      # listing that omits a fiber is deletion evidence). Safe because these
      # rows only nominate candidates — `Dispatcher.dispatch` re-fetches the
      # fiber and re-verifies status before any launch.
      last_known_listings: %{}
    ]
  end

  # ── Client ──

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  @spec snapshot() :: map()
  def snapshot, do: snapshot(__MODULE__)

  @spec snapshot(GenServer.server()) :: map()
  def snapshot(server) do
    GenServer.call(server, :snapshot)
  end

  @spec snapshot(GenServer.server(), non_neg_integer()) :: map()
  def snapshot(server, timeout_ms) when is_integer(timeout_ms) and timeout_ms >= 0 do
    GenServer.call(server, :snapshot, timeout_ms)
  end

  @spec cached_fiber_documents(keyword() | GenServer.server()) :: {:ok, map()} | {:error, term()}
  def cached_fiber_documents(opts_or_server \\ [])

  def cached_fiber_documents(opts) when is_list(opts),
    do: cached_fiber_documents(__MODULE__, opts)

  def cached_fiber_documents(server), do: cached_fiber_documents(server, [])

  @spec cached_fiber_documents(GenServer.server(), keyword()) :: {:ok, map()} | {:error, term()}
  def cached_fiber_documents(server, opts) do
    GenServer.call(server, {:cached_fiber_documents, opts}, @orchestrator_state_call_timeout_ms)
  end

  @doc """
  Returns the serve-time runtime overlay for live workers.

  This is the document-feed liveness projection without the document feed: a
  controller that has just read fresh felt rows can stamp the same `runtime`
  payloads the poller-owned cache would have carried, even when that cache is
  cold or intentionally bypassed.
  """
  @spec runtime_index(GenServer.server()) :: map()
  def runtime_index(server \\ __MODULE__) do
    GenServer.call(server, :runtime_index, @orchestrator_state_call_timeout_ms)
  catch
    :exit, _ -> %{}
  end

  @doc """
  Returns the serve-time held overlay for boot-quarantine-parked launches.

  The parked-launch analog of `runtime_index/1`: keyed by fiber_id/uid so the
  owning host's per-fiber feed can stamp a `held` marker onto a card WITHOUT any
  board-side lookup of the daemon-global `pending_launch`. A parked (fresh,
  awaiting-release) launch reads as `held` on its card; released or reclassified
  work carries no entry and the marker clears.
  """
  @spec parked_index(GenServer.server()) :: map()
  def parked_index(server \\ __MODULE__) do
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
  def refresh_document(server \\ __MODULE__, fiber_id) when is_binary(fiber_id) do
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
  def worker_status(fiber_id), do: worker_status(__MODULE__, fiber_id)

  @spec worker_status(GenServer.server(), String.t()) :: map() | nil
  def worker_status(server, fiber_id) do
    GenServer.call(server, {:worker_status, fiber_id})
  end

  @spec dispatch_fiber(String.t(), keyword()) :: {:ok, String.t()} | {:error, atom()}
  def dispatch_fiber(fiber_id, opts \\ []), do: dispatch_fiber(__MODULE__, fiber_id, opts)

  @spec dispatch_fiber(GenServer.server(), String.t(), keyword()) ::
          {:ok, String.t()} | {:error, atom()}
  def dispatch_fiber(server, fiber_id, opts) do
    GenServer.call(server, {:dispatch, fiber_id, opts}, @dispatch_call_timeout_ms)
  end

  @doc """
  First-class claim: register an already-live tmux session as the running
  worker for `fiber_id`, exactly as if the daemon had dispatched it.

  The write-and-claim path for capture sessions (a session that authored its
  own fiber claims itself), and generally any externally-spawned worker.
  Validates the fiber (exists, not closed, no live worker) and the tmux
  session, renames the session to the canonical `<leaf>-<uid>-shuttle` name
  (so restart re-adoption, dual-recognition liveness, and the kanban treat it
  identically to a dispatched worker), starts a watcher, and writes the same
  per-host dispatch marker the dispatcher writes at spawn (when `:session_uuid`
  is provided) so resume works.

  Options: `:agent` (registry name; defaults to the fiber's shuttle.agent),
  `:session_uuid` (the harness transcript UUID, for the dispatch marker).
  """
  @spec claim_session(String.t(), String.t(), keyword()) :: {:ok, map()} | {:error, term()}
  def claim_session(fiber_id, tmux_session, opts \\ []),
    do: claim_session(__MODULE__, fiber_id, tmux_session, opts)

  @spec claim_session(GenServer.server(), String.t(), String.t(), keyword()) ::
          {:ok, map()} | {:error, term()}
  def claim_session(server, fiber_id, tmux_session, opts) do
    GenServer.call(
      server,
      {:claim_session, fiber_id, tmux_session, opts},
      @dispatch_call_timeout_ms
    )
  end

  @doc """
  Hard-kill a fiber's live worker and tear down its runtime state synchronously.

  The user-gesture twin of a natural worker exit: the kanban fires this when a
  card is dragged off the in-flight column. `tmux kill-session` SIGKILLs the
  worker, the liveness watcher is stopped, and the running entry + claim are
  dropped NOW (not on the watcher's next 5s poll) so the very next composite
  feed reads the card as not-running. Crucially this does NOT write a lifecycle
  verdict — unlike `handle_worker_exit`, which marks a cyclical role
  awaiting-review on a natural exit. A user kill-and-drag means the drag *target*
  is the verdict, so the frontend's subsequent column write is the sole status
  authority; the kill only stops the process. Idempotent: `{:ok, :no_session}`
  when nothing is running for the fiber.
  """
  @spec kill_session(String.t()) :: {:ok, String.t() | :no_session}
  def kill_session(fiber_id), do: kill_session(__MODULE__, fiber_id)

  @spec kill_session(GenServer.server(), String.t()) :: {:ok, String.t() | :no_session}
  def kill_session(server, fiber_id) do
    GenServer.call(server, {:kill_session, fiber_id}, @dispatch_call_timeout_ms)
  end

  @doc """
  Spawn-without-constitution: launch a capture session (free-text prompt, no
  pre-existing fiber) in `work_dir`. See `Shuttle.Dispatcher.capture/2`.

  Options: `:agent`, `:work_dir` (required), `:felt_store` (defaults to the
  daemon's primary store).
  """
  @spec capture(String.t(), keyword()) :: {:ok, map()} | {:error, term()}
  def capture(yap, opts \\ []), do: capture(__MODULE__, yap, opts)

  @spec capture(GenServer.server(), String.t(), keyword()) :: {:ok, map()} | {:error, term()}
  def capture(server, yap, opts) do
    GenServer.call(server, {:capture, yap, opts}, @dispatch_call_timeout_ms)
  end

  @spec actions_for(String.t(), keyword()) :: {:ok, [map()]} | {:error, term()}
  def actions_for(fiber_id, opts \\ []), do: ActionQueries.actions_for(fiber_id, opts)

  @spec actions_for(GenServer.server(), String.t(), keyword()) ::
          {:ok, [map()]} | {:error, term()}
  def actions_for(server, fiber_id, opts) do
    GenServer.call(server, {:actions, fiber_id, opts}, @dispatch_call_timeout_ms)
  end

  @spec actions_for(GenServer.server(), String.t(), keyword(), non_neg_integer()) ::
          {:ok, [map()]} | {:error, term()}
  def actions_for(server, fiber_id, opts, timeout_ms) do
    GenServer.call(server, {:actions, fiber_id, opts}, timeout_ms)
  end

  @spec resolve_action(String.t(), String.t(), keyword()) :: {:ok, map()} | {:error, term()}
  def resolve_action(fiber_id, target, opts \\ []),
    do: ActionQueries.resolve_action(fiber_id, target, opts)

  @spec resolve_action(GenServer.server(), String.t(), String.t(), keyword()) ::
          {:ok, map()} | {:error, term()}
  def resolve_action(server, fiber_id, target, opts) do
    GenServer.call(server, {:resolve_action, fiber_id, target, opts}, @dispatch_call_timeout_ms)
  end

  @spec resolve_action(GenServer.server(), String.t(), String.t(), keyword(), non_neg_integer()) ::
          {:ok, map()} | {:error, term()}
  def resolve_action(server, fiber_id, target, opts, timeout_ms) do
    GenServer.call(server, {:resolve_action, fiber_id, target, opts}, timeout_ms)
  end

  @doc """
  Run a standing-role lifecycle transition (`:accept` / `:resume`) through the
  Poller so the felt-document write is atomic against poll cycles. accept/resume
  re-arm an awaiting role by writing `status: active` to the document; running
  the transition inside the GenServer keeps a concurrent
  poll from reading a half-written document.
  """
  @spec lifecycle_transition(:accept | :resume, String.t(), keyword()) ::
          {:ok, String.t()} | {:error, term()}
  def lifecycle_transition(verb, fiber_id, opts \\ []),
    do: lifecycle_transition(__MODULE__, verb, fiber_id, opts)

  @spec lifecycle_transition(
          GenServer.server(),
          :accept | :resume,
          String.t(),
          keyword()
        ) :: {:ok, String.t()} | {:error, term()}
  def lifecycle_transition(server, verb, fiber_id, opts) do
    GenServer.call(
      server,
      {:lifecycle_transition, verb, fiber_id, opts},
      @dispatch_call_timeout_ms
    )
  end

  @spec reserve_resource(String.t(), String.t(), non_neg_integer(), String.t()) ::
          {:ok, atom()} | {:error, String.t()}
  def reserve_resource(resource, host, duration_ms, fiber_id),
    do: reserve_resource(__MODULE__, resource, host, duration_ms, fiber_id)

  @spec reserve_resource(
          GenServer.server(),
          String.t(),
          String.t(),
          non_neg_integer(),
          String.t()
        ) :: {:ok, atom()} | {:error, String.t()}
  def reserve_resource(server, resource, host, duration_ms, fiber_id) do
    GenServer.call(server, {:reserve, resource, host, duration_ms, fiber_id})
  end

  @spec orchestrator_state() :: map()
  def orchestrator_state, do: orchestrator_state(__MODULE__)

  @spec orchestrator_state(GenServer.server()) :: map()
  def orchestrator_state(server) do
    GenServer.call(server, :orchestrator_state, @orchestrator_state_call_timeout_ms)
  end

  @spec orchestrator_state(GenServer.server(), non_neg_integer()) :: map()
  def orchestrator_state(server, timeout_ms) when is_integer(timeout_ms) and timeout_ms >= 0 do
    GenServer.call(server, :orchestrator_state, timeout_ms)
  end

  @doc """
  Returns `{:ok, felt_store}` for the first configured host that contains
  `fiber_id`, or `{:error, :not_found}` if the fiber isn't in any host.

  The result is cached in the Poller's state for the daemon's lifetime.
  Used by `GET /api/v1/fiber/:id/host` so external callers can route their
  felt operations to the right index without re-implementing host resolution.
  """
  @spec resolve_fiber_host(String.t()) :: {:ok, String.t()} | {:error, :not_found | :timeout}
  def resolve_fiber_host(fiber_id), do: resolve_fiber_host(__MODULE__, fiber_id)

  @spec resolve_fiber_host(GenServer.server(), String.t()) ::
          {:ok, String.t()} | {:error, :not_found | :timeout}
  def resolve_fiber_host(server, fiber_id) do
    GenServer.call(server, {:resolve_fiber_host, fiber_id})
  end

  @doc """
  Evicts the cached felt-store resolution for `fiber_id`. The daemon
  re-resolves on the next access. Use after a fiber moves between hosts.
  """
  @spec bust_fiber_host_cache(String.t()) :: :ok
  def bust_fiber_host_cache(fiber_id), do: bust_fiber_host_cache(__MODULE__, fiber_id)

  @spec bust_fiber_host_cache(GenServer.server(), String.t()) :: :ok
  def bust_fiber_host_cache(server, fiber_id) do
    GenServer.call(server, {:bust_fiber_host_cache, fiber_id})
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
  def release_boot_quarantine, do: release_boot_quarantine(__MODULE__)

  @spec release_boot_quarantine(GenServer.server()) :: :ok
  def release_boot_quarantine(server) do
    GenServer.call(server, :release_boot_quarantine)
  end

  # ── Server ──

  @impl true
  def init(opts) do
    {felt_stores, auto_discover} =
      case Keyword.fetch(opts, :felt_stores) do
        {:ok, hosts} -> {hosts, false}
        :error -> {default_felt_stores(), true}
      end

    runner = Keyword.get(opts, :runner, Shuttle.Runner.Default)
    own_host_id = Keyword.get(opts, :own_host_id, resolve_own_host_id())

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
      own_host_id: to_string(own_host_id),
      auto_discover_felt_stores: auto_discover,
      runner: runner,
      # Restart is not dispatch authority: quarantine every autonomous
      # dispatch until a human releases the hold (see the State field
      # comment). Opt wins over app config so tests can exercise the
      # quarantine per-poller; the default lives in @default_boot_quarantine.
      boot_quarantine:
        Keyword.get(
          opts,
          :boot_quarantine,
          Application.get_env(:shuttle, :boot_quarantine, @default_boot_quarantine)
        )
    }

    Logger.info("configured felt stores: #{inspect(felt_stores)}")

    # Daemon state is derived and disposable. Rebuild
    # `running` from tmux by adopting any live shuttle sessions — a restart
    # re-scans tmux and is immediately correct, and running work survives because
    # tmux owns the worker process.
    state = SessionReconciliation.adopt_orphans(state)

    # Schedule first tick immediately
    state = schedule_tick(state, 0)
    {:ok, state}
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

  def handle_info(:run_poll_cycle, %{poll_check_in_progress: true} = state), do: {:noreply, state}

  def handle_info(:run_poll_cycle, state) do
    parent = self()

    # The Task does only the slow, READ-ONLY work (felt-store walk + remote
    # SSH discovery) and returns plain data — never a `%State{}`, never a
    # mutation, never an armed timer. Keeping the slow I/O off the GenServer
    # thread preserves daemon responsiveness; making it pure means there is
    # only one mutable state (the GenServer's), so there is nothing to merge
    # when the Task completes. See `poll_reads/1` and `apply_poll_cycle/2`.
    {:ok, _pid} =
      Task.start_link(fn ->
        send(parent, {:poll_world, poll_reads(state)})
      end)

    {:noreply, %{state | poll_check_in_progress: true}}
  end

  # The poll Task finished its reads. Apply the world it observed to the
  # GenServer's CURRENT state — anything that changed during the Task (a sync
  # :dispatch, a :worker_exited retry, a :retry firing) is already reflected
  # and is simply respected by the re-validating apply, never clobbered by a
  # stale snapshot.
  def handle_info({:poll_world, {:ok, world}}, state) do
    state =
      state
      |> apply_poll_cycle(world)
      |> Map.put(:poll_check_in_progress, false)
      |> schedule_tick(state.poll_interval_ms)

    {:noreply, state}
  end

  def handle_info({:poll_world, {:error, reason}}, state) do
    Logger.error("Poll cycle failed: #{reason}")

    state =
      state
      |> Map.put(:poll_check_in_progress, false)
      |> schedule_tick(state.poll_interval_ms)

    {:noreply, state}
  end

  def handle_info({:worker_exited, fiber_id, reason, session_alive?}, state) do
    state = handle_worker_exit(state, fiber_id, reason, session_alive?)
    {:noreply, state}
  end

  def handle_info(msg, state) do
    Logger.debug("Poller ignored message: #{inspect(msg)}")
    {:noreply, state}
  end

  @impl true
  def handle_call(:snapshot, _from, state) do
    {:reply, Snapshot.build_snapshot(state), state}
  end

  def handle_call(:runtime_index, _from, state) do
    {:reply, Snapshot.runtime_index(state.running, session_activity()), state}
  end

  def handle_call(:parked_index, _from, state) do
    {:reply, Snapshot.parked_index(state.parked_launches), state}
  end

  def handle_call({:cached_fiber_documents, opts}, _from, state) do
    if state.document_cache_ready do
      # Owner-only kanban feed: the document cache holds every shuttle fiber
      # PHYSICALLY ROOTED in a configured store, which includes fibers pinned to
      # another host's `shuttle.host:`. The feed serves strictly this daemon's
      # owned rows (the same predicate the direct FiberDocuments path applies),
      # so a viewer reading us as a remote origin gets only what we own — no
      # peer-mirror rows to merge or elect.
      entries =
        state.document_cache
        |> Map.values()
        |> Enum.map(& &1.entry)
        |> Enum.filter(&owned_feed_entry?(&1, state.own_host_id))
        |> Enum.sort_by(&get_in(&1, [:fiber, "id"]))
        |> stamp_runtime(state.running)

      stores = Keyword.get(opts, :felt_stores, state.felt_stores)
      {:reply, {:ok, Shuttle.FiberDocuments.envelope(stores, entries)}, state}
    else
      {:reply, {:error, :cold_document_cache}, state}
    end
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

  def handle_call({:worker_status, fiber_id}, _from, state) do
    # `running_worker` resolves a uid or slug input through `running_key`'s scan,
    # so no separate uid→slug bridge is needed at this boundary.
    {:reply, running_worker(state, fiber_id), state}
  end

  def handle_call({:claim_session, fiber_id, tmux_session, opts}, _from, state) do
    {runtime_key, slug} = resolve_identity(state, fiber_id)
    uid = running_uid(state, slug) || if(Shuttle.ULID.valid?(runtime_key), do: runtime_key)
    {state, reply} = do_claim_session(state, slug, uid, tmux_session, opts)
    {:reply, reply, state}
  end

  def handle_call({:kill_session, fiber_id}, _from, state) do
    case running_key(state, fiber_id) do
      nil ->
        {:reply, {:ok, :no_session}, state}

      runtime_key ->
        meta = Map.get(state.running, runtime_key)
        session = meta.session
        # Stop the watcher BEFORE the kill so its has-session poll doesn't also
        # report the exit and double-handle through handle_worker_exit.
        stop_watcher(meta)
        _ = state.runner.cmd("tmux", ["kill-session", "-t", session], stderr_to_stdout: true)
        # Pure runtime teardown — drop running entry + claim, no status write.
        state = remove_running(state, runtime_key)
        {:reply, {:ok, session}, state}
    end
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
        do_capture(state, yap, work_dir, felt_store, opts)
    end
  end

  def handle_call({:dispatch, fiber_id, opts}, _from, state) do
    {runtime_key, fiber_id} = resolve_identity(state, fiber_id)
    state = reconcile_running_fiber(state, fiber_id)
    uid = running_uid(state, fiber_id) || if(Shuttle.ULID.valid?(runtime_key), do: runtime_key)
    session = Dispatcher.session_name(fiber_id, uid)

    # "New session" on an OPEN session is a CUT, not a refusal: a forced fresh
    # dispatch (force + resume_mode:"fresh" — the kanban New-session button and
    # drag-launch) stamps the clean-exit marker, kills the live tmux, and drops
    # the runtime entry, then FALLS THROUGH to the fresh dispatch below instead
    # of bouncing off `:already_running`. See cut_open_session_for_fresh/5.
    state = cut_open_session_for_fresh(state, fiber_id, runtime_key, uid, opts)

    cond do
      running_key(state, fiber_id) != nil or MapSet.member?(state.claimed, runtime_key) ->
        {:reply, {:error, :already_running}, state}

      fiber_session_live?(state, fiber_id, uid) ->
        {:reply, {:error, :already_running}, state}

      true ->
        case fetch_fiber_full(fiber_id, state) do
          {:ok, fiber} ->
            cond do
              # Human-worker fibers: the user works on them themselves;
              # there's no actual dispatch to do. Reply success without
              # touching state so the caller (kanban modal) closes
              # cleanly and the card stays in inFlight.
              human_worker?(fiber) ->
                Logger.info("API dispatch for #{fiber_id} is human-worker; no-op")
                {:reply, {:ok, "human"}, state}

              error = awaiting_ad_hoc_dispatch_error(fiber, state, opts) ->
                {:reply, error, state}

              dispatch_eligible?(fiber, state, opts) ->
                {new_state, result} = do_dispatch_fiber(state, fiber, opts)
                {:reply, result || {:ok, session}, new_state}

              true ->
                {:reply, {:error, dispatch_ineligible_reason(fiber, state, opts)}, state}
            end

          {:error, reason} ->
            {:reply, {:error, reason}, state}
        end
    end
  end

  def handle_call({:actions, fiber_id, opts}, _from, state) do
    {_runtime_key, slug} = resolve_identity(state, fiber_id)

    opts = Keyword.merge([felt_stores: state.felt_stores, runner: state.runner], opts)
    {:reply, ActionQueries.actions_for(slug, opts), state}
  end

  def handle_call({:resolve_action, fiber_id, target, opts}, _from, state) do
    {_runtime_key, slug} = resolve_identity(state, fiber_id)

    opts = Keyword.merge([felt_stores: state.felt_stores, runner: state.runner], opts)
    {:reply, ActionQueries.resolve_action(slug, target, opts), state}
  end

  def handle_call({:lifecycle_transition, verb, fiber_id, opts}, _from, state) do
    {runtime_key, slug} = resolve_identity(state, fiber_id)

    # The conclude step (`felt shuttle mark-runtime --handed-off-at`) needs the
    # injectable runner + this daemon's store set; thread them through opts.
    opts = Keyword.merge([runner: state.runner, felt_stores: state.felt_stores], opts)

    result =
      case verb do
        :accept -> LifecycleStore.accept(slug, opts)
        :resume -> LifecycleStore.resume(slug, opts)
        other -> {:error, "unknown lifecycle transition #{inspect(other)}"}
      end

    # On a successful re-arm, stamp the instant so the due-window clamp in
    # `standing_role_due?` won't re-serve the occurrence that just ran (the
    # standing-role temper oscillation). accept/resume both flip closed→active.
    # Keyed by runtime key so the poll's `last_serviced_at_ms` (which reads the
    # candidate's runtime key) finds it.
    state =
      case result do
        {:ok, _} when verb in [:accept, :resume] ->
          now_ms = DateTime.utc_now() |> DateTime.to_unix(:millisecond)
          %{state | rearmed_at: Map.put(state.rearmed_at, runtime_key, now_ms)}

        _ ->
          state
      end

    {:reply, result, state}
  end

  def handle_call({:reserve, resource, host, duration_ms, fiber_id}, _from, state) do
    key = {resource, host}
    state = clean_expired_reservations(state)
    now_ms = System.monotonic_time(:millisecond)

    case Map.get(state.reservations, key) do
      nil ->
        expires_at = now_ms + duration_ms
        reservation = %{fiber_id: fiber_id, expires_at_ms: expires_at}

        {:reply, {:ok, :reserved},
         %{state | reservations: Map.put(state.reservations, key, reservation)}}

      existing ->
        {:reply, {:error, "already reserved by #{existing.fiber_id}"}, state}
    end
  end

  def handle_call(:orchestrator_state, _from, state) do
    state = clean_expired_reservations(state)
    {:reply, Snapshot.build_full_state(state), state}
  end

  def handle_call({:resolve_fiber_host, fiber_id}, _from, state) do
    case host_for_fiber(fiber_id, state) do
      {:ok, host} ->
        # Cache the result so subsequent resolutions within the same daemon
        # lifetime skip the felt shell-out.
        new_state = %{state | fiber_host_cache: Map.put(state.fiber_host_cache, fiber_id, host)}
        {:reply, {:ok, host}, new_state}

      {:error, :not_found} ->
        {:reply, {:error, :not_found}, state}

      {:error, :timeout} ->
        {:reply, {:error, :timeout}, state}
    end
  end

  def handle_call({:bust_fiber_host_cache, fiber_id}, _from, state) do
    {:reply, :ok, %{state | fiber_host_cache: Map.delete(state.fiber_host_cache, fiber_id)}}
  end

  def handle_call(:release_boot_quarantine, _from, %{boot_quarantine: false} = state) do
    {:reply, :ok, state}
  end

  def handle_call(:release_boot_quarantine, _from, state) do
    Logger.info("boot quarantine released; fresh dispatch resumes on the next tick")
    state = %{state | boot_quarantine: false, parked_launches: %{}}
    # Tick now so parked fibers dispatch immediately, not a poll interval later.
    {:reply, :ok, schedule_tick(state, 0)}
  end

  defp do_capture(%State{} = state, yap, work_dir, felt_store, opts) do
    result =
      Dispatcher.capture(yap,
        runner: state.runner,
        work_dir: work_dir,
        felt_store: felt_store,
        agent: Keyword.get(opts, :agent),
        effort: Keyword.get(opts, :effort),
        chrome: Keyword.get(opts, :chrome) == true,
        port: Shuttle.CLI.daemon_port(),
        host: state.own_host_id
      )

    {:reply, result, state}
  end

  # Detects fibers that opted out of agent dispatch by setting
  # `shuttle.agent: human`. Used by the API dispatch path to short-circuit
  # with a friendly success and by the poller-side eligibility filter to
  # skip human-worker fibers in the auto-dispatch loop.
  defp human_worker?(fiber) do
    case get_in(fiber, ["shuttle", "agent"]) do
      "human" -> true
      _ -> false
    end
  end

  # ── Snapshot ──

  # The uid carried by a running entry matching `identifier` (by runtime key,
  # slug address, or uid), or nil when no running entry matches. Used to build
  # the uid-keyed session name for a fiber addressed by slug — the runtime
  # registry, not a cache, is the uid source now that the bridge is gone.
  defp running_uid(%State{} = state, identifier) do
    Enum.find_value(state.running, fn {key, metadata} ->
      if identifier in [key, fiber_address(metadata), metadata_uid(metadata)],
        do: metadata_uid(metadata)
    end)
  end

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
  # `dispatch_failures`/`rearmed_at` are keyed by (uid when the fiber has one,
  # else slug), and the slug is felt's address for I/O. Resolution order, each
  # step cheaper than a felt shell-out before it:
  #   1. the running registry (`running_key`'s scan) — a live fiber answers from
  #      its own metadata;
  #   2. the poll-refreshed `uid_slug_index` — a uid-shaped input maps to its
  #      slug with an O(1) hit (the kanban hot path), no felt walk;
  #   3. `FeltStores.resolve_fiber/2` — the cold-miss fallback only (a uid not
  #      seen since the last poll, or a slug input), matching the old
  #      cache-miss behavior. Falls back to `{identifier, identifier}` when felt
  #      can't resolve (preserving the prior "use the input as-is" behavior).
  # This is the single uid↔slug seam that replaced the deleted
  # `address_for_identifier` bridge — felt stays slug-addressed throughout.
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
  # felt-I/O resolution aid ONLY — runtime state stays keyed by uid; this is
  # NOT the deleted uid↔slug runtime-keying bridge.
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
    cond do
      Map.has_key?(state.running, fiber_id) ->
        fiber_id

      true ->
        Enum.find_value(state.running, fn {key, metadata} ->
          address = fiber_address(metadata)
          uid = metadata_uid(metadata)

          if fiber_id in [address, uid], do: key
        end)
    end
  end

  def running_key(_, _), do: nil

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
    state = refresh_felt_stores(state)
    {:ok, candidates, host_map, host_listings} = discover_candidates(state)
    {document_cache, document_cache_stats} = refresh_document_cache(state, candidates, host_map)

    {:ok,
     %{
       felt_stores: state.felt_stores,
       candidates: candidates,
       host_map: host_map,
       host_listings: host_listings,
       document_cache: document_cache,
       document_cache_stats: document_cache_stats
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
  # from a stale snapshot. Reconcile is reordered after discovery; the two are
  # independent given refreshed felt stores, and reconcile now sees current
  # `running` rather than the Task's snapshot.
  defp apply_poll_cycle(%State{} = state, %{
         felt_stores: felt_stores,
         candidates: candidates,
         host_map: new_host_map,
         host_listings: host_listings,
         document_cache: document_cache,
         document_cache_stats: document_cache_stats
       }) do
    state = reconcile(%{state | felt_stores: felt_stores})

    standing_roles = StandingRoles.standing_roles_from_candidates(candidates, state)

    # Merge newly resolved host entries into the cache. Existing entries
    # are not evicted — earlier-configured hosts win for ID collisions,
    # and cache entries are stable for the daemon's lifetime.
    state = %{
      state
      | fiber_host_cache: Map.merge(new_host_map, state.fiber_host_cache),
        # Rebuilt (not merged) each poll so a rename or delete can't leave a
        # stale uid→slug entry; an as-yet-unseen uid falls through to felt.
        uid_slug_index: build_uid_slug_index(candidates),
        document_cache: document_cache,
        document_cache_stats: document_cache_stats,
        document_cache_ready: true,
        standing_roles: standing_roles,
        dispatch_failures: evict_stale_dispatch_failures(state.dispatch_failures, candidates),
        resume_loop: evict_stale_resume_loop(state.resume_loop, candidates),
        # Fold this poll's SUCCESSFUL listings over the retained map (a failed
        # host keeps its previous rows), pruned to the current store set.
        last_known_listings:
          state.last_known_listings |> Map.merge(host_listings) |> Map.take(felt_stores)
    }

    # Downtime recovery: a standing role whose tmux session is gone but whose
    # document is still armed (status:active, no verdict) never fired
    # `handle_worker_exit` (the daemon was down across the exit). Scan tmux and
    # mark such roles awaiting (status:closed) so the armed document does not
    # re-fire. Oneshots need no analog: a status:active oneshot with no live
    # session is simply eligible again on the next tick — retries collapsed into
    # the poll loop.
    state = StandingRoles.reconcile_dead_standing_roles(state, candidates)

    # Parking is dispatch-authority bookkeeping, not capacity accounting: while
    # quarantined, the parked map is rebuilt from the current dispatchable set
    # on EVERY cycle (a closed fiber drops out, a newly-active one appears)
    # even when the slots are full — only actual dispatching is slot-gated.
    # The eligibility sweep shells felt per candidate, so it runs exactly when
    # its result is consumed: to park (quarantine) or to dispatch (free slots).
    {dispatchable, state} =
      cond do
        state.boot_quarantine ->
          # Splits the dispatchable set by `was_running`: in-flight work this
          # daemon observed running (adopted at boot / dispatched since)
          # re-dispatches through the reduce below, while genuinely-fresh
          # launches are parked. A just-restarted daemon grants NO fresh
          # autonomous dispatch until a human releases the hold, but never
          # strands work that was demonstrably alive moments ago.
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

    Enum.reduce(dispatchable, state, fn fiber, state_acc ->
      if available_slots(state_acc) > 0 do
        {new_state, _result} = do_dispatch_fiber(state_acc, fiber)
        new_state
      else
        state_acc
      end
    end)
  end

  # ── Orphan Resurrection ──

  # Drops dispatch_failures entries for fibers shuttle no longer intends to
  # dispatch — closed, paused (status not in {open, active}), shuttle block
  # removed, or absent from the felt store entirely. Without this, the
  # `blocked` snapshot would carry stale entries the user has no remaining
  # handle on. Active fibers with persistent failures keep their entry
  # across cycles so the kanban can show the failure count.
  defp evict_stale_dispatch_failures(failures, candidates) do
    active_ids =
      candidates
      |> Enum.filter(fn fiber -> Map.get(fiber, "status") in ["open", "active"] end)
      |> Enum.map(&Map.get(&1, "id", ""))
      |> MapSet.new()

    # Keyed by runtime key now; match the carried slug (`entry.fiber_id`)
    # against the active candidate slugs.
    Map.filter(failures, fn {_key, entry} ->
      MapSet.member?(active_ids, Map.get(entry, :fiber_id))
    end)
  end

  # Discovers candidate fibers by asking felt for a narrow shuttle projection
  # per configured store and keeping the ones physically rooted in that store.
  # No tag predicate — the shuttle: block is the source of truth, matching the
  # same contract every other surface reads.
  #
  # Returns {:ok, fibers, host_map, host_listings} where:
  #   fibers        — [%{"id" => id, "uid" => uid, "status" => status, "path" => …}] across all hosts
  #   host_map      — %{fiber_id => felt_store} for host resolution
  #   host_listings — %{host => rows} for the hosts whose listing SUCCEEDED
  #                   this poll (verbatim rows; `apply_poll_cycle/2` folds them
  #                   into `state.last_known_listings`). A failed host is
  #                   absent, so its retained rows survive untouched.
  #
  # Each fiber row carries its own "uid", so callers that need the intrinsic
  # identity read it off the candidate directly — no separate uid map.
  #
  # ## Symlink discipline
  #
  # The same physical fiber file is often reachable from multiple felt hosts via
  # symlinks. Two cases that occur in practice:
  #
  # 1. A project host (`~/work/project-a`) whose `.felt/` is a symlink into
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
  # **Rule: a fiber is enumerated only by the host where it is physically
  # rooted.** `list_shuttle_fibers/2` enforces this by reading felt's carried
  # `path` (absolute, symlink-resolved) and keeping a fiber iff that path lives
  # under `realpath(host)/.felt/` — so case 2's loom view drops the fiber (its
  # realpath roots in lightcone) and the lightcone store claims it. A store
  # whose own `.felt/` is a symlink (case 1) owns nothing; the target store
  # enumerates it. Ownership is read from felt's path, never reverse-derived.
  @doc false
  def discover_candidates(state) do
    {all_fibers, host_map, host_listings} =
      Enum.reduce(state.felt_stores, {[], %{}, %{}}, fn host,
                                                        {acc_fibers, acc_map, acc_listings} ->
        {fibers, acc_listings} =
          case list_shuttle_fibers(host, state) do
            {:ok, fibers} ->
              {fibers, Map.put(acc_listings, host, fibers)}

            {:error, reason} ->
              # A failed listing — felt timing out on an overloaded login
              # node, a transient exec failure — means the world is UNKNOWN
              # for this host, not that its fibers are gone. Dropping them
              # here used to blank the ENTIRE store for the tick: every
              # document-cache entry evicted, every card vanishing and
              # reappearing as felt recovered. Only a SUCCESSFUL listing that
              # omits a fiber is evidence of deletion, so on error we serve
              # the host's last successful listing VERBATIM (see
              # `State.last_known_listings`) — same rows, same fields, no
              # reshape — and the mtime-keyed document cache serves the
              # entries without re-shelling felt. The listing map is not
              # updated, so the retained rows survive until felt recovers.
              retained = Map.get(state.last_known_listings, host, [])

              Logger.warning(
                "fiber discovery failed for #{host} (#{inspect(reason)}); " <>
                  "carrying #{length(retained)} last-known fiber(s) for this tick"
              )

              {retained, acc_listings}
          end

        new_map =
          Enum.reduce(fibers, %{}, fn fiber, hm ->
            id = Map.get(fiber, "id", "")
            Map.put(hm, id, host)
          end)

        merged_map = Map.merge(new_map, acc_map)
        {acc_fibers ++ fibers, merged_map, acc_listings}
      end)

    {:ok, all_fibers, host_map, host_listings}
  end

  # Owner-only feed gate for a cached document entry: keep it iff its
  # `shuttle.host` equals this daemon's `own_host_id`. The same `host_owned?`
  # predicate the dispatch plane uses, so the feed and dispatch agree on the
  # single owner of each fiber.
  defp owned_feed_entry?(%{fiber: %{"shuttle" => shuttle}}, own_host_id),
    do: host_owned?(shuttle, own_host_id)

  defp owned_feed_entry?(_, _), do: false

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

  # The activity source. Defaults to the host-local WaitingTracker; overridable
  # via app env so tests inject a deterministic `session => %{last_event_at,
  # phase}` map without writing to the real events.jsonl.
  defp session_activity do
    case Application.get_env(:shuttle, :waiting_phases_source) do
      fun when is_function(fun, 0) -> fun.()
      _ -> Shuttle.WaitingTracker.session_activity()
    end
  end

  # Re-read one fiber from disk and replace its document-cache entry (or evict it
  # if the fiber no longer resolves). Backs `refresh_document/2`, the shared
  # post-mutation seam. Keyed identically to the poll's `refresh_document_cache`
  # (uid when present, else id), and any prior entries for this fiber id under a
  # different key are dropped first so a re-key can't leave a duplicate card. The
  # mtime is carried so the next poll's `reusable_document_cache_entry?` reuses
  # this fresh read instead of re-shelling felt.
  defp refresh_document_entry(%State{} = state, fiber_id) do
    without_fiber =
      :maps.filter(
        fn _key, %{entry: entry} -> get_in(entry, [:fiber, "id"]) != fiber_id end,
        state.document_cache
      )

    case Shuttle.FiberDocuments.get(fiber_id, felt_stores: state.felt_stores) do
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

  # The poll-cycle document cache lives in `Shuttle.Poller.DocumentCache`; the
  # cache itself stays on `State`. felt shell-out is injected as a closure so
  # `run_felt/3` stays private to the poller.
  defp refresh_document_cache(%State{} = state, candidates, host_map) do
    run_felt = fn store, args -> run_felt(store, state.runner, args) end
    Shuttle.Poller.DocumentCache.refresh(state, candidates, host_map, run_felt)
  end

  # Read one host's shuttle fibers via felt's JSON, keeping only those
  # PHYSICALLY ROOTED in this host. Ownership is read from felt's carried
  # `path` (absolute, symlink-resolved) — a fiber belongs to `host` iff its
  # path lives under `realpath(host)/.felt/`. felt enumerates symlink-traversed
  # fibers too (loom listing a project whose `.felt` is symlinked in), so the
  # path-prefix check is what keeps each fiber owned by exactly the store that
  # physically roots it — the discipline the old filesystem walk + canonical-id
  # match enforced, now read from felt rather than reverse-derived. A store
  # whose own `.felt/` is a symlink owns nothing here: the target store
  # enumerates it canonically.
  defp list_shuttle_fibers(host, state) do
    felt_dir = Path.join(host, ".felt")

    case File.lstat(felt_dir) do
      {:ok, %File.Stat{type: :symlink}} ->
        {:ok, []}

      {:ok, %File.Stat{type: :directory}} ->
        # An empty store has nothing to enumerate; skip the felt shell-out so a
        # store with no fibers costs nothing (and so a daemon polling an empty
        # configured store doesn't shell felt every tick).
        if empty_dir?(felt_dir) do
          {:ok, []}
        else
          run_shuttle_listing(host, state)
        end

      _ ->
        {:ok, []}
    end
  end

  defp empty_dir?(dir) do
    case File.ls(dir) do
      {:ok, entries} -> entries == []
      _ -> true
    end
  end

  defp run_shuttle_listing(host, state) do
    case run_felt_ls_for_shuttle(host, state) do
      {:ok, output} ->
        with {:ok, fibers} when is_list(fibers) <- Jason.decode(output) do
          owned_prefix = store_felt_realpath(host) <> "/"

          # Per-row isolation: felt itself skips-and-warns unparseable fibers
          # (warning on stderr, valid JSON of the rest on stdout, exit 0), so a
          # single malformed fiber never poisons the blob. The `is_map/1` guard
          # is the same posture on our side of the wire — one non-map row is
          # dropped, never the whole host's listing.
          kept =
            Enum.filter(fibers, fn fiber ->
              is_map(fiber) and is_map(Map.get(fiber, "shuttle")) and
                owned_by_store?(fiber, owned_prefix)
            end)

          {:ok, kept}
        else
          _ -> {:error, :invalid_json}
        end

      {:error, reason} ->
        {:error, reason}
    end
  end

  # A fiber is owned by this store iff felt's carried physical `path` lives
  # under `realpath(host)/.felt/`. No `path` (older felt) means we cannot
  # confirm ownership, so the fiber is conservatively dropped — the owning
  # store, where felt does carry a matching path, enumerates it.
  defp owned_by_store?(%{"path" => path}, owned_prefix) when is_binary(path) and path != "" do
    String.starts_with?(path, owned_prefix)
  end

  defp owned_by_store?(_, _), do: false

  defp run_felt_ls_for_shuttle(host, state) do
    # Cheap projection: felt filters by raw top-level frontmatter first, then
    # emits only fields the poller needs for eligibility, ownership, and identity.
    # Keep the broad fallback so a not-yet-upgraded remote felt fails soft
    # instead of hiding every card on that city.
    case run_felt(host, state.runner, [
           "ls",
           "--json",
           "--has-field",
           "shuttle",
           "--json-field",
           "id,uid,status,shuttle,path,modified_at"
         ]) do
      {:ok, output} ->
        {:ok, output}

      # A timeout means felt itself is wedged (overloaded node, dead SSH), not
      # that the flags were unsupported — the strictly-more-expensive broad
      # listing would just burn a second 60s wall-clock stall per host per
      # tick. Propagate immediately; discover_candidates degrades to the
      # host's last-known rows.
      {:error, :timeout} = error ->
        error

      {:error, reason} ->
        Logger.warning(
          "shuttle felt ls failed for #{host}; falling back to broad listing: #{inspect(reason)}"
        )

        run_felt(host, state.runner, ["ls", "--json"])
    end
  end

  # Realpath of `<host>/.felt`, resolving symlinks along the path so the
  # ownership prefix matches felt's symlink-resolved `path`. See Shuttle.Realpath.
  defp store_felt_realpath(host) do
    felt_dir = host |> Path.join(".felt") |> Path.expand()

    case Shuttle.Realpath.resolve(felt_dir) do
      {:ok, resolved} -> resolved
      {:error, _} -> felt_dir
    end
  end

  # The autonomous-tick eligibility filter. Beyond the shared `eligible?`
  # predicate, the tick excludes pinned roles: a pinned role is an INTERACTIVE
  # INTERFACE (a status hub, a debug intake), not autonomous work. The human
  # starts it (drag-to-in-flight / New session / Resume — all force-dispatch),
  # the worker stays attached as the interface, and the session ends when the
  # human ends it. The poll loop must never re-spawn it: a pinned `active` role
  # whose session has ended (human closed the chat, worker crashed) would
  # otherwise re-dispatch every tick — surveying, finding nothing, exiting —
  # burning tokens on an idle interface (the shapepipe redispatch loop). Pinned
  # roles remain explicitly dispatchable: force-dispatch bypasses this entirely,
  # and a plain `felt shuttle dispatch <id>` still routes through `eligible?`
  # (which has no pinned gate), so only the *autonomous* path is severed.
  # See [[ai-futures/shuttle/findings/finding-pinned-roles-are-interfaces-not-loops]].
  defp filter_eligible(candidates, state) do
    Enum.filter(candidates, fn fiber ->
      eligible?(fiber, state) and not pinned_role?(fiber)
    end)
  end

  # Boot quarantine gate on the autonomous tick (see the State field comment):
  # a just-restarted daemon grants no *fresh* autonomous dispatch, but never
  # strands in-flight work it observed running. Splits the dispatchable set by
  # `was_running` (runtime keys this daemon saw alive under its own uptime —
  # adopted at boot, or dispatched/claimed since):
  #
  #   - Members re-dispatch: they are the sanctioned continuation of work that
  #     was demonstrably alive moments ago, so they flow out as the returned
  #     dispatchable list and the reduce launches them (resume-vs-fresh decided
  #     downstream by `continuation.ex`, unchanged). Once running they leave the
  #     candidate set, so there is no repeated dispatch.
  #   - Non-members park into `parked_launches` for the snapshot's
  #     `pending_launch` rows (and the board's `held` indicator).
  #
  # The predicate is runtime-observation, never on-disk markers — which is what
  # closes the escape that sank an earlier resume exemption: it classified on
  # cached `dispatched_at`/`handed_off_at` rows, so a stale dirty-death row could
  # slip the gate and dispatch FRESH. A fiber the daemon never saw running is
  # parked no matter what its markers say. The parked map is rebuilt from the
  # current fresh set each cycle (a fiber that closes/pauses/reclassifies as
  # was-running drops out on its own); `parked_at` is preserved for fibers that
  # stay parked. Only this tick path is gated: the explicit `{:dispatch, …}` call
  # (kanban force-dispatch, claim) never routes here. Called only while
  # quarantined (`apply_poll_cycle`'s cond clears the parked map on the other
  # branches).
  defp park_autonomous_launches(dispatchable, %State{} = state) do
    now = DateTime.utc_now()

    {resume, fresh} =
      Enum.split_with(dispatchable, fn fiber ->
        MapSet.member?(state.was_running, runtime_key_for_fiber(fiber))
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

  defp pinned_role?(fiber) do
    case Map.get(fiber, "shuttle") do
      shuttle when is_map(shuttle) ->
        role_kind(shuttle) == "pinned"

      _ ->
        false
    end
  end

  defp eligible?(fiber, state) do
    status = Map.get(fiber, "status", "")
    fiber_id = Map.get(fiber, "id", "")
    shuttle = Map.get(fiber, "shuttle")

    if is_map(shuttle) do
      cond do
        # Human-worker fibers opt out of auto-dispatch entirely. The user
        # is doing the work themselves; the kanban shows the card in
        # inFlight via status:active, but Shuttle never tries to spawn
        # anything. This is the sole gate that keeps human-worker fibers out
        # of dispatch.
        human_worker?(fiber) ->
          false

        # Must target this daemon. Exactly `block.host == own_host_id`; an
        # absent host is unowned and ineligible everywhere (no wildcard, no
        # "local" default).
        not host_owned?(shuttle, state.own_host_id) ->
          false

        # A declared project_dir must exist on this host — disqualify, don't
        # downgrade the worker cwd to a felt store.
        not project_dir_available?(shuttle) ->
          false

        # `status: active` is the SOLE dispatch gate. A fiber is shuttle-managed
        # iff it carries a shuttle: block;
        # it dispatches iff status is active. `open` is a draft/paused (not
        # dispatched); `closed` is the awaiting-review / anti-oscillation gate —
        # a oneshot terminus, or a standing role that ran this cycle and is
        # `status: closed` + untempered pending a human verdict. Re-arming is an
        # explicit accept that writes `status: active`. This keeps tempered
        # fibers from ever oscillating back to dispatching on a later poll (the
        # citation-audit-skill tempered-never-reverts invariant).
        status != "active" ->
          false

        # Must not already be running
        running_key(state, fiber_id) != nil ->
          false

        # Must not be claimed (retry queued). `claimed` is keyed by runtime key
        # (uid when present), so match the candidate's runtime key, not its slug.
        MapSet.member?(state.claimed, runtime_key_for_fiber(fiber)) ->
          false

        # Resume-loop circuit breaker is open: this fiber's workers keep dying
        # almost immediately, so autonomous re-dispatch is paused for a cooldown
        # (it surfaces as `blocked`). A human force-dispatch bypasses eligible?
        # entirely and clears the breaker; a healthy run clears it on exit.
        resume_loop_open?(state, runtime_key_for_fiber(fiber)) ->
          false

        # Pinned roles need no bespoke branch HERE: this predicate also serves
        # the explicit-dispatch path (`felt shuttle dispatch`, plain POST
        # /dispatch), where a pinned role IS eligible — it's a human asking for
        # it. The autonomous tick is what must never loop a pinned interface;
        # that exclusion lives in `filter_eligible/2` (the tick's only caller),
        # not here. A pinned `active` role with no live session therefore sits
        # idle until the human re-attaches, instead of re-dispatching every
        # poll.

        # Standing roles have additional preconditions; oneshots go to dep check.
        # Support both new-format (kind:) and old-format (mode:) shuttle blocks.
        role_kind(shuttle) == "standing" ->
          StandingRoles.standing_role_due?(fiber, state)

        # Dependencies must be satisfied
        true ->
          dependencies_satisfied?(fiber_id, state)
      end
    else
      false
    end
  end

  # Eligibility for an explicit dispatch call (POST /api/v1/dispatch).
  #
  # Three modes, in priority order:
  #
  #   1. `force: true` — manual human-triggered dispatch from the kanban
  #      "New session" / "Resume" buttons. Bypasses every condition except
  #      the ones that *can't* be overridden by intent: a shuttle block must
  #      exist (we need an agent + project_dir to spawn), the host must
  #      match (we can't conjure a worker on the wrong machine), and the
  #      fiber must not be a human-worker (no machine to spawn). Status,
  #      enabled, kind, review_state, schedule, validity, and dependencies
  #      are all overridden. Closed, composted, disabled, not-yet-due, and
  #      unvalidated fibers all dispatch on force.
  #
  #   2. `ad_hoc: true` (without `force`) — legacy manual trigger for
  #      standing roles that bypasses the schedule but still requires the
  #      role to be otherwise dispatchable (enabled, active, valid, in a
  #      scheduleable review state). Kept for callers that still rely on it.
  #
  #   3. Default — full `eligible?` check (status, enabled, schedule,
  #      review state, deps, validity).
  defp dispatch_eligible?(fiber, state, opts) do
    cond do
      Keyword.get(opts, :force, false) ->
        force_dispatch_eligible?(fiber, state)

      Keyword.get(opts, :ad_hoc, false) and force_dispatchable_standing_role?(fiber, state) ->
        dependencies_satisfied?(Map.get(fiber, "id", ""), state)

      true ->
        eligible?(fiber, state)
    end
  end

  # Force-dispatch predicate: only the irreducible requirements. The user
  # explicitly clicked dispatch; honor the intent.
  defp force_dispatch_eligible?(fiber, state) do
    shuttle = Map.get(fiber, "shuttle")

    cond do
      not is_map(shuttle) -> false
      human_worker?(fiber) -> false
      not host_owned?(shuttle, state.own_host_id) -> false
      true -> true
    end
  end

  # Names WHY a dispatch was refused so the kanban can say something true
  # instead of the catch-all "disabled, not yet due, or closed". The most
  # common confusing case is a remote-homed fiber dispatched against the wrong
  # daemon: a force-dispatch of a `host: cineca` fiber that reaches any daemon
  # whose `own_host_id != cineca` fails `host_owned?` and used to report a flat
  # `not_eligible`. The reason atoms (`:homed_elsewhere`, `:project_dir_missing`,
  # `:disabled`, `:closed`, `:human_worker`, `:no_shuttle_block`,
  # `:not_due_or_blocked`) are surfaced to the UI as accurate copy.
  #
  # Only called on the ineligible branch, so the eligible (dispatch-now) path is
  # untouched. For a force/ad_hoc dispatch the irreducible gate is `force_*`'s;
  # for a plain dispatch the fuller `eligible?` rules apply, so the reason is
  # computed against the same `force` intent the caller passed.
  defp dispatch_ineligible_reason(fiber, state, opts) do
    shuttle = Map.get(fiber, "shuttle")
    status = Map.get(fiber, "status", "")
    forced? = Keyword.get(opts, :force, false) or Keyword.get(opts, :ad_hoc, false)

    cond do
      not is_map(shuttle) ->
        {:not_eligible, :no_shuttle_block}

      human_worker?(fiber) ->
        {:not_eligible, :human_worker}

      not host_owned?(shuttle, state.own_host_id) ->
        {:not_eligible, {:homed_elsewhere, Map.get(shuttle, "host"), state.own_host_id}}

      not project_dir_available?(shuttle) ->
        {:not_eligible, {:project_dir_missing, Map.get(shuttle, "project_dir")}}

      # The remaining cases only gate a NON-forced dispatch (force overrides
      # status). status is the sole gate: a draft
      # (status: open) or a closed/awaiting fiber is reported so a plain
      # dispatch failure is legible.
      not forced? and status == "closed" ->
        {:not_eligible, :closed}

      not forced? and status != "active" ->
        {:not_eligible, :disabled}

      true ->
        {:not_eligible, :not_due_or_blocked}
    end
  end

  # Ad-hoc dispatch (`ad_hoc: true`, no `force`) bypasses the cron schedule but
  # still requires the role to be otherwise dispatchable. The gate is the felt
  # document: an armed standing role is `status:
  # active` (a closed/awaiting role is NOT ad-hoc dispatchable — its run is
  # pending a verdict).
  defp force_dispatchable_standing_role?(fiber, state) do
    status = Map.get(fiber, "status", "")
    fiber_id = Map.get(fiber, "id", "")
    shuttle = Map.get(fiber, "shuttle")

    with true <- is_map(shuttle),
         true <- host_owned?(shuttle, state.own_host_id),
         true <- status == "active",
         {:ok, role} <- StandingRoles.fetch_standing_role(fiber_id, state),
         true <- StandingRole.standing?(role),
         true <- StandingRole.valid?(role) do
      true
    else
      _ -> false
    end
  end

  # Awaiting review is felt-native: `status: closed` + untempered. A
  # NON-forced ad-hoc dispatch against a standing role in that state is refused
  # with the awaiting marker so the caller surfaces "pending a verdict" rather
  # than a flat not-eligible.
  #
  # `force: true` is the explicit human "go" from the board (New session /
  # Resume / drag-to-inFlight) — it IS the verdict, so it skips this gate and
  # `do_dispatch_fiber` re-arms the role to `status: active` as it spawns (see
  # `force_rearm_standing_role`). The gate therefore only catches the autonomous
  # poller's own ad-hoc path, which must never re-fire a role pending review.
  defp awaiting_ad_hoc_dispatch_error(fiber, state, opts) do
    if Keyword.get(opts, :ad_hoc, false) and not Keyword.get(opts, :force, false) do
      fiber_id = Map.get(fiber, "id", "")
      status = Map.get(fiber, "status", "")
      tempered = Map.get(fiber, "tempered")

      with true <- status == "closed" and is_nil(tempered),
           {:ok, role} <- StandingRoles.fetch_standing_role(fiber_id, state),
           true <- StandingRole.standing?(role) do
        {:error, {:awaiting_review, role.run_id, Map.get(fiber, "closed-at")}}
      else
        _ -> false
      end
    else
      false
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

  # A declared `project_dir` must exist on THIS host. Present-but-missing means
  # the fiber's checkout lives on another machine — disqualify here rather than
  # silently downgrading the worker cwd to a felt store (the native-desktop
  # misdispatch root cause #2). This *disqualifies, does not downgrade*. An
  # absent/empty project_dir is governed by install-time schema validation
  # (enabled blocks must carry one), not re-litigated at every poll.
  defp project_dir_available?(shuttle) when is_map(shuttle) do
    case Map.get(shuttle, "project_dir") do
      dir when is_binary(dir) and dir != "" -> File.dir?(Path.expand(dir))
      _ -> true
    end
  end

  defp project_dir_available?(_), do: true

  @doc """
  Resolves this daemon's `own_host_id` — the identity it advertises for the
  `shuttle.host` dispatch filter. Public so other callers (e.g.
  `ShuttleWeb.FiberController` when stamping a `host:` on a new fiber) share
  the exact same resolution.

  This is THE one host-identity resolver. Every surface that stamps or
  matches `shuttle.host` — the dispatch filter, the `/api/v1/fibers` owned
  feed, the CLI's `host:` stamp on new fibers, the state/reserve/snapshot
  endpoints — goes through here, so a daemon's advertised identity is
  single-valued by construction. Do not re-derive `:inet.gethostname()`
  anywhere else; that drift is exactly how candide came to own by `c03`
  (the raw hostname) while its fibers were stamped `candide` (the alias),
  and the owner-only feed silently dropped every one of them.

  Precedence:

    1. `SHUTTLE_HOST` env var, if set and non-empty. The explicit override
       and the test seam — `config/test.exs` pins it via `System.put_env/2`,
       and the daemon's tmux respawn loop can export it.

    2. `~/.shuttle/host` file (first non-empty line), if present. The durable
       per-host canonical identity: unlike the env var it survives every
       daemon launch path (`make start`, a bare `bin/shuttle start`, a
       respawn outside the loop), so the daemon *derives* its friendly name
       (`candide` instead of `c03`) rather than depending on an operator
       remembering to export it. Override the path with `SHUTTLE_HOST_FILE`.

    3. `:inet.gethostname()` — short OS hostname. Two separately-deployed
       daemons get distinct ids automatically; no per-machine config needed.

  No `Application.get_env(:shuttle, :host)` step and no `"local"` default:
  an absent `host:` is unowned everywhere, never silently grabbed.

  Raises if `:inet.gethostname/0` truly fails — a system-level problem;
  silently degrading into a no-op filter would make the failure invisible.
  """
  @spec own_host_id() :: String.t()
  def own_host_id do
    case System.get_env("SHUTTLE_HOST") do
      env when is_binary(env) and env != "" ->
        env

      _ ->
        case host_config_file_value() do
          name when is_binary(name) and name != "" ->
            name

          _ ->
            case :inet.gethostname() do
              {:ok, name} when name != [] ->
                to_string(name)

              other ->
                raise "Shuttle.Poller could not resolve own_host_id: " <>
                        ":inet.gethostname/0 returned #{inspect(other)}. " <>
                        "Set SHUTTLE_HOST=<name> or write ~/.shuttle/host."
            end
        end
    end
  end

  # First non-empty line of the `~/.shuttle/host` canonical-identity file,
  # or nil when the file is absent/empty/unreadable.
  @spec host_config_file_value() :: String.t() | nil
  defp host_config_file_value do
    path = host_config_file()

    with true <- File.exists?(path),
         {:ok, content} <- File.read(path) do
      content
      |> String.split("\n", parts: 2)
      |> List.first()
      |> to_string()
      |> String.trim()
      |> case do
        "" -> nil
        value -> value
      end
    else
      _ -> nil
    end
  end

  @spec host_config_file() :: String.t()
  defp host_config_file do
    case System.get_env("SHUTTLE_HOST_FILE") do
      v when is_binary(v) and v != "" -> Path.expand(v)
      _ -> Path.expand("~/.shuttle/host")
    end
  end

  # Internal alias used by the Poller's own startup. Kept for callsite
  # readability — `resolve_own_host_id()` reads naturally inside the
  # init/handle_call code.
  defp resolve_own_host_id, do: own_host_id()

  # Resolves which configured felt store owns `fiber_id` — the store root used
  # to shell subsequent felt commands, NOT the shuttle.host dispatch-affinity
  # field.
  #
  # Resolution order:
  # 1. State cache (fast; populated by discover_candidates/1 each poll cycle)
  # 2. Ask felt: `FeltStores.resolve_fiber/2` (against THIS daemon's
  #    `state.felt_stores`) shells `felt show -j` (or a uid scan) and reports the
  #    owning store directly, reading felt's carried path rather than
  #    reconstructing or globbing candidate files.
  #
  # Returns {:ok, host} for the store that owns the fiber, or {:error,
  # :not_found} when no configured store claims it.
  #
  # Cache updates are the caller's responsibility (discover_candidates/1 does
  # it for the whole poll cycle; handle_call(:resolve_fiber_host) returns the
  # result without caching since it can't mutate state on the reply path without
  # a cast).
  @doc false
  def host_for_fiber(fiber_id, state) do
    case Map.get(state.fiber_host_cache, fiber_id) do
      host when is_binary(host) ->
        {:ok, host}

      nil ->
        case Shuttle.FeltStores.resolve_fiber(fiber_id, state.felt_stores) do
          {:ok, %{host: host}} -> {:ok, host}
          {:error, :not_found} -> {:error, :not_found}
          {:error, :timeout} -> {:error, :timeout}
        end
    end
  end

  # Read a fiber through felt's JSON view and extract the shuttle block.
  # Felt remains the canonical reader; callers that only need shuttle-owned
  # fields route through this helper rather than reparsing frontmatter.
  @doc false
  def fetch_shuttle_block(fiber_id, state) do
    with {:ok, fiber} <- fetch_fiber_full(fiber_id, state),
         shuttle when is_map(shuttle) <- Map.get(fiber, "shuttle") do
      {:ok, shuttle}
    else
      _ -> {:error, :no_shuttle_block}
    end
  end

  # The agent id for snapshot metadata, read off felt's already-resolved record
  # (felt owns resolution; the daemon no longer re-resolves). Prefers the
  # effective `shuttle.resolved.agent.id`, falls back to the raw `shuttle.agent`
  # name, then `"unknown"` — this is a display/metadata label, never a dispatch
  # decision, so a best-effort label is correct when felt emitted no resolution.
  @doc false
  def agent_id_from_fiber(fiber) when is_map(fiber) do
    get_in(fiber, ["shuttle", "resolved", "agent", "id"]) ||
      get_in(fiber, ["shuttle", "agent"]) || "unknown"
  end

  # Returns the working directory to use when dispatching this fiber.
  #
  # When the fiber's shuttle block contains a `project_dir` key pointing to an
  # existing directory, that directory is used as the tmux session's starting
  # directory. This lets workers load the project's CLAUDE.md (read at session
  # start from CWD upwards) rather than always starting in the loom root.
  #
  # Tilde-prefixed paths are expanded. Falls back to the fiber's resolved felt
  # host (or the first configured host if resolution fails) when `project_dir`
  # is absent, empty, or does not exist on disk.
  defp fiber_work_dir(fiber_id, state) do
    fallback_host =
      case host_for_fiber(fiber_id, state) do
        {:ok, h} -> h
        {:error, _} -> List.first(state.felt_stores)
      end

    with {:ok, shuttle} <- fetch_shuttle_block(fiber_id, state),
         dir when is_binary(dir) and dir != "" <- Map.get(shuttle, "project_dir"),
         expanded = Path.expand(dir),
         true <- File.dir?(expanded) do
      expanded
    else
      _ -> fallback_host
    end
  end

  @doc false
  def dependencies_satisfied?(fiber_id, state) do
    case fetch_fiber_full(fiber_id, state) do
      {:ok, full_fiber} ->
        deps = Map.get(full_fiber, "depends_on", [])

        if deps == [] or is_nil(deps) do
          true
        else
          Enum.all?(deps, fn dep ->
            case dep_id(dep) do
              nil ->
                false

              dep_id ->
                case fetch_fiber_full(dep_id, state) do
                  {:ok, dep} -> Map.get(dep, "tempered", false) == true
                  {:error, _} -> false
                end
            end
          end)
        end

      {:error, _} ->
        false
    end
  end

  defp dep_id(dep) when is_binary(dep), do: dep
  defp dep_id(%{"id" => id}) when is_binary(id), do: id
  defp dep_id(%{id: id}) when is_binary(id), do: id
  defp dep_id(_), do: nil

  defp sort_candidates(candidates) do
    Enum.sort_by(candidates, fn fiber ->
      created = Map.get(fiber, "created_at", "")
      {created, Map.get(fiber, "id", "")}
    end)
  end

  # Re-arm a perennial role (standing or pinned) on the forced path. Returns the
  # fiber map with `status` reflected as "active" so the running-state snapshot
  # built later in this dispatch is coherent without an extra felt re-read. This
  # is what makes the board's strip → In-flight "start" gesture both spawn now
  # AND leave a pinned role looping (open → active). A failed re-arm (oneshot,
  # unreadable) is logged and the fiber passes through unchanged — force-dispatch
  # of a oneshot still spawns it for a single run.
  defp maybe_force_rearm(fiber, opts, %State{} = state) do
    if Keyword.get(opts, :force, false) and Map.get(fiber, "status") != "active" do
      fiber_id = Map.get(fiber, "id", "")

      case LifecycleStore.rearm(fiber_id, runner: state.runner, felt_stores: state.felt_stores) do
        {:ok, msg} ->
          Logger.info("force-dispatch re-arm #{fiber_id}: #{String.trim(msg)}")

          fiber
          |> Map.put("status", "active")
          |> Map.delete("tempered")
          |> Map.delete("closed-at")

        {:error, _reason} ->
          # Oneshots aren't re-armable; that's expected — force-dispatch still
          # spawns them for a single run.
          fiber
      end
    else
      fiber
    end
  end

  defp do_dispatch_fiber(%State{} = state, fiber, opts \\ []) do
    fiber_id = Map.get(fiber, "id", "")

    # A forced dispatch (the human's "go" from the board) re-arms a closed/awaiting
    # standing role to `status: active` BEFORE spawning, so the doc is coherent with
    # the running worker. The kanban's snappy reflection of that re-arm rides the
    # shared post-mutation cache refresh (`refresh_document/1`) the dispatch endpoint
    # and the transition pipeline both call — NOT an inline patch here, so the
    # autonomous poll path (which rebuilds the whole cache anyway) pays nothing.
    # No-op for active roles, oneshots, and non-forced dispatch.
    fiber = maybe_force_rearm(fiber, opts, state)

    # The runtime key (uid when the fiber carries one, else slug) keys every
    # runtime map — running, claimed, dispatch_failures. felt I/O below stays
    # addressed by the slug `fiber_id`.
    runtime_key = runtime_key_for_fiber(fiber)

    # A human force-dispatch ("New session" / "Resume" / drag-to-inFlight) is an
    # explicit "go" — clear any open resume-loop breaker so the worker spawns now
    # rather than sitting out the cooldown.
    state =
      if Keyword.get(opts, :force, false),
        do: clear_resume_loop(state, runtime_key),
        else: state

    felt_store =
      case host_for_fiber(fiber_id, state) do
        {:ok, h} -> h
        {:error, _} -> List.first(state.felt_stores)
      end

    prompt_context = dispatch_prompt_context(fiber, state, opts)

    case Dispatcher.dispatch(
           fiber_id,
           runner: state.runner,
           work_dir: fiber_work_dir(fiber_id, state),
           prompt_context: prompt_context,
           felt_store: felt_store,
           force_fresh: Keyword.get(opts, :force_fresh, false),
           force: Keyword.get(opts, :force, false),
           # STORE 3: the user's directive + continuation mode ride the dispatch
           # call (no persisted review-comment). The dispatcher inlines the
           # message into the prompt at launch and honors resume_mode.
           user_message: Keyword.get(opts, :user_message),
           resume_mode: Keyword.get(opts, :resume_mode)
         ) do
      {:ok, :human_no_op} ->
        # Human-worker fibers don't need a watcher or running-state entry —
        # the user is doing the work themselves. Return state unchanged so
        # the kanban shows the card in inFlight (status:active) without any
        # tmux session to watch.
        Logger.info("Human-worker fiber #{fiber_id} accepted; no watcher started")
        {state, {:ok, "human"}}

      {:ok, session} ->
        now = DateTime.utc_now()

        running_meta =
          %{
            fiber_id: fiber_id,
            session: session,
            agent_id: agent_id_from_fiber(fiber),
            uid: Map.get(fiber, "uid"),
            started_at: now,
            last_activity_at: now
          }
          |> Map.merge(running_prompt_metadata(prompt_context))

        case start_watcher(state, fiber_id, running_meta) do
          {:ok, running_meta} ->
            # `running` is an in-memory watcher registry, not persisted: tmux is
            # the source of truth; a restart re-adopts live sessions.
            running = Map.put(state.running, runtime_key, running_meta)

            state =
              %{
                state
                | running: running,
                  claimed: MapSet.put(state.claimed, runtime_key),
                  dispatch_failures: Map.delete(state.dispatch_failures, runtime_key)
              }
              |> note_running(runtime_key)

            {state, {:ok, session}}

          {:error, reason} ->
            # Watcher start failed: the worker may be alive in tmux. Record the
            # failure for the `blocked` snapshot; the next poll re-evaluates the
            # fiber (status:active + no watcher → eligible / adopted again).
            Logger.error("Failed to start watcher for #{fiber_id}: #{inspect(reason)}")
            state = release_claim(state, runtime_key)
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

  # The claim verb's local branch: validate fiber + live session, rename the
  # session to the canonical worker name, register it in `running` with a
  # watcher, log the dispatch-shaped history event, and refresh the document
  # cache so the board reflects the claim immediately.
  defp do_claim_session(%State{} = state, fiber_id, uid, tmux_session, opts) do
    state = reconcile_running_fiber(state, fiber_id)

    running =
      case running_key(state, fiber_id) do
        nil -> nil
        key -> Map.get(state.running, key)
      end

    # Pass the resolved uid so the pre-check sees the canonical
    # `<leaf>-<uid>-shuttle` name, not just the legacy leaf-only one — a live
    # canonical session of a not-yet-running fiber is then refused with
    # :already_running instead of degrading to a rename collision.
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
            if Map.get(fiber, "status") == "closed" do
              {state, {:error, :closed}}
            else
              register_claimed_session(state, fiber_id, fiber, tmux_session, opts)
            end
        end
    end
  end

  defp register_claimed_session(%State{} = state, fiber_id, fiber, tmux_session, opts) do
    # The session is already live; we only need a label for the running-state
    # entry. Prefer the claim's explicit `:agent` (the worker names itself),
    # else felt's resolved id, else the raw name / "unknown" — a best-effort
    # display label, never a dispatch decision.
    agent_id = Keyword.get(opts, :agent) || agent_id_from_fiber(fiber)

    # Rename to the canonical `<leaf>-<uid>-shuttle` name so everything
    # downstream — restart re-adoption, dual-recognition liveness, the kanban's
    # runtime stamp — treats the claimed session exactly like a dispatched one.
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
            # name: the restart re-adoption scan and dual-recognition liveness
            # only see `-shuttle`-suffixed canonical names, so a degraded
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
    now = DateTime.utc_now()

    running_meta = %{
      fiber_id: fiber_id,
      session: session,
      agent_id: agent_id,
      uid: Map.get(fiber, "uid"),
      started_at: now,
      last_activity_at: now
    }

    case start_watcher(state, fiber_id, running_meta) do
      {:ok, running_meta} ->
        runtime_key = runtime_key_for_fiber(fiber)

        state =
          %{
            state
            | running: Map.put(state.running, runtime_key, running_meta),
              claimed: MapSet.put(state.claimed, runtime_key),
              dispatch_failures: Map.delete(state.dispatch_failures, runtime_key)
          }
          |> note_running(runtime_key)

        log_worker_claim(state, fiber_id, Keyword.get(opts, :session_uuid))
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
  # recover its session UUID. Routes through `felt shuttle mark-runtime` (felt
  # owns the nesting — Stage 5). The store/scoped-id pair mirrors the dispatch
  # path: `host_for_fiber` (the same owning-store the poll enumerated this fiber
  # from), falling back to the primary configured store. A claim with no captured
  # session_uuid still stamps `dispatched_at` (the run-window anchor) so a clean
  # handoff can later be compared against it.
  defp log_worker_claim(%State{} = state, fiber_id, session_uuid) do
    felt_store =
      case host_for_fiber(fiber_id, state) do
        {:ok, h} -> h
        {:error, _} -> List.first(state.felt_stores)
      end

    Shuttle.Continuation.write_dispatch(state.runner, felt_store, fiber_id, %{
      session_uuid: if(is_binary(session_uuid) and session_uuid != "", do: session_uuid)
    })
  end

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

  defp reconcile(%State{} = state) do
    state = %{state | orphans: []}
    state = reconcile_fiber_closures(state)
    state = reconcile_missing_running_sessions(state)
    state = SessionReconciliation.reconcile_orphaned_sessions(state)
    state = clean_expired_reservations(state)
    state
  end

  defp reconcile_fiber_closures(%State{running: running} = state) when map_size(running) == 0 do
    state
  end

  defp reconcile_fiber_closures(%State{} = state) do
    Enum.reduce(state.running, state, fn {runtime_key, meta}, state_acc ->
      fiber_id = fiber_address(meta)

      case fetch_fiber_full(fiber_id, state_acc) do
        {:ok, fiber} ->
          if Map.get(fiber, "status") == "closed" do
            Logger.info("Fiber closed externally: #{fiber_id}; stopping watcher")
            stop_watcher(meta)
            remove_running(state_acc, runtime_key)
          else
            state_acc
          end

        {:error, _} ->
          state_acc
      end
    end)
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
    # Daemon-down analog of handle_worker_exit's standing branch. Both callers
    # — `rehydrate_running_record` (init, the daemon was down when the worker
    # died) and `reconcile_missing_running_sessions` (runtime, the watcher
    # missed the exit) — land here for a running entry whose tmux session is
    # gone. For an ordinary oneshot that's just an orphan to record; for a
    # standing role it is the exit that `handle_worker_exit` never got to run,
    # so the armed document would re-fire on the next poll. Mark it awaiting
    # (status:closed, untempered) here, keyed on the running-worker entry — a
    # role that never dispatched this cycle (e.g. a stale awaiting overlay with
    # no running row, like the live daily-practice wedge) never reaches this
    # path and cannot be regressed.
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

  # Write `status: closed` (untempered) to a standing role's document when its
  # worker died unobserved and the document is still armed. Only an owned,
  # armed (status:active, no verdict) STANDING role is touched; oneshots, pinned
  # roles (which never auto-re-fire — see standing_block?), roles this daemon
  # doesn't own, and already-closed/tempered roles are left alone. The mark is
  # idempotent: once status flips to closed the running entry is gone (the
  # caller removes it) and the `status == "active"` guard short-circuits any
  # later pass.
  defp mark_dead_standing_role_awaiting(%State{} = state, fiber_id) do
    with {:ok, fiber} <- fetch_fiber_full(fiber_id, state),
         shuttle when is_map(shuttle) <- Map.get(fiber, "shuttle"),
         true <- host_owned?(shuttle, state.own_host_id),
         true <- standing_block?(shuttle),
         "active" <- Map.get(fiber, "status", ""),
         true <- is_nil(Map.get(fiber, "tempered")) do
      Logger.info(
        "Standing role #{fiber_id} worker died unobserved (daemon-down or unwatched " <>
          "exit); marking awaiting (status:closed) so the armed document does not re-fire"
      )

      StandingRoles.mark_standing_awaiting(fiber_id)
    else
      _ -> :ok
    end
  end

  # Direct read of the STANDING (cron) signal from a shuttle: block, with no
  # lifecycle overlay merge. Supports both the new `kind:` and legacy `mode:`
  # shapes. Only standing roles need the dead-orphan awaiting mark: an armed
  # standing document (`status: active`) would re-fire on the next cron tick if
  # its worker died unobserved, so it must be closed. A PINNED role is
  # oneshot-shaped: a dead pinned worker correctly leaves the document
  # at `status: active`, and the next poll re-dispatches it (the loop) just like
  # an orphaned oneshot — there is nothing to close.
  defp standing_block?(shuttle) when is_map(shuttle) do
    role_kind(shuttle) == "standing"
  end

  defp standing_block?(_), do: false

  # The role's dispatch kind, reading the new `kind:` shape and falling back to
  # the legacy `mode:` field, defaulting to "oneshot".
  @doc false
  def role_kind(shuttle), do: Map.get(shuttle, "kind", Map.get(shuttle, "mode", "oneshot"))

  # ── Worker Exit Handling ──

  defp handle_worker_exit(%State{} = state, fiber_id, _reason, _session_alive?) do
    case running_key(state, fiber_id) do
      nil ->
        state

      runtime_key ->
        case Map.pop(state.running, runtime_key) do
          {nil, _} ->
            state

          {meta, running} ->
            state = %{state | running: running}
            fiber_id = fiber_address(meta)

            # Re-read fiber to determine next action
            case fetch_fiber_full(fiber_id, state) do
              {:ok, fiber} ->
                # The daemon does NOT write the handoff marker — the WORKER does,
                # via `felt shuttle handoff`, as its second-to-last act. A worker
                # that dies without handing off leaves no handoff marker, so the
                # next dispatch reads dirty-death → resume. The clean/dirty-death
                # distinction lives entirely in the presence (and timestamp) of
                # the worker-written handoff marker; this exit path only drives
                # the document state machine below.
                status = Map.get(fiber, "status", "")

                cond do
                  status == "closed" ->
                    # Work complete or blocked — release claim
                    release_claim(state, runtime_key)

                  standing_role?(fiber, state) ->
                    # A STANDING (cron) worker's exit makes the role awaiting
                    # review by writing `status: closed` (untempered) to the felt
                    # document — the don't-re-fire gate and the human's accept
                    # anchor, both doc-representable. Write BEFORE release_claim
                    # so the document reflects awaiting before the claim frees (a
                    # re-poll racing the release then reads `status: closed` and
                    # skips re-dispatch).
                    StandingRoles.mark_standing_awaiting(fiber_id)

                    release_claim(state, runtime_key)

                  pinned_role?(fiber) ->
                    # A PINNED interactive role's session ended — the human killed
                    # the tmux session, the worker crashed, or it exited despite
                    # the stay-alive contract. The role must NOT relaunch (the
                    # poller's filter_eligible already excludes pinned from the
                    # autonomous tick) and must NOT get stuck `active` with no live
                    # worker in In-flight. Park it back to the strip by writing
                    # `active → open`; the human re-attaches with Resume
                    # (force-dispatch → rearm). Write BEFORE release_claim so the
                    # document reflects the parked state before the claim frees.
                    StandingRoles.mark_pinned_parked(fiber_id)

                    release_claim(state, runtime_key)

                  true ->
                    # A still-active ONESHOT continuation: the next poll re-picks
                    # it and starts a fresh session (status:active + no live
                    # session → eligible; no resume_mode:previous on file —
                    # retries collapsed into the poll loop). Feed the worker's
                    # lifetime to the resume-loop breaker: a rapid death (lived <
                    # threshold) increments the count and may open the circuit; a
                    # healthy run clears it.
                    state
                    |> note_worker_lifetime(runtime_key, fiber, meta)
                    |> release_claim(runtime_key)
                end

              {:error, _} ->
                # Can't read fiber — release the claim; the next poll re-reads it.
                release_claim(state, runtime_key)
            end
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
  @doc false
  def resume_loop_open?(%State{} = state, runtime_key) do
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

  # Drops resume_loop entries for fibers shuttle no longer auto-dispatches —
  # paused, closed, shuttle block removed, or gone — so a config fix or pause
  # clears the paused state without waiting out the cooldown. Mirrors
  # evict_stale_dispatch_failures; keyed by runtime key, matched on carried slug.
  defp evict_stale_resume_loop(resume_loop, candidates) do
    active_ids =
      candidates
      |> Enum.filter(fn fiber -> Map.get(fiber, "status") in ["open", "active"] end)
      |> Enum.map(&Map.get(&1, "id", ""))
      |> MapSet.new()

    Map.filter(resume_loop, fn {_key, entry} ->
      MapSet.member?(active_ids, Map.get(entry, :fiber_id))
    end)
  end

  # ── Retry ──

  defp reconcile_running_fiber(%State{} = state, fiber_id) do
    case {running_key(state, fiber_id), running_worker(state, fiber_id)} do
      {nil, _} ->
        state

      {_, nil} ->
        state

      {runtime_key, %{session: session} = meta} ->
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

  # Is a worker present in this tmux session? `present?` treats an inconclusive
  # `has-session` as present, so reconcile won't drop a live worker's running
  # entry (nor free its name for a resume) on a transient tmux failure — only a
  # confirmed `:gone` does. The reconcile/liveness twin of dispatch's
  # check_not_running.
  defp already_running_session?(%State{} = state, session) do
    Shuttle.Tmux.present?(state.runner, session)
  end

  # Dual-recognition liveness: a fiber is running if a live tmux session exists
  # under either its uid-keyed name or the legacy leaf-only name. Used wherever
  # the caller has the fiber identity but not a stored session name.
  defp fiber_session_live?(%State{} = state, fiber_id, uid) do
    live_session_for_fiber(state, fiber_id, uid) != nil
  end

  # The fiber's *live* tmux session name (either form), preferring the uid-keyed
  # canonical name when both happen to exist. Returns nil when neither is live.
  # `uid` may be supplied by a caller that already resolved it (the dispatch and
  # adopt paths); otherwise it's read off a matching running entry.
  @doc false
  def live_session_for_fiber(%State{} = state, fiber_id, uid \\ nil) do
    fiber_id
    |> Dispatcher.session_names(uid || running_uid(state, fiber_id))
    |> Enum.find(&already_running_session?(state, &1))
  end

  defp available_slots(%State{} = state) do
    max(state.max_concurrent_workers - map_size(state.running), 0)
  end

  defp release_claim(%State{} = state, runtime_key) do
    %{state | claimed: MapSet.delete(state.claimed, runtime_key)}
  end

  # Both `running` and `claimed` are keyed by the same runtime key now, so a
  # single delete on each clears the fiber's runtime footprint.
  defp remove_running(%State{} = state, runtime_key) do
    %{
      state
      | running: Map.delete(state.running, runtime_key),
        claimed: MapSet.delete(state.claimed, runtime_key)
    }
  end

  # "New session" on a fiber that still holds an OPEN tmux session is a CUT, not
  # a refusal. A forced fresh dispatch (`force` + `resume_mode:"fresh"` — the
  # kanban New-session button and drag-launch both send these) stamps the
  # clean-exit marker, kills the live `shuttle-<id>`, and drops the runtime
  # entry, THEN lets the caller's `cond` fall through to a fresh dispatch —
  # instead of returning `:already_running`. Without this, starting fresh on an
  # open session meant the costly resume → reload-stale-transcript → handoff
  # dance this fiber's constitution set out to kill.
  #
  # Gated strictly on `force` + `resume_mode:"fresh"`: the autonomous poll never
  # carries `resume_mode`, so it can NEVER cut a live worker — only an explicit
  # human New-session can. A non-fresh force-dispatch (Resume, `"previous"`) is
  # untouched and still resumes the in-flight transcript.
  defp cut_open_session_for_fresh(%State{} = state, fiber_id, runtime_key, uid, opts) do
    forced_fresh? =
      Keyword.get(opts, :force, false) and Keyword.get(opts, :resume_mode) == "fresh"

    open? =
      running_key(state, fiber_id) != nil or
        MapSet.member?(state.claimed, runtime_key) or
        fiber_session_live?(state, fiber_id, uid)

    if forced_fresh? and open? do
      cut_open_session(state, fiber_id, runtime_key, uid)
    else
      state
    end
  end

  # The cut itself — the user-gesture twin of `kill_session`, plus the marker.
  # Stamps the clean-exit marker FIRST so a cut is robust against a failed
  # re-dispatch: even if the fresh dispatch that follows never spawns, the cut
  # session reads clean (`handed_off_at >= dispatched_at` → fresh) and the next
  # poll starts fresh rather than resuming the killed transcript.
  defp cut_open_session(%State{} = state, fiber_id, runtime_key, uid) do
    felt_store =
      case host_for_fiber(fiber_id, state) do
        {:ok, h} -> h
        {:error, _} -> List.first(state.felt_stores)
      end

    # 1. Clean-exit marker — daemon-side, no worker spawned, no transcript
    #    reload. Best-effort (logged, never raised) so it can't block the cut.
    _ = Shuttle.Continuation.mark_handed_off(state.runner, felt_store, fiber_id)

    # 2. Drop the runtime footprint + resolve the session to kill. A TRACKED
    #    worker: stop its watcher BEFORE the kill (so the watcher's has-session
    #    poll doesn't also report the exit and double-handle through
    #    handle_worker_exit) and kill exactly the session we're watching — the
    #    kill_session twin. An ORPHAN (live tmux, no running entry): resolve the
    #    live name by liveness and release any lingering claim.
    {state, session} =
      case running_key(state, fiber_id) do
        nil ->
          {release_claim(state, runtime_key), live_session_for_fiber(state, fiber_id, uid)}

        key ->
          meta = Map.get(state.running, key)
          stop_watcher(meta)
          {remove_running(state, key), meta.session}
      end

    # 3. SIGKILL the live tmux session (tracked or orphan). Idempotent — a kill
    #    on an already-gone session is harmless.
    if session,
      do: state.runner.cmd("tmux", ["kill-session", "-t", session], stderr_to_stdout: true)

    Logger.info(
      "Cut open session for #{fiber_id} (New session): clean-exit marker stamped, tmux #{session || "(none)"} killed"
    )

    state
  end

  @doc false
  def start_watcher(%State{} = state, fiber_id, metadata) do
    watcher_opts = [
      fiber_id: fiber_id,
      session: Map.fetch!(metadata, :session),
      poller: state.self_ref,
      runner: state.runner,
      heartbeat_interval_ms: state.heartbeat_interval_ms
    ]

    case DynamicSupervisor.start_child(Shuttle.WatcherSupervisor, {WorkerWatcher, watcher_opts}) do
      {:ok, watcher_pid} ->
        {:ok, Map.put(metadata, :pid, watcher_pid)}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp clean_expired_reservations(%State{} = state) do
    now_ms = System.monotonic_time(:millisecond)
    remaining = Enum.filter(state.reservations, fn {_key, res} -> res.expires_at_ms > now_ms end)
    %{state | reservations: Map.new(remaining)}
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

  # Fetch a fiber's full JSON representation via the felt CLI. Routes to the
  # fiber's owning host via host_for_fiber/2 (cache → felt resolution).
  @doc false
  def fetch_fiber_full(fiber_id, state) do
    host =
      case host_for_fiber(fiber_id, state) do
        {:ok, h} -> h
        {:error, _} -> List.first(state.felt_stores)
      end

    case run_felt(host, state.runner, ["show", fiber_id, "--json"]) do
      {:ok, output} ->
        case Jason.decode(output) do
          {:ok, fiber} -> {:ok, fiber}
          {:error, _} -> {:error, :invalid_json}
        end

      # run_felt already wraps a non-zero exit in a descriptive
      # `felt -C <host> show <id> failed: <stderr>` string. A common case here
      # is a felt-store path that doesn't exist on THIS host — e.g. a foreign
      # absolute path (`/Users/.../loom`) that another machine's portolan
      # registered. Surfacing the path + stderr instead of a bare reason is what
      # turns the old undiagnosable blank 500 into an actionable error. See
      # `gotcha-remote-daemon-foreign-felt-store-path`.
      {:error, reason} ->
        {:error, reason}
    end
  end

  # Does this role's worker exit close it to awaiting-review? Only STANDING
  # (cron-driven) roles do. Marking a role awaiting on exit is an anti-re-fire
  # gate — `status: closed` is what stops the cron from re-dispatching the role
  # again this cycle. A PINNED role does NOT come here (pinned is not
  # cyclical, just a oneshot-shaped looper): on exit-while-active it stays
  # `status: active` and re-dispatches next poll (the loop); a human stops the
  # loop by parking it (`active → open`). A pinned worker that's genuinely done
  # self-closes to `status: closed` — handled by the `status == "closed"` branch
  # before this gate is reached. The "it ran" record lives in the per-host
  # dispatch/handoff markers, not in the status field.
  defp standing_role?(fiber, state) do
    case StandingRoles.fetch_standing_role(Map.get(fiber, "id", ""), state) do
      {:ok, role} -> StandingRole.standing?(role)
      {:error, _} -> false
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

  defp dispatch_prompt_context(fiber, state, opts) do
    fiber_id = Map.get(fiber, "id", "")

    case StandingRoles.fetch_standing_role(fiber_id, state) do
      {:ok, role} ->
        if StandingRole.standing?(role) do
          now = DateTime.utc_now()

          if Keyword.get(opts, :ad_hoc, false) do
            {:standing_run, StandingRole.ad_hoc_run_id(now), :ad_hoc}
          else
            # A resumed run keeps the awaiting run's id; only a fresh scheduled
            # run mints a new id. The run id flows into the STORE-1 dispatch
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

  # Run a felt CLI command against an explicit host directory.
  # Every felt-touching helper calls this directly with the resolved host.
  #
  # On a non-zero exit, the error is a self-describing string carrying the
  # command, the host directory it ran in, the exit status, and trimmed
  # stderr. felt's own stderr for a nonexistent store can be empty (it just
  # finds no index), which previously bubbled up as a BLANK `{:error, ""}` →
  # an undiagnosable 500 at the HTTP boundary. Including the host
  # path names the actual fault — typically a felt-store path that doesn't
  # exist on this machine (a foreign absolute path registered by another
  # host's portolan).
  # No configured store to route through (empty registry) — fail soft rather than
  # crash the `is_binary(host)` clause with a FunctionClauseError.
  defp run_felt(nil, _runner, _args), do: {:error, :no_felt_store}

  defp run_felt(host, runner, args) when is_binary(host) do
    # These poller calls consume felt's stdout as JSON. Keep stderr separate:
    # felt can exit 0 while warning about unrelated unreadable fibers, and
    # folding those warnings into stdout makes the JSON undecodable.
    opts = [cd: host, stderr_to_stdout: false]

    case runner.cmd("felt", args, opts) do
      {output, 0} ->
        {:ok, output}

      {_output, :timeout} ->
        # The runner's wall-clock bound fired (felt wedged on an overloaded
        # node). Surfaced as its own atom — not folded into the exit-status
        # string — because a timeout says NOTHING about the store's fibers:
        # callers must treat it as "world unknown", never as "fiber gone"
        # (see discover_candidates/1), and the poll cycle degrades for one
        # tick instead of stalling forever.
        {:error, :timeout}

      {output, status} ->
        trimmed = String.trim(to_string(output))
        detail = if trimmed == "", do: "(no output)", else: trimmed
        {:error, "felt #{Enum.join(args, " ")} (cd #{host}) exited #{status}: #{detail}"}
    end
  end

  # Lists live shuttle tmux sessions, classifying failure the same three ways
  # as `Shuttle.Tmux.session_status/2` (see that moduledoc): "no sessions" is
  # a POSITIVE claim, and only two outcomes may make it — exit 0, or a
  # non-zero exit whose output is tmux's own absence message ("no server
  # running", …). Anything else — the runner's wall-clock `:timeout` (a wedged
  # tmux), an exec failure, an unrecognized error — returns
  # `{:error, :unknown}`: the world is UNCERTAIN, not empty. Conflating the
  # two is how a single wedged `tmux ls` mass-marked every live standing role
  # dead (reconcile_dead_standing_roles writes status flips to their fibers!)
  # and made boot adoption adopt nothing. Callers whose action on an empty
  # list is destructive or reconciling MUST skip the pass on `:unknown` —
  # uncertainty counts as present; the next healthy scan catches up.
  @doc false
  def list_shuttle_sessions(state) do
    case state.runner.cmd("tmux", ["ls", "-F", "\#{session_name}"], stderr_to_stdout: true) do
      {output, 0} ->
        sessions =
          output
          |> String.split("\n")
          |> Enum.map(&String.trim/1)
          |> Enum.filter(&Dispatcher.shuttle_session?/1)

        {:ok, sessions}

      {_output, :timeout} ->
        {:error, :unknown}

      {output, _status} ->
        # Genuine no-server exits non-zero WITH tmux's own absence message —
        # positive evidence of emptiness. Any other failure is uncertainty.
        if Shuttle.Tmux.absence_message?(output) do
          {:ok, []}
        else
          {:error, :unknown}
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

  defp schedule_poll_cycle do
    # Small delay to let any pending messages settle
    :timer.send_after(20, self(), :run_poll_cycle)
    :ok
  end

  @doc false
  def runtime_seconds(nil, _), do: 0

  def runtime_seconds(%DateTime{} = started_at, %DateTime{} = now) do
    max(0, DateTime.diff(now, started_at, :second))
  end

  def runtime_seconds(_, _), do: 0

  # Returns the configured felt stores list.
  #
  # Resolution order lives in `Shuttle.FeltStores`: `FELT_STORES` env → persisted
  # registry `~/.config/felt/stores.json` (else `[]`).
  #
  # This is the default-fallback only; explicit :felt_stores opts in start_link
  # take precedence via init/1 (and disable the per-poll refresh in that case).
  defp default_felt_stores do
    Shuttle.FeltStores.configured_hosts()
  end

  # Re-reads the configured host list and updates state.felt_stores if the list
  # changed. Called from discover_candidates/1 each poll cycle so persisted
  # host registration or env changes are picked up without a daemon restart.
  # No-op when the caller passed an explicit :felt_stores opt
  # (state.auto_discover_felt_stores == false).
  defp refresh_felt_stores(%{auto_discover_felt_stores: false} = state), do: state

  defp refresh_felt_stores(%{felt_stores: current} = state) do
    fresh = default_felt_stores()

    if fresh == current do
      state
    else
      Logger.info("felt_stores updated from env/config: #{inspect(current)} → #{inspect(fresh)}")
      %{state | felt_stores: fresh}
    end
  end
end
