defmodule Shuttle.PollerTraceTest do
  # The Poller: filesystem calls the Poller must never make, observed with `:dbg` call tracing.
  # group: the :dbg tracer and `:dbg.stop_clear/0` are VM-wide (they clear every
  # call-trace pattern, FileReadTrace's included).
  use Shuttle.Test.PollerCase, async: true, group: :call_trace

  test "poller never stats a pure-ineligible fiber's project_dir (iCloud/TCC guard)" do
    # `project_dir_available?/1` is the only per-tick filesystem read that
    # leaves the felt store — it stats `shuttle.project_dir`. On a fiber whose
    # project_dir lives on a macOS file provider (iCloud Drive,
    # ~/Library/CloudStorage), statting it every poll raises a repeating
    # un-grantable TCC "access data from other apps" prompt. `filter_eligible/2`
    # and `eligible?/2` must run every cheap, pure, in-memory gate BEFORE
    # touching that stat, so a fiber a pure predicate already rejects (here: a
    # paused oneshot, status: open) never reaches it. This
    # test proves that by tracing real calls to `File.dir?/1` inside the
    # poller process across a poll tick and asserting the sentinel
    # project_dir path is never among the args — a regression that
    # reintroduces `project_dir_available?` ahead of the pure gates would stat
    # it and fail this test, even though the resulting eligibility decision
    # (not dispatched) looks identical either way.
    sentinel_dir = "/tmp/felt-icloud-sentinel-#{System.unique_integer([:positive])}"
    refute File.exists?(sentinel_dir)

    fiber = make_fiber("tests/paused-icloud-sentinel", %{"status" => "open"})
    MockRunner.set_fiber("tests/paused-icloud-sentinel", fiber)

    MockRunner.set_shuttle(
      "tests/paused-icloud-sentinel",
      "kind: oneshot\nagent: claude-opus\nproject_dir: #{sentinel_dir}\n",
      "open"
    )

    {:ok, poller} =
      start_poller!(
        name: :test_poller_paused_icloud_sentinel,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    # `:dbg` (runtime_tools) ships on-disk with the OTP install but, unlike
    # :logger/etc, isn't automatically on this project's code path — locate
    # and add it so the real stdlib :dbg tracer is usable without touching
    # mix.exs.
    [runtime_tools_ebin] =
      :code.root_dir()
      |> to_string()
      |> Path.join("lib/runtime_tools-*/ebin")
      |> Path.wildcard()

    :code.add_pathz(String.to_charlist(runtime_tools_ebin))
    {:ok, _} = Application.ensure_all_started(:runtime_tools)

    test_pid = self()

    # Called via apply/3 (not a compile-time :dbg.foo(...) call) because :dbg
    # only lands on the code path above, at runtime — the compiler can't see
    # it ahead of time and mix's --warnings-as-errors would otherwise choke
    # on "module :dbg is not available".
    apply(:dbg, :tracer, [
      :process,
      {fn msg, n ->
         send(test_pid, {:dbg_relay, msg})
         n + 1
       end, 0}
    ])

    apply(:dbg, :p, [poller, [:call]])
    apply(:dbg, :tpl, [Shuttle.FS, :dir?, :x])

    on_exit(fn -> apply(:dbg, :stop_clear, []) end)

    sync_poll_cycle!(poller)
    stat_calls = drain_dbg_relay!(poller)

    refute Enum.any?(stat_calls, fn
             {:trace, _pid, :call, {Shuttle.FS, :dir?, [^sentinel_dir]}} -> true
             _ -> false
           end),
           "poller must not stat a paused fiber's project_dir " <>
             "(the status gate must run before the filesystem gate)"

    refute Enum.any?(
             Poller.snapshot(poller).eligible,
             &(&1.fiber_id == "tests/paused-icloud-sentinel")
           )
  end

  test "poller touches no filesystem path under a parked fiber's project_dir (per-tick TCC guard)" do
    # The per-tick path must be PURE. Everything the poller does with a
    # `project_dir` short of dispatching — eligibility, parking, the snapshot —
    # reads frontmatter and runtime maps, so a fiber it merely looks at is
    # never touched. It has twice been otherwise: a `File.dir?` stat, and a
    # per-segment `Shuttle.Realpath` symlink walk (the latter for a
    # checkout-exclusion rule that no longer exists), both running for every
    # candidate every tick. For a project_dir inside a macOS file provider
    # either one raises the un-grantable "access data from other apps" TCC
    # prompt, tick after tick, for a fiber (here `status: open`) the poller
    # never intended to dispatch.
    #
    # HOME is repointed so the project_dir is a genuine file-provider path, and
    # the directory really exists, so a regression cannot pass by virtue of an
    # early "nothing there" return. Both `:file.read_link/1` (the realpath
    # walk) and `File.dir?/1` (the dispatch-time stat) are traced inside the
    # poller process; neither may be called with anything under that root.
    home = Path.join(System.tmp_dir!(), "shuttle-test-home-#{System.unique_integer([:positive])}")
    protected_root = Path.join([home, "Library", "Mobile Documents"])
    project_dir = Path.join(protected_root, "checkout")
    File.mkdir_p!(project_dir)
    Env.put_env("HOME", home)

    # BOTH spellings of the fake home. `System.tmp_dir!/0` is `/var/folders/…`
    # on macOS, but `/var` is a symlink, so the realpath walk this test exists
    # to catch emits `/private/var/folders/…` — matching only the unresolved
    # prefix would make every assertion below vacuously true.
    home_prefixes =
      case Shuttle.Realpath.resolve(home) do
        {:ok, resolved} -> Enum.uniq([home, resolved])
        {:error, _} -> [home]
      end

    on_exit(fn -> File.rm_rf(home) end)

    fiber = make_fiber("tests/parked-icloud-project-dir", %{"status" => "open"})
    MockRunner.set_fiber("tests/parked-icloud-project-dir", fiber)

    MockRunner.set_shuttle(
      "tests/parked-icloud-project-dir",
      "kind: oneshot\nhost: test-host\nproject_dir: #{project_dir}\n",
      "open"
    )

    {:ok, poller} =
      start_poller!(
        name: :test_poller_parked_protected_project_dir,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    # Same :dbg setup as the paused-sentinel test above — runtime_tools is on
    # disk but not on this project's code path, and :dbg is reached through
    # apply/3 so the compiler never sees an unavailable module.
    [runtime_tools_ebin] =
      :code.root_dir()
      |> to_string()
      |> Path.join("lib/runtime_tools-*/ebin")
      |> Path.wildcard()

    :code.add_pathz(String.to_charlist(runtime_tools_ebin))
    {:ok, _} = Application.ensure_all_started(:runtime_tools)

    test_pid = self()

    apply(:dbg, :tracer, [
      :process,
      {fn msg, n ->
         send(test_pid, {:dbg_relay, msg})
         n + 1
       end, 0}
    ])

    apply(:dbg, :p, [poller, [:call]])
    apply(:dbg, :tpl, [Shuttle.FS, :dir?, :x])
    apply(:dbg, :tpl, [Shuttle.FS, :read_link, :x])

    on_exit(fn -> apply(:dbg, :stop_clear, []) end)

    sync_poll_cycle!(poller)

    touched =
      drain_dbg_relay!(poller)
      |> Enum.flat_map(fn
        {:trace, _pid, :call, {_mod, _fun, [arg]}} -> [to_string(arg)]
        _other -> []
      end)
      |> Enum.filter(fn arg -> Enum.any?(home_prefixes, &String.starts_with?(arg, &1)) end)

    assert touched == [],
           "poller touched a TCC-protected path on a plain tick: #{inspect(touched)}"

    refute Enum.any?(
             Poller.snapshot(poller).eligible,
             &(&1.fiber_id == "tests/parked-icloud-project-dir")
           )
  end

  test "an active fiber's unreachable project_dir is stat'd once, then sits out the cooldown" do
    # The dispatch-time gate, and the breaker behind it. A project_dir that is
    # absent and one this daemon is DENIED are the same `File.dir?` answer, and
    # under a macOS file provider the denial arrives as an un-grantable TCC
    # prompt — so re-stat'ing every tick puts a dialog on someone's screen
    # forever, on exactly the configuration that cannot come good by itself.
    # The refusal lands in `dispatch_failures`, and `preflight_cooldown_open?`
    # keeps the fiber out of the eligible set until the window lapses.
    home = Path.join(System.tmp_dir!(), "shuttle-test-home-#{System.unique_integer([:positive])}")
    project_dir = Path.join([home, "Library", "Mobile Documents", "unreachable"])
    File.mkdir_p!(Path.join([home, "Library", "Mobile Documents"]))
    Env.put_env("HOME", home)

    on_exit(fn -> File.rm_rf(home) end)

    expanded_dir = Path.expand(project_dir)
    fiber_id = "tests/unreachable-project-dir"
    shuttle = "enabled: true\nkind: oneshot\nhost: test-host\nproject_dir: #{project_dir}\n"

    {:ok, poller} =
      start_poller!(
        name: :test_poller_unreachable_project_dir,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    settle_poller!(poller)

    # `:dbg` again — runtime_tools is on disk but not on this project's code
    # path, and :dbg is reached through apply/3 so the compiler never sees an
    # unavailable module.
    [runtime_tools_ebin] =
      :code.root_dir()
      |> to_string()
      |> Path.join("lib/runtime_tools-*/ebin")
      |> Path.wildcard()

    :code.add_pathz(String.to_charlist(runtime_tools_ebin))
    {:ok, _} = Application.ensure_all_started(:runtime_tools)

    test_pid = self()

    apply(:dbg, :tracer, [
      :process,
      {fn msg, n ->
         send(test_pid, {:dbg_relay, msg})
         n + 1
       end, 0}
    ])

    apply(:dbg, :p, [poller, [:call]])
    apply(:dbg, :tpl, [Shuttle.FS, :dir?, :x])
    apply(:dbg, :tpl, [Shuttle.FS, :read_link, :x])

    on_exit(fn -> apply(:dbg, :stop_clear, []) end)

    drain = fn ->
      Stream.repeatedly(fn ->
        receive do
          {:dbg_relay, {:trace, _pid, :call, {mod, fun, [arg]}}} ->
            {:ok, {mod, fun, to_string(arg)}}

          {:dbg_relay, _other} ->
            {:ok, nil}
        after
          0 -> :done
        end
      end)
      |> Enum.take_while(&(&1 != :done))
      |> Enum.map(fn {:ok, call} -> call end)
      |> Enum.filter(fn
        {_mod, _fun, arg} -> String.contains?(arg, "Mobile Documents")
        nil -> false
      end)
    end

    # Registered only now: the settling ticks above would otherwise have taken
    # the one stat this test is here to observe.
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id))
    MockRunner.set_shuttle(fiber_id, shuttle)

    sync_poll_cycle!(poller)
    first = drain.()

    assert first == [{Shuttle.FS, :dir?, expanded_dir}],
           "the dispatch attempt must stat the project_dir exactly once: #{inspect(first)}"

    # The refusal shows as a blocked row rather than the fiber silently
    # vanishing, and it IS the breaker's state — no parallel bookkeeping.
    assert %{reason: reason} =
             Enum.find(Poller.snapshot(poller).blocked, &(&1.fiber_id == fiber_id))

    assert reason =~ "project_dir"

    sync_poll_cycle!(poller)
    sync_poll_cycle!(poller)

    assert drain.() == [], "a fiber inside its cooldown must not be re-stat'd"
    refute Enum.any?(Poller.snapshot(poller).eligible, &(&1.fiber_id == fiber_id))

    # ── A stable fleet touches nothing either ──
    #
    # Two healthy checkouts under the same provider root. Each is stat'd once,
    # by its own dispatch; from then on their fibers are running and every
    # later tick reads runtime maps alone.
    for leaf <- ["checkout-a", "checkout-c"] do
      dir = Path.join([home, "Library", "Mobile Documents", leaf])
      File.mkdir_p!(dir)
      id = "tests/#{leaf}"
      MockRunner.set_fiber(id, make_fiber(id))

      MockRunner.set_shuttle(
        id,
        "enabled: true\nkind: oneshot\nhost: test-host\nproject_dir: #{dir}\n"
      )
    end

    assert wait_until(fn ->
             sync_poll_cycle!(poller)

             running =
               :sys.get_state(poller, @state_timeout).running
               |> Enum.map(fn {_k, meta} -> meta.fiber_id end)
               |> MapSet.new()

             MapSet.subset?(MapSet.new(["tests/checkout-a", "tests/checkout-c"]), running)
           end)

    # Discard the two dispatches' own stats; from here the world is stable.
    drain.()

    sync_poll_cycle!(poller)
    sync_poll_cycle!(poller)
    sync_poll_cycle!(poller)

    assert drain.() == [], "a stable fleet must touch no project_dir at all"
  end
end
