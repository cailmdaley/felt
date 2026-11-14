defmodule Shuttle.PollerBreakerTest do
  # The Poller: the resume-loop breaker and preflight cooldowns.
  use Shuttle.Test.PollerCase, async: true

  test "a standing worker exit without handoff concludes its run and leaves it armed" do
    # A STANDING (cron) worker's exit stamps handed_off_at, so the cron does not
    # re-fire the occurrence it served; the role stays active for its next tick.
    Env.put_env("SHUTTLE_STORES", MockRunner.felt_root())

    fiber_id = "tests/standing-exit-closes"
    leaf = fiber_id |> String.split("/") |> List.last()
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id, %{"status" => "active"}))

    MockRunner.set_shuttle(
      fiber_id,
      """
      kind: standing
      agent: claude-sonnet
      schedule:
        expr: "0 9 * * *"
        tz: Europe/Paris
      """,
      "active"
    )

    {:ok, poller} =
      start_poller!(
        name: :test_poller_standing_exit_closes,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    assert {:ok, _session} = Poller.dispatch_fiber(poller, fiber_id, force: true, ad_hoc: true)

    end_worker_session(poller, fiber_id)
    :sys.get_state(poller, @state_timeout)

    path = "#{MockRunner.felt_dir()}/#{fiber_id}/#{leaf}.md"
    assert {:ok, _, _, fm, _} = Shuttle.FiberDoc.read_path(path)
    assert fm["status"] == "active"
    refute Map.has_key?(fm, "closed-at")
    assert is_binary(fm["shuttle"]["runtime"]["handed_off_at"])
    assert fm["shuttle"]["runtime"]["thread_exit_verb"] == "handed off"
  end

  test "poll-discovered rapid exits open the same resume-loop breaker" do
    fiber_id = "tests/poll-first-resume-loop"
    MockRunner.set_shuttle(fiber_id, "kind: oneshot\nagent: claude-sonnet\n", "active")

    {:ok, poller} =
      start_poller!(
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    for _ <- 1..5 do
      :sys.replace_state(poller, fn state ->
        meta = %{
          fiber_id: fiber_id,
          uid: FiberUid.for(fiber_id),
          pid: nil,
          session: FiberUid.session(fiber_id),
          agent_id: "claude-sonnet",
          started_at: DateTime.utc_now(),
          last_activity_at: DateTime.utc_now()
        }

        %{state | running: Map.put(state.running, FiberUid.for(fiber_id), meta)}
      end)

      sync_poll_cycle!(poller)
    end

    assert loop_blocked?(poller, fiber_id)
  end

  test "resume-loop breaker pauses a oneshot whose workers keep dying instantly, and force-dispatch overrides it" do
    # The kill-and-resume churn: a still-active oneshot whose worker dies almost
    # immediately (stale/unresumable session, wrong project_dir, TCC-blocked cwd)
    # is re-dispatched every poll, dying again each time — observed as 125 resumes
    # of one fiber in a day. After @resume_loop_max_rapid_exits consecutive rapid
    # exits the breaker opens: the fiber goes ineligible (surfaced as `blocked`)
    # until a cooldown or a human force-dispatch. Reverting the eligible? guard or
    # note_worker_lifetime re-arms the infinite loop.
    fiber_id = "tests/resume-loop-breaker"
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id, %{"status" => "active"}))
    MockRunner.set_shuttle(fiber_id, "kind: oneshot\nagent: claude-sonnet\n", "active")

    # max_concurrent_workers: 0 disables the autonomous tick's dispatch (the
    # first poll fires at 0ms and would otherwise spawn a real worker mid-test);
    # explicit Poller.dispatch_fiber/3 is not slot-gated, so the breaker path is
    # still fully exercised.
    {:ok, poller} =
      start_poller!(
        name: :test_poller_resume_loop_breaker,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        felt_stores: [MockRunner.felt_root()]
      )

    # Four rapid (0s-lifetime) exits — one short of tripping; breaker stays closed.
    for _ <- 1..4, do: simulate_exit(poller, fiber_id, 0)
    refute loop_blocked?(poller, fiber_id)

    # The fifth rapid exit opens the breaker: now blocked, and an autonomous
    # (non-force) dispatch is refused.
    simulate_exit(poller, fiber_id, 0)
    assert loop_blocked?(poller, fiber_id)
    assert {:error, _} = Poller.dispatch_fiber(poller, fiber_id, [])

    # A human force-dispatch is an explicit "go": it clears the breaker and spawns.
    assert {:ok, _} = Poller.dispatch_fiber(poller, fiber_id, force: true)
    refute loop_blocked?(poller, fiber_id)
  end

  test "a refused wrapper preflight parks the fiber instead of re-probing every tick" do
    # The preflight closed the silent failure, but it also removed that failure's
    # only brake: the resume-loop breaker counts worker EXITS, and a refused
    # dispatch never spawns a worker to exit. Left ungated, a host whose wrapper
    # is missing would spawn a fresh `bash -l` for every fiber on every tick —
    # synchronously, inside this GenServer — forever. So a refusal parks the
    # fiber for @preflight_cooldown_ms.
    fiber_id = "tests/preflight-cooldown"
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id, %{"status" => "active"}))
    MockRunner.set_shuttle(fiber_id, "kind: oneshot\nagent: claude-sonnet\n", "active")
    MockRunner.set_wrapper_missing(true)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_preflight_cooldown,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        felt_stores: [MockRunner.felt_root()]
      )

    assert {:error, {:wrapper_unresolved, message}} =
             Poller.dispatch_fiber(poller, fiber_id, [])

    # It surfaces on the board carrying the message that names the fix — not an
    # inspected tuple.
    blocked =
      Enum.find(Poller.snapshot(poller).blocked, &(&1.fiber_id == fiber_id))

    assert blocked.reason == message
    assert blocked.reason =~ "did not resolve"

    # Parked: a second autonomous (non-force) dispatch is refused by the
    # cooldown WITHOUT spending another login shell. The probe count not moving
    # is the whole point of the gate.
    probes_before =
      Enum.count(MockRunner.commands(), &match?({"bash", ["-lc", _]}, &1))

    assert {:error, _} = Poller.dispatch_fiber(poller, fiber_id, [])

    assert Enum.count(MockRunner.commands(), &match?({"bash", ["-lc", _]}, &1)) ==
             probes_before

    # A human force-dispatch is an explicit "go" and bypasses the cooldown —
    # it still refuses (the wrapper is still missing) but it did re-probe,
    # which is what lets an operator retry the instant they fix it.

    assert {:error, {:wrapper_unresolved, _}} =
             Poller.dispatch_fiber(poller, fiber_id, force: true)

    probes_after = Enum.count(MockRunner.commands(), &match?({"bash", ["-lc", _]}, &1))
    assert probes_after > probes_before

    # And once the wrapper is installed, a successful dispatch clears the entry.
    MockRunner.set_wrapper_missing(false)
    assert {:ok, _} = Poller.dispatch_fiber(poller, fiber_id, force: true)
    refute Enum.any?(Poller.snapshot(poller).blocked, &(&1.fiber_id == fiber_id))
  end

  test "a refused tmux-server preflight parks the fiber for the cooldown" do
    # macOS only: a dispatch with no tmux server and no reachable kitty must
    # refuse rather than fork the server under the daemon (TCC would then charge
    # every worker's file access to the daemon binary). Like the wrapper
    # refusal, it never spawns a worker to exit, so the resume-loop breaker
    # cannot brake it — the preflight cooldown has to.
    fiber_id = "tests/tmux-server-cooldown"
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id, %{"status" => "active"}))
    MockRunner.set_shuttle(fiber_id, "kind: oneshot\nagent: claude-sonnet\n", "active")

    Env.put_app_env(:os_type, {:unix, :darwin})
    Env.put_app_env(:kitty_impl, NoKitty)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_tmux_server_cooldown,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        felt_stores: [MockRunner.felt_root()]
      )

    # The boot cycle's own `tmux ls` lands before the probe count below.
    settle_poller!(poller)
    MockRunner.set_tmux_server_missing(true)

    assert {:error, {:tmux_server_unavailable, message}} =
             Poller.dispatch_fiber(poller, fiber_id, [])

    # The board shows the operator-facing message verbatim — the human's only
    # other clue is a stream of "erlexec" prompts that names nothing they own.
    blocked = Enum.find(Poller.snapshot(poller).blocked, &(&1.fiber_id == fiber_id))
    assert blocked.reason == message
    assert blocked.reason =~ "erlexec"

    # Parked: the next autonomous attempt is refused by the cooldown without
    # spending another `tmux ls` / kitty round trip — and an explicit dispatch
    # during the cooldown still says WHY. Reporting "not yet due" here (the old
    # behaviour) pointed the human at the schedule for the whole five minutes,
    # while the real answer was already recorded.
    probes_before = Enum.count(MockRunner.commands(), &match?({"tmux", ["ls" | _]}, &1))

    assert {:error, {:tmux_server_unavailable, ^message}} =
             Poller.dispatch_fiber(poller, fiber_id, [])

    # One inventory checks for a worker under a different leaf with the same
    # uid. The cooldown prevents a second server preflight.
    assert Enum.count(MockRunner.commands(), &match?({"tmux", ["ls" | _]}, &1)) ==
             probes_before + 1

    # Once a server exists, a dispatch succeeds and clears the entry.
    MockRunner.set_tmux_server_missing(false)
    assert {:ok, _} = Poller.dispatch_fiber(poller, fiber_id, force: true)
    refute Enum.any?(Poller.snapshot(poller).blocked, &(&1.fiber_id == fiber_id))
  end

  test "a healthy worker run resets the resume-loop breaker count" do
    # A long-lived run (≥ the rapid-exit threshold) is the system working: it must
    # zero the consecutive-rapid-exit count so a fiber that occasionally has a fast
    # exit between real work never trips.
    fiber_id = "tests/resume-loop-reset"
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id, %{"status" => "active"}))
    MockRunner.set_shuttle(fiber_id, "kind: oneshot\nagent: claude-sonnet\n", "active")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_resume_loop_reset,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        felt_stores: [MockRunner.felt_root()]
      )

    # 4 rapid exits — one short of tripping.
    for _ <- 1..4, do: simulate_exit(poller, fiber_id, 0)

    # A healthy run lands (lived well past the threshold): clears the count.
    simulate_exit(poller, fiber_id, 3600)

    # 4 more rapid exits still don't trip (the reset means it would take 5 fresh).
    for _ <- 1..4, do: simulate_exit(poller, fiber_id, 0)
    refute loop_blocked?(poller, fiber_id)
  end
end
