defmodule Shuttle.PollerQuarantineTest do
  # The Poller: the boot quarantine, the daemon heartbeat and the contract gate.
  #
  # Auto-release: a kernel that kills the beam on a CPU rlimit is not a human
  # asking for a hold, but every (re)start arms the quarantine.
  # `Shuttle.DaemonHeartbeat` gives the daemon evidence about its previous
  # incarnation, and `Poller.init/1` releases the hold iff that evidence proves
  # a fast bounce: a fresh heartbeat, the recorded workers still live by this
  # daemon's own adoption, and no crash loop. Everything else (a real gap, a
  # loop, a missing or garbage file, a contract skew) still holds. These tests
  # are the boundary in both directions.
  #
  # The contract gate: `Poller.init/1` shells `shuttle contract` once and
  # compares it to `Shuttle.Contract.expected_level/0`. A mismatch or an
  # unparseable or nonzero exit, an unknown subcommand included, rides the same
  # dispatch gate as the quarantine: fresh launches park, observed work still
  # resumes, and the reason surfaces on `snapshot().contract` and
  # `pending_launch`. `config/test.exs` disables `boot_quarantine`, so these
  # tests exercise the gate in isolation from it.
  use Shuttle.Test.PollerCase, async: true

  # ── Boot quarantine ──
  #
  # Fresh work holds after restart; interrupted workers restore from durable
  # markers without releasing the fresh-work quarantine.

  test "boot quarantine parks fresh launches and surfaces them as pending_launch" do
    fiber_id = "tests/quarantine-fresh"
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id))
    MockRunner.set_shuttle(fiber_id, oneshot_shuttle())

    {:ok, poller} =
      start_poller!(
        name: :test_poller_quarantine_fresh,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()],
        boot_quarantine: true
      )

    sync_poll_cycle!(poller)

    # Parked, not dispatched: the row lands in pending_launch with the
    # quarantine reason, and no tmux session is spawned.
    assert_eventually(fn ->
      assert [%{fiber_id: ^fiber_id, reason: "boot quarantine — awaiting release"}] =
               Poller.snapshot(poller).pending_launch
    end)

    snap = Poller.snapshot(poller)
    assert snap.boot_quarantine == true
    assert snap.eligible == []

    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)

    # The held state reaches the per-fiber feed (board indicator): parked_index
    # is keyed by fiber_id, and put_held stamps the matching feed row `held`.
    index = Poller.parked_index(poller)
    assert %{parked_at: _} = Map.get(index, fiber_id)

    assert %{held: true, held_since: _} =
             Snapshot.put_held(%{fiber: %{"id" => fiber_id}}, index)

    refute Map.has_key?(Snapshot.put_held(%{fiber: %{"id" => "tests/not-held"}}, index), :held)
  end

  test "boot quarantine restores a dead worker from its durable marker" do
    fiber_id = "tests/quarantine-dirty-resume"
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id))
    MockRunner.set_shuttle(fiber_id, oneshot_shuttle())
    write_dispatch_marker(fiber_id, "b1e0a3c2-0000-4000-8000-000000000001")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_quarantine_resume,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()],
        boot_quarantine: true
      )

    sync_poll_cycle!(poller)

    assert_eventually(fn ->
      assert Poller.snapshot(poller).pending_launch == []

      assert Enum.any?(MockRunner.commands(), fn
               {"tmux", ["new-session" | _]} -> true
               _ -> false
             end)
    end)

    assert Poller.snapshot(poller).boot_quarantine
  end

  test "boot quarantine does NOT park work it observed running; a was-running fiber re-dispatches on exit" do
    # The core of the fix: in-flight work the daemon observed running under its
    # own uptime auto-resumes even while quarantined — only genuinely-fresh
    # launches are held. Field scenario reproduced: a oneshot whose worker was
    # adopted at boot, then exits mid-uptime, must re-dispatch, not park.
    fiber_id = "tests/quarantine-was-running"
    session = FiberUid.session(fiber_id)
    MockRunner.set_shuttle(fiber_id, oneshot_shuttle())
    # Live worker present at boot → adopt_orphans adopts it (adoption runs
    # regardless of quarantine), so its runtime key enters the durable
    # `was_running` set.
    MockRunner.add_tmux_session(session)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_quarantine_was_running,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()],
        boot_quarantine: true
      )

    # Adopted as running while quarantined (not parked): observed-running now
    # carries this fiber's key, and nothing is in pending_launch.
    assert_eventually(fn ->
      state = :sys.get_state(poller, @state_timeout)
      assert MapSet.member?(state.was_running, FiberUid.for(fiber_id))
      assert Enum.any?(state.running, fn {_k, m} -> Map.get(m, :fiber_id) == fiber_id end)
    end)

    assert Poller.snapshot(poller).pending_launch == []

    # Worker exits mid-uptime; the next poll reconciles the missing session
    # (drops it from running, releases the claim) → the fiber is a candidate
    # again. Was-running membership survives the exit, so it re-dispatches.
    MockRunner.remove_tmux_session(session)
    sync_poll_cycle!(poller)

    assert_eventually(fn ->
      assert Enum.any?(MockRunner.commands(), fn {cmd, args} ->
               cmd == "tmux" and hd(args) == "new-session"
             end)
    end)

    snap = Poller.snapshot(poller)
    assert snap.boot_quarantine == true
    refute Enum.any?(snap.pending_launch, &(&1.fiber_id == fiber_id))
  end

  test "boot quarantine does NOT park a due standing role (cron is the human's pre-given go)" do
    # Field scenario: a deploy restarted the daemon overnight and nobody ran
    # `shuttle daemon release`; the 09:00 monthly and weekly roles were parked
    # and silently missed their runs. A cron occurrence is bounded and
    # human-authorized at a fixed time, so it flows through the quarantine.
    fiber_id = "tests/quarantine-standing"

    MockRunner.set_fiber(
      fiber_id,
      make_fiber(fiber_id, %{"tags" => ["constitution", "standing"]})
    )

    MockRunner.set_shuttle(
      fiber_id,
      """
      enabled: true
      kind: standing
      agent: claude-sonnet
      schedule:
        expr: "* * * * *"
        tz: Europe/Paris
      review:
        state: scheduled
      """
    )

    now = DateTime.utc_now()
    set_resolved_occurrences(fiber_id, now, DateTime.add(now, 60, :second))

    {:ok, poller} =
      start_poller!(
        name: :test_poller_quarantine_standing,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()],
        boot_quarantine: true
      )

    sync_poll_cycle!(poller)

    assert_eventually(fn ->
      assert [%{fiber_id: ^fiber_id, state: "running"}] = Poller.snapshot(poller).eligible
    end)

    snap = Poller.snapshot(poller)
    assert snap.boot_quarantine == true
    assert snap.pending_launch == []
  end

  test "quarantine parking is rebuilt every cycle even when all slots are full" do
    # Parking is dispatch-authority bookkeeping, not capacity accounting: the
    # parked map used to be rebuilt only inside the `available_slots > 0`
    # gate, so with slots full a closed fiber kept its stale pending_launch
    # row and newly-eligible work never surfaced. Rebuild must run every
    # cycle; only actual dispatching is slot-gated.
    fiber_id = "tests/quarantine-slots-full"
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id))
    MockRunner.set_shuttle(fiber_id, oneshot_shuttle())

    {:ok, poller} =
      start_poller!(
        name: :test_poller_quarantine_slots_full,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        felt_stores: [MockRunner.felt_root()],
        boot_quarantine: true
      )

    sync_poll_cycle!(poller)

    # Parked despite zero slots — the bookkeeping runs regardless of capacity.
    assert_eventually(fn ->
      assert [%{fiber_id: ^fiber_id}] = Poller.snapshot(poller).pending_launch
    end)

    # The fiber closes; the next cycle (slots still full) rebuilds the parked
    # map and the stale row drops out.
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id, %{"status" => "closed"}))
    MockRunner.set_shuttle(fiber_id, oneshot_shuttle(), "closed")
    sync_poll_cycle!(poller)

    assert_eventually(fn ->
      assert Poller.snapshot(poller).pending_launch == []
    end)
  end

  test "releasing the boot quarantine dispatches the parked launches" do
    fiber_id = "tests/quarantine-release"
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id))
    MockRunner.set_shuttle(fiber_id, oneshot_shuttle())

    {:ok, poller} =
      start_poller!(
        name: :test_poller_quarantine_release,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()],
        boot_quarantine: true
      )

    sync_poll_cycle!(poller)

    assert_eventually(fn ->
      assert [%{fiber_id: ^fiber_id}] = Poller.snapshot(poller).pending_launch
    end)

    # The human "go": clears the flag + parked set and ticks immediately, so
    # the fiber dispatches without waiting out the poll interval. Idempotent.
    assert :ok = Poller.release_boot_quarantine(poller)
    assert :ok = Poller.release_boot_quarantine(poller)

    assert_eventually(fn ->
      assert [%{fiber_id: ^fiber_id}] = Poller.snapshot(poller).eligible
    end)

    snap = Poller.snapshot(poller)
    assert snap.boot_quarantine == false
    assert snap.pending_launch == []
  end

  test "force-dispatch bypasses the boot quarantine and does not clear it" do
    fiber_id = "tests/quarantine-force"
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id))
    MockRunner.set_shuttle(fiber_id, oneshot_shuttle())

    # max_concurrent_workers: 0 disables the autonomous tick's dispatch;
    # explicit Poller.dispatch_fiber/3 is not slot-gated, so only the manual
    # path is exercised here.
    {:ok, poller} =
      start_poller!(
        name: :test_poller_quarantine_force,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        felt_stores: [MockRunner.felt_root()],
        boot_quarantine: true
      )

    # First a poll parks it as a fresh launch (held): the autonomous tick's
    # parking is not slot-gated, so it runs even with 0 worker slots.
    sync_poll_cycle!(poller)

    assert_eventually(fn ->
      assert %{parked_at: _} = Map.get(Poller.parked_index(poller), fiber_id)
    end)

    # The human clicked dispatch: honor the intent — but one manual "go" on one
    # fiber is not a bulk release; the quarantine stays up for everything else.
    assert {:ok, _session} = Poller.dispatch_fiber(poller, fiber_id, force: true)
    assert Poller.snapshot(poller).boot_quarantine == true

    # Held clears the instant the worker exists — synchronously, not a poll cycle
    # later — so the card never co-renders the held and "aloft" pills.
    refute Map.has_key?(Poller.parked_index(poller), fiber_id)
  end

  test "a fast bounce with its workers still alive auto-releases the boot quarantine" do
    # The whole point: the daemon was killed seconds ago, its worker is still in
    # tmux and gets adopted, so the fresh candidate launches without a human.
    live_id = "tests/hb-live"
    session = FiberUid.session(live_id)
    MockRunner.set_shuttle(live_id, oneshot_shuttle())
    MockRunner.add_tmux_session(session)

    fresh_id = fresh_candidate!("tests/hb-fresh")
    write_heartbeat!(%{"workers" => [FiberUid.for(live_id)]})

    {:ok, poller} = start_quarantined_poller!(:test_poller_hb_fast_bounce)
    # Nudge a cycle rather than relying on the boot tick alone, and nudge it
    # with a message rather than a call: the assertions below must not queue
    # behind the poller while it is shelling felt to launch.
    sync_poll_cycle!(poller)

    # The launch itself is the proof the hold is off, and reading it from the
    # recorded commands never waits on the busy poller.
    assert_launched!(fresh_id)

    snap = hb_snapshot(poller)
    assert snap.boot_quarantine == false
    assert snap.pending_launch == []
  end

  test "a fast crash with dead recorded workers releases fresh work" do
    fresh_id = fresh_candidate!("tests/hb-dead-workers")
    write_heartbeat!(%{"workers" => ["tests/hb-ghost"]})
    {:ok, poller} = start_quarantined_poller!(:test_poller_hb_dead_workers)
    sync_poll_cycle!(poller)
    assert_launched!(fresh_id)
    refute hb_snapshot(poller).boot_quarantine
  end

  test "an idle fast bounce (no workers recorded) auto-releases" do
    # Nothing was running and the previous incarnation had been released, so
    # an empty recorded set is continuous.
    fresh_id = fresh_candidate!("tests/hb-idle")
    write_heartbeat!()

    {:ok, poller} = start_quarantined_poller!(:test_poller_hb_idle)
    sync_poll_cycle!(poller)

    assert_launched!(fresh_id)
    assert hb_snapshot(poller).boot_quarantine == false
  end

  test "an unreleased hold survives a hard kill (a held incarnation's heartbeat never releases)" do
    # The laundering case: an incarnation boots held (after an outage or a
    # deploy) and nobody releases it. It keeps writing fresh heartbeats with no
    # workers, since nothing dispatches while held. A hard kill after a long run
    # must not turn that into a release of the work it was holding back.
    fiber_id = fresh_candidate!("tests/hb-launder")
    refute File.exists?(heartbeat_file())

    {:ok, first} = start_quarantined_poller!(:test_poller_hb_launder_1)

    assert_eventually(fn ->
      assert {:ok, %{"held" => true}} = DaemonHeartbeat.read(heartbeat_file())
    end)

    # A different VM, so the pid check is not what holds here.
    hard_kill_after_long_run!(first, %{"os_pid" => "0"})

    {:ok, second} = start_quarantined_poller!(:test_poller_hb_launder_2)
    send(second, :run_poll_cycle)

    assert_held!(second, fiber_id)
  end

  test "work parked behind a contract skew survives a human release and a hard kill" do
    # The quarantine was released by a human, but the skew kept parking fresh
    # work, so the incarnation was still holding it back. Once the CLI is fixed
    # the next boot must not release that backlog on a hard kill.
    MockRunner.set_contract_level(Integer.to_string(skewed_contract_level()))
    fiber_id = fresh_candidate!("tests/hb-skew-release")
    {:ok, first} = start_quarantined_poller!(:test_poller_hb_skew_release_1)
    assert :ok = Poller.release_boot_quarantine(first)

    assert_eventually(fn ->
      assert {:ok, %{"held" => true}} = DaemonHeartbeat.read(heartbeat_file())
    end)

    hard_kill_after_long_run!(first, %{"os_pid" => "0"})

    MockRunner.set_contract_level(Integer.to_string(Shuttle.Contract.expected_level()))
    {:ok, second} = start_quarantined_poller!(:test_poller_hb_skew_release_2)
    send(second, :run_poll_cycle)

    assert_held!(second, fiber_id)
  end

  test "a Poller restart inside a live VM holds, even after a human release" do
    # No hard kill happened: the supervisor restarted the Poller. The record
    # is released, fresh and long-run, but its OS pid is this VM's.
    fiber_id = fresh_candidate!("tests/hb-poller-restart")
    {:ok, first} = start_quarantined_poller!(:test_poller_hb_restart_1)
    assert :ok = Poller.release_boot_quarantine(first)

    assert_eventually(fn ->
      assert {:ok, %{"held" => false}} = DaemonHeartbeat.read(heartbeat_file())
    end)

    hard_kill_after_long_run!(first)

    MockRunner.reset()
    fresh_candidate!(fiber_id)

    {:ok, second} = start_quarantined_poller!(:test_poller_hb_restart_2)
    send(second, :run_poll_cycle)

    assert_held!(second, fiber_id)
  end

  test "a Poller heartbeat round trips into release evidence for its listener" do
    {:ok, poller} = start_quarantined_poller!(:test_poller_hb_round_trip)

    assert_eventually(fn ->
      assert {:ok, _} = DaemonHeartbeat.read(heartbeat_file())
    end)

    state =
      :sys.replace_state(poller, fn state ->
        %{state | daemon_booted_at: System.system_time(:millisecond) - 1_800_000}
      end)

    assert :ok = Poller.release_boot_quarantine(poller)

    writer = :sys.get_state(poller).daemon_heartbeat_writer
    ref = Process.monitor(writer)
    assert_receive {:DOWN, ^ref, :process, ^writer, _}, 30_000

    evidence = DaemonHeartbeat.read(heartbeat_file())

    assert {:release, _} =
             DaemonHeartbeat.verdict(evidence, %{
               now_ms: System.system_time(:millisecond),
               listen: Shuttle.listen(),
               host: state.own_host_id,
               node: DaemonHeartbeat.node_name(),
               os_pid: "next-vm"
             })
  end

  test "a human release is recorded in the heartbeat at once" do
    {:ok, poller} =
      start_poller!(
        name: :test_poller_hb_release_write,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        felt_stores: [MockRunner.felt_root()],
        boot_quarantine: true,
        daemon_heartbeat_file: heartbeat_file(),
        daemon_heartbeat_interval_ms: 3_600_000
      )

    assert_eventually(fn ->
      assert {:ok, %{"held" => true}} = DaemonHeartbeat.read(heartbeat_file())
    end)

    assert :ok = Poller.release_boot_quarantine(poller)
    # The hour-long interval rules out the timer: only the release wrote this.
    assert_eventually(fn ->
      assert {:ok, %{"held" => false}} = DaemonHeartbeat.read(heartbeat_file())
    end)
  end

  # Every way the evidence can fall short of a fast bounce, one row each, all
  # judged by the same act and the same observables (`assert_held!/2`, then
  # the parked row's reason, the contract verdict and whether the boot scan
  # completed). A row arranges only what differs from a releasable boot: the
  # `heartbeat` on disk (fields merged over `write_heartbeat!/1`'s, with times
  # given as ms before now; `:missing`; or a raw `{:body, _}`), a stop marker
  # beside it, the Poller's own options, and what the runner reports. Its
  # `expect` overrides `@held_expectations` where it differs from a plain hold.
  @held_expectations [
    reason: ~r/\Aboot quarantine — awaiting release\z/,
    contract_ok: true,
    adopted?: true
  ]

  @unreleasable_boots [
    # A deploy or operator restart: fresh, released, long-run — everything a
    # hard kill would look like, except the stop marker its SIGTERM left.
    {"a gracefully stopped previous incarnation (stop marker)", stop_marker: true},
    {"a host that has not opted in, even on a provable hard-kill bounce",
     poller: [quarantine_auto_release: false]},
    # Five minutes of silence: far past the 60s grace, so the daemon has no
    # evidence the gap was short.
    {"a stale heartbeat (a real outage)", heartbeat: %{"at" => 300_000}},
    # The case freshness CANNOT catch: a daemon dying every few seconds has a
    # heartbeat that is always fresh. The recorded boot time is what exposes it.
    {"a crash loop (fresh heartbeat, short-lived previous incarnation)",
     heartbeat: %{"at" => 2_000, "booted_at" => 12_000, "boots" => [12_000]}},
    # The coarse brake: every incarnation lived just past the healthy-run
    # threshold, so the per-incarnation check passes — but the daemon has come
    # back five times in ten minutes (this boot included), which is a human's
    # problem, not new work's.
    {"too many recent boots, even when each incarnation looked healthy",
     heartbeat: %{
       "at" => 3_000,
       "booted_at" => 103_000,
       "boots" => [403_000, 303_000, 203_000, 103_000]
     }},
    {"a missing heartbeat file (fail closed)", heartbeat: :missing},
    # A kill mid-write is exactly what this daemon is exposed to, so the parse
    # has to survive garbage — and a file that says the right keys with the
    # wrong types is no better evidence than one that says nothing.
    {"a truncated heartbeat file", heartbeat: {:body, ~s({"v":1,"at":17)}},
    {"a heartbeat that is not an object", heartbeat: {:body, ~s(["at", 17])}},
    {"a heartbeat with the right keys of the wrong types",
     heartbeat: {:body, ~s({"v":1,"at":"soon","booted_at":null,"workers":"nope"})}},
    {"an empty heartbeat file", heartbeat: {:body, ""}},
    # An empty recorded set is vacuously continuous, so the verdict alone would
    # release. It must not: without a completed adoption scan the daemon has not
    # observed what is live, and the `adopted?` guard fails the release closed.
    {"a boot whose tmux scan is unknown",
     runner: [tmux_server_missing: true, ps_fails: true], expect: [adopted?: false]},
    # Skew has no release endpoint by design: every shelled write is suspect, so
    # the auto-release must not become a back door into dispatching under one.
    # It names itself over the quarantine it rides on: the more actionable fix.
    {"a contract skew",
     runner: [contract_skew: true], expect: [reason: ~r/\Acontract skew — /, contract_ok: false]}
  ]

  for {{label, row}, index} <- Enum.with_index(@unreleasable_boots) do
    @row row
    @index index
    test "the boot quarantine holds on #{label}" do
      fiber_id = fresh_candidate!("tests/hb-hold-#{@index}")
      arrange_unreleasable_boot!(@row)

      {:ok, poller} =
        start_quarantined_poller!(
          :"test_poller_hb_hold_#{@index}",
          Keyword.get(@row, :poller, [])
        )

      sync_poll_cycle!(poller)

      snap = assert_held!(poller, fiber_id)
      assert Process.alive?(poller)

      expect = Keyword.merge(@held_expectations, Keyword.get(@row, :expect, []))
      assert [%{reason: reason}] = snap.pending_launch
      assert reason =~ expect[:reason]
      assert snap.contract.ok == expect[:contract_ok]
      assert :sys.get_state(poller, @state_timeout).adopted? == expect[:adopted?]
    end
  end

  test "the daemon writes its own heartbeat while healthy" do
    # The other half of the contract: the evidence the next boot reads is
    # written by this one, at boot and then on its own interval, carrying this
    # incarnation's boot time, its live workers, and the boot ring it inherited.
    live_id = "tests/hb-writer-live"
    session = FiberUid.session(live_id)
    MockRunner.set_shuttle(live_id, oneshot_shuttle())
    MockRunner.add_tmux_session(session)

    previous_boot = System.system_time(:millisecond) - 1_800_000
    write_heartbeat!(%{"boots" => [previous_boot]})

    {:ok, poller} =
      start_poller!(
        name: :test_poller_hb_writer,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        felt_stores: [MockRunner.felt_root()],
        daemon_heartbeat_file: heartbeat_file(),
        daemon_heartbeat_interval_ms: 25
      )

    assert_eventually(fn ->
      assert {:ok, hb} = Shuttle.DaemonHeartbeat.read(heartbeat_file())
      # This incarnation's own boot time, appended to the inherited ring.
      assert hb["boots"] == [
               previous_boot,
               :sys.get_state(poller, @state_timeout).daemon_booted_at
             ]

      assert hb["booted_at"] == :sys.get_state(poller, @state_timeout).daemon_booted_at
      assert FiberUid.for(live_id) in hb["workers"]
      # Stamped with this daemon's fleet identity and this machine's node name.
      assert hb["host"] == :sys.get_state(poller, @state_timeout).own_host_id
      assert hb["node"] == Shuttle.DaemonHeartbeat.node_name()
      assert hb["os_pid"] == System.pid()
      # And it keeps writing: `at` advances past the boot write.
      assert hb["at"] > hb["booted_at"]
    end)
  end

  test "a matching contract level dispatches normally and reports ok in the snapshot" do
    MockRunner.set_contract_level(Integer.to_string(Shuttle.Contract.expected_level()))
    fiber_id = "tests/contract-match"
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id))
    MockRunner.set_shuttle(fiber_id, oneshot_shuttle())

    {:ok, poller} =
      start_poller!(
        name: :test_poller_contract_match,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    level = Shuttle.Contract.expected_level()

    assert Poller.snapshot(poller).contract == %{
             expected: level,
             observed: level,
             ok: true,
             reason: nil
           }

    sync_poll_cycle!(poller)

    assert_eventually(fn ->
      assert Enum.any?(MockRunner.commands(), fn {cmd, args} ->
               cmd == "tmux" and hd(args) == "new-session"
             end)
    end)

    assert Poller.snapshot(poller).pending_launch == []
  end

  test "a mismatched contract level holds fresh launches and surfaces the skew" do
    MockRunner.set_contract_level(Integer.to_string(skewed_contract_level()))
    fiber_id = "tests/contract-mismatch"
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id))
    MockRunner.set_shuttle(fiber_id, oneshot_shuttle())

    {:ok, poller} =
      start_poller!(
        name: :test_poller_contract_mismatch,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    snap = Poller.snapshot(poller)

    level = Shuttle.Contract.expected_level()
    skewed = skewed_contract_level()
    assert %{expected: ^level, observed: ^skewed, ok: false, reason: reason} = snap.contract
    assert reason =~ "expected contract level #{level}"
    assert reason =~ "CLI reports #{skewed}"

    sync_poll_cycle!(poller)

    # Held, not dispatched: parked as a pending_launch with the skew reason,
    # and no tmux session spawned — same shape as a boot-quarantine park.
    assert_eventually(fn ->
      assert [%{fiber_id: ^fiber_id, reason: parked_reason}] =
               Poller.snapshot(poller).pending_launch

      assert parked_reason =~ "contract skew"
      assert parked_reason =~ "CLI reports #{skewed}"
    end)

    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)
  end

  test "unparseable contract output (unknown subcommand) is treated as skew, not a crash" do
    # When `shuttle contract` is unavailable, the CLI exits nonzero with usage
    # text on stdout. The daemon cannot determine the level, so it treats that
    # shape as incompatible, just like an explicit mismatch.
    MockRunner.set_contract_level("Error: unknown command \"contract\"", 1)
    fiber_id = "tests/contract-garbage"
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id))
    MockRunner.set_shuttle(fiber_id, oneshot_shuttle())

    {:ok, poller} =
      start_poller!(
        name: :test_poller_contract_garbage,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    level = Shuttle.Contract.expected_level()
    assert %{expected: ^level, ok: false} = Poller.snapshot(poller).contract

    sync_poll_cycle!(poller)

    assert_eventually(fn ->
      assert [%{fiber_id: ^fiber_id}] = Poller.snapshot(poller).pending_launch
    end)

    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)
  end

  test "a contract skew does not strand work observed running; a was-running fiber still resumes" do
    # Same was-running exemption as boot quarantine: skew means "no NEW
    # autonomous work", not "abandon what's alive". A worker this daemon
    # observed running (adopted at boot) must still re-dispatch on exit.
    MockRunner.set_contract_level(Integer.to_string(skewed_contract_level()))
    fiber_id = "tests/contract-skew-was-running"
    session = FiberUid.session(fiber_id)
    MockRunner.set_shuttle(fiber_id, oneshot_shuttle())
    MockRunner.add_tmux_session(session)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_contract_skew_was_running,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    assert_eventually(fn ->
      state = :sys.get_state(poller, @state_timeout)
      assert MapSet.member?(state.was_running, FiberUid.for(fiber_id))
      assert Enum.any?(state.running, fn {_k, m} -> Map.get(m, :fiber_id) == fiber_id end)
    end)

    assert Poller.snapshot(poller).pending_launch == []

    MockRunner.remove_tmux_session(session)
    sync_poll_cycle!(poller)

    assert_eventually(fn ->
      assert Enum.any?(MockRunner.commands(), fn {cmd, args} ->
               cmd == "tmux" and hd(args) == "new-session"
             end)
    end)

    snap = Poller.snapshot(poller)
    refute snap.contract.ok
    refute Enum.any?(snap.pending_launch, &(&1.fiber_id == fiber_id))
  end
end
