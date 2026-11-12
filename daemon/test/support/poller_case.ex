defmodule Shuttle.Test.PollerCase do
  @moduledoc """
  The case template for the Poller suites (`test/shuttle/poller_*_test.exs`):
  each test gets its own `Shuttle.Test.FeltStoreRunner` and a throwaway
  `SHUTTLE_DATA_DIR`, and these helpers and fixture runners are imported.
  """

  use ExUnit.CaseTemplate

  import ExUnit.Assertions
  import ExUnit.Callbacks
  import Shuttle.Test.PollerHelpers

  alias Shuttle.DaemonHeartbeat
  alias Shuttle.Poller
  alias Shuttle.Test.FiberUid
  alias Shuttle.Test.FeltStoreRunner, as: MockRunner
  alias Shuttle.Test.Env

  # Every `:sys.get_state/2` on a Poller waits this long: on a loaded machine
  # a Poller applying a cycle can take longer than the 5 s default to answer,
  # and that is "not yet", not a failure.
  @state_timeout 30_000

  using do
    quote do
      import Shuttle.Test.TranscriptHelpers
      import Shuttle.Test.PollerHelpers
      import Shuttle.Test.PollerCase

      alias Shuttle.ActionQueries
      alias Shuttle.DaemonHeartbeat
      alias Shuttle.FeltStores
      alias Shuttle.Poller
      alias Shuttle.Poller.Snapshot
      alias Shuttle.Dispatcher
      alias Shuttle.Test.FiberUid
      alias Shuttle.Test.FeltStoreRunner, as: MockRunner
      alias Shuttle.Test.Env
      alias Shuttle.Test.PollerCase.RefusedArmRunner
      alias Shuttle.Test.PollerCase.IdentityRunner
      alias Shuttle.Test.PollerCase.NoKitty
      alias Shuttle.Test.PollerCase.PhantomRunner
      alias Shuttle.Test.PollerCase.ReapRunner
      alias Shuttle.Test.PollerCase.HeldLaunchRunner
      alias Shuttle.Test.PollerCase.CrashAfterCreateRunner
      alias Shuttle.Test.PollerCase.FailedLaunchRunner

      @state_timeout 30_000
    end
  end

  # ── Setup ──

  setup do
    Env.put_app_env(:terminal_backend, Shuttle.Terminal.Tmux)
    MockRunner.start!()
    MockRunner.reset()
    mock_felt_root = MockRunner.felt_root()
    on_exit(fn -> File.rm_rf(mock_felt_root) end)

    # Isolate the per-host runtime markers (dispatch / handoff / re-arm) under a
    # throwaway SHUTTLE_DATA_DIR so continuation/orphan tests don't bleed across
    # each other or into the developer's real ~/.shuttle.
    data_dir =
      Path.join(System.tmp_dir!(), "shuttle-poller-markers-#{System.unique_integer([:positive])}")

    File.mkdir_p!(data_dir)
    Env.put_env("SHUTTLE_DATA_DIR", data_dir)

    # Session-ledger lines land under the same throwaway dir. test_helper.exs
    # pins a suite-wide SHUTTLE_SESSIONS_FILE (keeping the suite out of the real
    # ~/.shuttle) and it wins over SHUTTLE_DATA_DIR — drop it so each test reads
    # only its own pairings.
    Env.delete_env("SHUTTLE_SESSIONS_FILE")

    on_exit(fn -> rm_rf_settled!(data_dir) end)

    :ok
  end

  defmodule RefusedArmRunner do
    def cmd("shuttle", args, opts) do
      if "reopen" in args,
        do: {"simulated arm failure", 1},
        else: MockRunner.cmd("shuttle", args, opts)
    end

    def cmd(command, args, opts), do: MockRunner.cmd(command, args, opts)
  end

  defmodule IdentityRunner do
    def cmd(command, args, opts) do
      if command == "shuttle" and "mark-runtime" in args and
           Enum.chunk_every(args, 2, 1, :discard) |> Enum.member?(["--session", ""]) and
           Shuttle.Env.app(:identity_clear_fail, false) do
        {"identity clear failed", 1}
      else
        MockRunner.cmd(command, args, opts)
      end
    end
  end

  # The kitty seam with nobody home: no live remote-control socket, so on macOS
  # there is no way to get a tmux server that the daemon is not the root of.
  defmodule NoKitty do
    def run_background(_argv, _runner), do: {:error, "no live kitty remote-control socket"}
  end

  defmodule PhantomRunner do
    def cmd("/bin/echo", args, opts), do: Shuttle.Test.FakeRex.cmd("/bin/echo", args, opts)

    def cmd(command, args, opts) do
      if command == "shuttle" and "mark-runtime" in args and
           Shuttle.Env.app(:phantom_runtime_write_fails, false),
         do: {"runtime write failed", 1},
         else: MockRunner.cmd(command, args, opts)
    end
  end

  defmodule ReapRunner do
    def cmd("kill", args, opts) do
      MockRunner.set_ps_result({"", 0})
      MockRunner.cmd("kill", args, opts)
    end

    def cmd(command, args, opts),
      do: Shuttle.Test.PollerCase.PhantomRunner.cmd(command, args, opts)
  end

  defmodule HeldLaunchRunner do
    def cmd("tmux", ["has-session" | _] = args, opts) do
      send(Shuttle.Env.app(:held_launch_test_pid), :held_launch_probe)
      MockRunner.cmd("tmux", args, opts)
    end

    def cmd(command, args, opts), do: MockRunner.cmd(command, args, opts)
  end

  # ── Claim (write-and-claim) ──

  defmodule CrashAfterCreateRunner do
    def cmd("tmux", ["new-session" | _] = args, opts) do
      MockRunner.cmd("tmux", args, opts)
      throw(:daemon_died_after_create)
    end

    def cmd(command, args, opts), do: MockRunner.cmd(command, args, opts)
  end

  defmodule FailedLaunchRunner do
    def cmd("tmux", ["new-session" | _], _opts) do
      send(Shuttle.Env.app(:failed_launch_test_pid), :failed_launch_probe)
      {"launch refused", 1}
    end

    def cmd(command, args, opts), do: MockRunner.cmd(command, args, opts)
  end

  # ── Helpers ──

  # Companion to wait_until for when the check IS the assertion (e.g. a pattern
  # match or a snapshot-shape assert). It re-runs the assertion every 5ms,
  # catching its own failure, so it passes the instant the polled state settles.
  # The poll cycle is a multi-hop async chain (tick → 20ms timer → run_poll_cycle
  # → read Task → :poll_world → apply → dispatch → Terminal.launch) that a loaded
  # machine stretches arbitrarily, so the ceiling (~30s, as wait_until's) is
  # reached only when the state never settles.
  def assert_eventually(fun, attempts \\ 6_000) do
    fun.()
  rescue
    error in [ExUnit.AssertionError, MatchError] ->
      if attempts > 0 do
        Process.sleep(5)
        assert_eventually(fun, attempts - 1)
      else
        reraise(error, __STACKTRACE__)
      end
  end

  # A ceiling of ~30 s, reached only when the condition never holds: a passing
  # test returns as soon as it does, however loaded the machine.
  def wait_until(fun, attempts \\ 6_000)

  def wait_until(fun, 0), do: fun.()

  def wait_until(fun, attempts) do
    if fun.() do
      true
    else
      Process.sleep(5)
      wait_until(fun, attempts - 1)
    end
  end

  # Drive exactly ONE poll cycle and return once its snapshot is published.
  # Every cycle a test drives goes through here. A raw `send(poller,
  # :run_poll_cycle)` is dropped while another cycle is in flight, and when it
  # lands it can leave the boot cycle unsettled — a read taken before the
  # test's next mutation (a kill, an exit, a closed fiber) that then applies
  # after it and re-dispatches.
  #
  # What a cycle merely *observes* needs the bound too:
  # `reconcile/1` resets `state.orphans` to `[]` at the top of every cycle, so
  # an orphan reports what THIS cycle saw and is gone the moment the next one
  # runs. A wall-clock wait that re-nudges the poller (the old idiom here)
  # therefore races itself — the nudged cycle sees the re-dispatched fiber's
  # live session, records no orphan, and clears the one the test was waiting
  # for, unobservably and permanently. Assert on a cycle you bounded yourself.
  #
  # Bounding is two steps, and the first one belongs BEFORE the scenario is
  # built: `settle_poller!` absorbs the cycle the poller runs 20ms after boot,
  # which otherwise lands mid-scenario and does the reconcile itself — leaving
  # the test's own cycle nothing to observe. Then run one cycle and wait for
  # `poll_cycles` to tick. Callers pass a poll_interval_ms far longer than the
  # test, so no further cycle can start behind the assertions.
  def settle_poller!(poller) do
    assert wait_until(fn ->
             state = :sys.get_state(poller, @state_timeout)
             state.poll_cycles > 0 and not state.poll_check_in_progress
           end)

    :ok
  end

  def sync_poll_cycle!(poller) do
    settle_poller!(poller)
    before = :sys.get_state(poller, @state_timeout).poll_cycles

    send(poller, :run_poll_cycle)

    assert wait_until(fn -> :sys.get_state(poller, @state_timeout).poll_cycles > before end)
    await_publication!(poller)
    :ok
  end

  def await_publication!(poller) do
    state = :sys.get_state(poller, @state_timeout)
    target = state.published_generation + if(state.published_timer_ref, do: 1, else: 0)

    assert wait_until(
             fn ->
               case Poller.published_state_response(poller) do
                 {:ok, %{generation: generation}} -> generation >= target
                 _ -> false
               end
             end,
             1_000
           )
  end

  # Every trace the `:dbg` relay has forwarded from `poller`, oldest first, then
  # tracing stops. `trace_delivered` returns once the runtime has handed all of
  # the poller's traces so far to the tracer; a sentinel sent to the tracer
  # after that is relayed after them, so receiving it means nothing is still in
  # flight. (A non-`:call` sentinel, so the tracer does not suspend the sender.)
  def drain_dbg_relay!(poller) do
    ref = :erlang.trace_delivered(poller)
    assert_receive {:trace_delivered, ^poller, ^ref}
    {:ok, tracer} = apply(:dbg, :get_tracer, [])
    sentinel = make_ref()
    send(tracer, {:trace, self(), :dbg_sentinel, sentinel})
    traces = receive_dbg_relay_until(sentinel, [])
    apply(:dbg, :stop_clear, [])
    traces
  end

  def receive_dbg_relay_until(sentinel, acc) do
    receive do
      {:dbg_relay, {:trace, _pid, :dbg_sentinel, ^sentinel}} -> Enum.reverse(acc)
      {:dbg_relay, msg} -> receive_dbg_relay_until(sentinel, [msg | acc])
    after
      30_000 -> flunk("the :dbg relay never forwarded its sentinel")
    end
  end

  def shuttle_show_count do
    Enum.count(MockRunner.commands(), fn {cmd, args} ->
      cmd == "shuttle" and Enum.take(args, 1) == ["show"]
    end)
  end

  def new_session_scripts do
    MockRunner.commands()
    |> Enum.filter(fn {cmd, args} -> cmd == "tmux" and hd(args) == "new-session" end)
    |> Enum.map(fn {_cmd, args} -> List.last(args) end)
  end

  # Mirror the dispatcher's at-spawn dispatch stamp: `session_uuid` +
  # `dispatched_at` into the fiber's `shuttle:` block. The optional `at` lets a
  # test back-date the dispatch so a later handoff can be ordered relative to it.
  def write_dispatch_marker(id, session_id, at \\ DateTime.utc_now()) do
    MockRunner.put_shuttle_fields(id, %{
      "session_uuid" => session_id,
      "dispatched_at" => DateTime.to_iso8601(at)
    })
  end

  # Mirror the worker's `shuttle handoff`: stamp `shuttle.handed_off_at` in
  # RFC3339 UTC — the clean-exit signal the daemon compares against dispatched_at.
  def write_handoff_marker(id, at \\ DateTime.utc_now()) do
    MockRunner.put_shuttle_fields(id, %{"handed_off_at" => DateTime.to_iso8601(at)})
  end

  # The on-disk document's status and its run's handoff instant.
  def doc_status_and_handoff(path) do
    {:ok, _, _, fm, _} = Shuttle.FiberDoc.read_path(path)
    {:ok, at, _} = DateTime.from_iso8601(fm["shuttle"]["runtime"]["handed_off_at"])
    # The written stamp drops trailing zeros; compare at the clock's precision.
    {fm["status"], %{at | microsecond: {elem(at.microsecond, 0), 6}}}
  end

  # Inject the resolved occurrences Shuttle computes for a standing role — the
  # same way the mock's `with_resolved_agent` injects resolved.agent. Shuttle
  # inlines `prev_due` (the catch-up dispatch signal — most recent tick <= now)
  # and `next_due` (display and schedule-validity signals); the daemon reads them
  # from `shuttle show -j` without parsing cron. A `prev_due` after the role's
  # last service makes it due; an older one leaves it valid but sleeping.
  def set_resolved_occurrences(id, prev_due, next_due) do
    MockRunner.put_shuttle_fields(id, %{
      "resolved" => %{
        "prev_due" => DateTime.to_iso8601(prev_due),
        "next_due" => DateTime.to_iso8601(next_due)
      }
    })
  end

  def start_identity_poller(name) do
    start_poller!(
      name: name,
      runner: MockRunner,
      poll_interval_ms: 60_000,
      felt_stores: [MockRunner.felt_root()]
    )
  end

  def asked_shuttle_for_host? do
    Enum.member?(MockRunner.commands(), {"shuttle", ["host", "--json"]})
  end

  # A cut worker's run script outlives `tmux kill-session` for as long as its
  # harness takes to exit; the fresh session reuses the name, so the cut waits
  # for the worker to go rather than refusing the fresh dispatch as
  # :already_running (with no running entry left to name).
  def start_live_cut_fiber!(fiber_id, uid, name) do
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id, %{"uid" => uid, "status" => "active"}))

    MockRunner.set_shuttle(
      fiber_id,
      "kind: oneshot\nagent: claude-sonnet\nhost: test-host\n",
      "active"
    )

    {:ok, poller} =
      start_poller!(
        name: name,
        runner: MockRunner,
        own_host_id: "test-host",
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        felt_stores: [MockRunner.felt_root()]
      )

    assert {:ok, _} = Poller.dispatch_fiber(poller, fiber_id, force: true, ad_hoc: true)
    poller
  end

  # Inject a running entry with a chosen start time, then deliver a worker exit —
  # the precise input the breaker keys on (a oneshot exit and its lifetime),
  # without the dispatch/watcher/resume machinery that makes a full
  # spawn→kill→resume loop nondeterministic under the mock runner.
  def simulate_exit(poller, fiber_id, lifetime_seconds) do
    # The boot cycle's reconcile would drop the injected entry.
    settle_poller!(poller)
    started = DateTime.add(DateTime.utc_now(), -lifetime_seconds, :second)
    watcher = spawn(fn -> :ok end)

    :sys.replace_state(poller, fn state ->
      meta = %{
        fiber_id: fiber_id,
        session: FiberUid.session(fiber_id),
        agent_id: "claude-sonnet",
        uid: FiberUid.for(fiber_id),
        started_at: started,
        last_activity_at: started,
        pid: watcher
      }

      %{
        state
        | running: Map.put(state.running, FiberUid.for(fiber_id), meta)
      }
    end)

    notify_worker_exit(poller, fiber_id)
    :sys.get_state(poller, @state_timeout)
    await_publication!(poller)
  end

  def loop_blocked?(poller, fiber_id) do
    Enum.any?(Poller.snapshot(poller).blocked, fn b ->
      b.fiber_id == fiber_id and b.reason =~ "resume_loop"
    end)
  end

  # The heartbeat writer is linked to its Poller, but the exit signal lands
  # asynchronously: a write in flight can finish its `mkdir_p` while the data
  # dir is being removed. Retry until the tree stays gone.
  def rm_rf_settled!(dir, tries \\ 20) do
    case File.rm_rf(dir) do
      {:ok, _} ->
        :ok

      {:error, _, _} when tries > 0 ->
        Process.sleep(50)
        rm_rf_settled!(dir, tries - 1)

      {:error, reason, file} ->
        raise File.Error,
          reason: reason,
          action: "remove files and directories recursively from",
          path: file
    end
  end

  # ── Boot-quarantine auto-release (daemon heartbeat continuity) ──
  #
  # A kernel that kills the beam on a CPU rlimit is not a human asking for a
  # hold, but every (re)start arms the quarantine — so a kill nobody asked for
  # silently stopped all new work until someone noticed. `Shuttle.DaemonHeartbeat`
  # gives the daemon evidence about its own previous incarnation, and
  # `Poller.init/1` releases the hold IFF that evidence proves a fast bounce:
  # fresh heartbeat, the recorded workers still live BY THIS DAEMON'S OWN
  # adoption, and no crash loop. Everything else — a real gap, a loop, a
  # missing/garbage file, a contract skew — still holds. These tests are the
  # boundary in both directions; the value of the change is entirely there.

  # Under this test's throwaway SHUTTLE_DATA_DIR (the suite-wide pin is dropped
  # in setup), so it is cleaned up with the rest of the markers.
  def heartbeat_file, do: Path.join(Shuttle.Env.get("SHUTTLE_DATA_DIR"), "heartbeat.json")

  # A heartbeat that would auto-release on its own, with `fields` merged over:
  # written 4s ago by an incarnation that had been up half an hour, one boot in
  # the ring, and no workers recorded.
  def write_heartbeat!(fields \\ %{}) do
    now = System.system_time(:millisecond)
    booted_at = now - 1_800_000

    record =
      Map.merge(
        %{
          "v" => 1,
          "host" => System.fetch_env!("SHUTTLE_HOST"),
          "listen" => Shuttle.listen(),
          "node" => Shuttle.DaemonHeartbeat.node_name(),
          "held" => false,
          # Not this test VM's pid: these records stand in for a previous VM.
          "os_pid" => "0",
          "at" => now - 4_000,
          "booted_at" => booted_at,
          "workers" => [],
          "boots" => [booted_at]
        },
        fields
      )

    path = heartbeat_file()
    File.write!(path, Jason.encode!(record))
    path
  end

  def start_quarantined_poller!(name, opts \\ []) do
    [
      name: name,
      runner: MockRunner,
      poll_interval_ms: 60_000,
      felt_stores: [MockRunner.felt_root()],
      boot_quarantine: true,
      quarantine_auto_release: true,
      daemon_heartbeat_file: heartbeat_file()
    ]
    |> Keyword.merge(opts)
    |> start_poller!()
  end

  # The fresh candidate every test below watches: parked while the hold stands,
  # dispatched the moment it is lifted.
  def fresh_candidate!(fiber_id) do
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id))
    MockRunner.set_shuttle(fiber_id, oneshot_shuttle())
    fiber_id
  end

  # Every snapshot read in this section uses a generous call timeout: the poller
  # shells felt synchronously while dispatching, and on a loaded host that pushes
  # a default 5s `GenServer.call` past its ceiling — which fails the test for a
  # reason that has nothing to do with the quarantine.
  def hb_snapshot(poller), do: Poller.snapshot(poller, 30_000)

  # Did a worker actually launch for `fiber_id`? Read from the recorded commands
  # rather than the poller's state, so the check never waits on the GenServer
  # that is busy doing the launching. That GenServer shells felt synchronously
  # per candidate, which on a loaded host takes seconds; `wait_until`'s ceiling
  # absorbs it and returns the instant the launch lands.
  def assert_launched!(fiber_id) do
    session = FiberUid.session(fiber_id)

    assert wait_until(fn ->
             Enum.any?(MockRunner.commands(), fn {cmd, args} ->
               cmd == "tmux" and hd(args) == "new-session" and session in args
             end)
           end)
  end

  # Both directions assert on the SAME two observables, so a hold and a release
  # can't be confused for one another: the flag, and whether the fresh candidate
  # actually launched.
  def assert_held!(poller, fiber_id) do
    assert_eventually(fn ->
      assert [%{fiber_id: ^fiber_id}] = hb_snapshot(poller).pending_launch
    end)

    snap = hb_snapshot(poller)
    assert snap.boot_quarantine == true

    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)

    snap
  end

  # Kill `poller` hard, then stand its last heartbeat in for a long,
  # healthy-looking uptime that ended seconds ago, with `fields` merged over.
  def hard_kill_after_long_run!(poller, fields \\ %{}) do
    ref = Process.monitor(poller)
    Process.exit(poller, :kill)
    assert_receive {:DOWN, ^ref, :process, ^poller, :killed}

    {:ok, hb} = DaemonHeartbeat.read(heartbeat_file())
    now = System.system_time(:millisecond)

    record =
      hb
      |> Map.merge(%{"at" => now - 4_000, "booted_at" => now - 1_800_000})
      |> Map.merge(fields)

    File.write!(heartbeat_file(), Jason.encode!(record))
  end

  def arrange_unreleasable_boot!(row) do
    runner = Keyword.get(row, :runner, [])
    if runner[:tmux_server_missing], do: MockRunner.set_tmux_server_missing(true)
    if runner[:ps_fails], do: MockRunner.set_ps_result({"ps: boom", 1})

    if runner[:contract_skew],
      do: MockRunner.set_contract_level(Integer.to_string(skewed_contract_level()))

    case Keyword.get(row, :heartbeat, %{}) do
      :missing ->
        refute File.exists?(heartbeat_file())

      {:body, body} ->
        File.write!(heartbeat_file(), body)

      %{} = ago ->
        now = System.system_time(:millisecond)

        ago
        |> Map.new(fn
          {key, ms} when key in ["at", "booted_at"] -> {key, now - ms}
          {"boots", boots} -> {"boots", Enum.map(boots, &(now - &1))}
          other -> other
        end)
        |> write_heartbeat!()
    end

    if row[:stop_marker], do: :ok = DaemonHeartbeat.mark_stopped(heartbeat_file())
  end

  # ── CLI/daemon contract handshake ──
  #
  # `Shuttle.Poller.init/1` shells `shuttle contract` once and compares it
  # to `Shuttle.Contract.expected_level/0`. A mismatch or unparseable/nonzero
  # exit, including an unknown subcommand, rides the same dispatch gate
  # as boot quarantine: fresh launches park, already-observed work still
  # resumes, and the reason surfaces on `snapshot().contract` /
  # `pending_launch`. `config/test.exs` disables `boot_quarantine`, so these
  # tests exercise the skew gate in isolation from it.

  # A CLI level the daemon does not expect.
  def skewed_contract_level, do: Shuttle.Contract.expected_level() + 1

  def check_concluded_standing_schedule(scenario) do
    fiber_id = "tests/standing-concluded"
    now = DateTime.utc_now()
    serviced = DateTime.add(now, -120, :second)
    occurrence = DateTime.add(now, if(scenario == :not_yet_due, do: -180, else: -60), :second)

    status =
      case scenario do
        :rested -> "open"
        :retired -> "closed"
        _ -> "active"
      end

    attrs = %{"status" => status}
    attrs = if scenario == :retired, do: Map.put(attrs, "tempered", false), else: attrs

    attrs =
      if scenario in [:stashed, :rested], do: Map.put(attrs, "horizon", "stashed"), else: attrs

    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id, attrs))
    host = if scenario == :other_host, do: "other-host", else: "test-host"

    MockRunner.set_shuttle(
      fiber_id,
      """
      kind: standing
      host: #{host}
      agent: claude-sonnet
      schedule:
        expr: "* * * * *"
        tz: UTC
      """,
      status
    )

    MockRunner.put_shuttle_fields(fiber_id, %{
      "dispatched_at" => DateTime.to_iso8601(serviced),
      "handed_off_at" => DateTime.to_iso8601(serviced)
    })

    if scenario == :asking do
      MockRunner.put_shuttle_fields(fiber_id, %{
        "ask" => %{"text" => "send these?", "at" => DateTime.to_iso8601(serviced)}
      })
    end

    set_resolved_occurrences(fiber_id, occurrence, DateTime.add(now, 60, :second))

    {:ok, poller} =
      start_poller!(
        runner: MockRunner,
        boot_quarantine: scenario == :quarantine,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    fires? = scenario in [:due, :quarantine, :asking, :stashed]

    assert Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end) == fires?

    assert MockRunner.fiber(fiber_id)["status"] == status

    if fires? do
      assert [%{fiber_id: ^fiber_id, state: "running"}] = Poller.snapshot(poller).eligible
      sync_poll_cycle!(poller)

      assert Enum.count(MockRunner.commands(), fn {cmd, args} ->
               cmd == "tmux" and hd(args) == "new-session"
             end) == 1
    end
  end

  def closed_reap_fixture(backend) do
    Env.put_app_env(:terminal_backend, backend)

    if backend == Shuttle.Terminal.Rex do
      Env.put_app_env(:fake_rex, start_supervised!(Shuttle.Test.FakeRex))
      Env.put_env("SHUTTLE_REX_BIN", "/bin/echo")
    end

    id = "tests/closed-reap"
    fiber = make_fiber(id, %{"status" => "closed"})
    MockRunner.set_fiber(id, fiber)
    MockRunner.set_shuttle(id, "kind: oneshot\nagent: claude-sonnet\nhost: test-host\n", "closed")
    fiber = MockRunner.fiber(id)
    session = FiberUid.session(id)

    assert :ok =
             Shuttle.Terminal.launch(ReapRunner, session, MockRunner.felt_root(), "true\n",
               preflighted: true
             )

    state = %Poller.State{
      self_ref: self(),
      heartbeat_interval_ms: 60_000,
      runner: ReapRunner,
      own_host_id: "test-host",
      felt_stores: [MockRunner.felt_root()],
      last_known_listings: %{MockRunner.felt_root() => [fiber]},
      adopted?: true
    }

    {state, session}
  end

  def reap_stop_count(Shuttle.Terminal.Tmux),
    do: Enum.count(MockRunner.commands(), &match?({"tmux", ["kill-session" | _]}, &1))

  def reap_stop_count(Shuttle.Terminal.Rex),
    do:
      Enum.count(Shuttle.Test.FakeRex.calls(), fn {_, args, _} ->
        "session.close_window" in args
      end)

  # ── Multi-host tests ──
  #
  # These tests exercise the multi-felt-store path directly against the file
  # system; they bypass MockRunner's in-memory fiber store and write real
  # .felt/ directories instead. Store resolution is the Poller's cold path,
  # `FeltStores.store_for_fiber/2` over its configured `felt_stores`.

  # Helper: write a minimal fiber .md file with a shuttle: block into
  # <host>/.felt/<id>/<basename>.md so read_fiber_shuttle_block can find it.
  def write_fiber_file(host, fiber_id, shuttle_yaml \\ "enabled: true\nkind: oneshot\n") do
    felt_dir = Path.join(host, ".felt")
    segments = String.split(fiber_id, "/")
    basename = List.last(segments)
    dir_path = Path.join([felt_dir | segments] ++ ["#{basename}.md"])
    File.mkdir_p!(Path.dirname(dir_path))

    indented =
      shuttle_yaml
      |> String.trim()
      |> String.split("\n")
      |> Enum.map_join("\n", &("  " <> &1))

    File.write!(dir_path, "---\nstatus: active\nshuttle:\n#{indented}\n---\nbody\n")
    dir_path
  end

  # A throwaway felt store dir for the multi-host tests, swept by this test's
  # own `on_exit` — scoped to the dir this test made, so a sweep can't take
  # another test's store out from under it (this module is not async).
  def multi_host_dir(label) do
    dir =
      Path.join(
        System.tmp_dir!(),
        "shuttle-multi-host-#{label}-#{System.unique_integer([:positive])}"
      )

    File.mkdir_p!(dir)
    on_exit(fn -> File.rm_rf(dir) end)
    dir
  end

  # The project-cities-on-loom topology: the physical fiber is rooted in loom
  # under ai-futures/portolan/, and the project's `.felt/` symlinks into that
  # subdir, so the same kanban-modal.md is also reachable as
  # project/.felt/kanban-modal/.
  def loom_project_symlink! do
    loom = multi_host_dir("loom")
    project = multi_host_dir("project")

    write_fiber_file(loom, "ai-futures/portolan/kanban-modal")

    File.ln_s!(
      Path.join([loom, ".felt", "ai-futures", "portolan"]),
      Path.join(project, ".felt")
    )

    {loom, project}
  end

  def flush_held_launch_probes do
    receive do
      :held_launch_probe -> flush_held_launch_probes()
    after
      0 -> :ok
    end
  end

  def notify_worker_exit(poller, fiber_id) do
    state = :sys.get_state(poller, @state_timeout)
    %{pid: watcher, session: session} = state.running[Poller.running_key(state, fiber_id)]
    send(poller, {:worker_exited, fiber_id, watcher, session, :normal_exit})
  end

  # A worker's tmux session ends and its watcher reports the exit. The watcher
  # identity is read while the session is still live: once it is gone, a
  # watcher or poll cycle may observe that first and release the claim.
  def end_worker_session(poller, fiber_id) do
    %{pid: watcher, session: session} = Poller.worker_status(poller, fiber_id)
    MockRunner.remove_tmux_session(session)
    send(poller, {:worker_exited, fiber_id, watcher, session, :normal_exit})
  end
end
