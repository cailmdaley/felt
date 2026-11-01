defmodule Shuttle.PollerBootTest do
  use ExUnit.Case, async: true

  alias Shuttle.Poller
  alias Shuttle.Test.FeltStoreRunner, as: MockRunner

  defmodule RetryingAdoptionRunner do
    @behaviour Shuttle.Runner

    def cmd(command, args, opts) do
      if command == "shuttle" and "show" in args do
        counter = Shuttle.Env.app(:adoption_attempt_counter)
        attempt = Agent.get_and_update(counter, &{&1, &1 + 1})

        case attempt do
          0 ->
            send(Shuttle.Env.app(:adoption_observer), {:adopting, self()})
            receive do: (:continue_adoption -> :ok)

          1 ->
            raise "transient failure after the first adoption"

          _ ->
            :ok
        end
      end

      MockRunner.cmd(command, args, opts)
    end
  end

  defmodule BlockingInitRunner do
    @behaviour Shuttle.Runner

    def cmd("shuttle", ["contract"], _opts),
      do: {Integer.to_string(Shuttle.Contract.expected_level()) <> "\n", 0}

    # Only boot adoption's scan blocks. Every poll cycle's apply runs the same
    # scan on the Poller process, and a block there would wedge the Poller
    # against the test's on_exit stop.
    def cmd("tmux", ["ls", "-F", _format], _opts) do
      if Process.put(:boot_scan_blocked, true) do
        {"", 1}
      else
        test_pid = Shuttle.Env.app(:poller_boot_test_pid)
        send(test_pid, {:adoption_blocked, self()})

        receive do
          :finish_adoption -> {"", 1}
        end
      end
    end

    def cmd("felt", args, _opts) do
      if "ls" in args, do: {"[]\n", 0}, else: {"", 1}
    end

    def cmd(_command, _args, _opts), do: {"", 1}
  end

  test "start_link acknowledges before adoption and publishes only after boot settles" do
    Shuttle.Test.Env.put_app_env(:poller_boot_test_pid, self())

    name = Module.concat(__MODULE__, "Poller#{System.unique_integer([:positive])}")
    on_exit(fn -> if pid = Process.whereis(name), do: GenServer.stop(pid) end)

    starter =
      Task.async(fn ->
        Poller.start_link(
          name: name,
          runner: BlockingInitRunner,
          felt_stores: [System.tmp_dir!()],
          own_host_id: "boot-test-host",
          boot_quarantine: true,
          poll_interval_ms: 60_000
        )
      end)

    assert_receive {:adoption_blocked, adoption_process}
    assert Process.whereis(name)

    assert {:ok, poller} = Task.await(starter, 30_000)
    assert Poller.snapshot(name) == %{}
    send(adoption_process, :finish_adoption)
    :sys.get_state(poller, 30_000)
    assert adoption_process == poller
    assert %{boot_quarantine: true} = Poller.snapshot(name)
    assert Process.alive?(poller)
  end

  @tag :tmp_dir
  test "an adoption retry replaces partial observers without duplicating them", %{tmp_dir: root} do
    MockRunner.start!()
    store = MockRunner.felt_root()
    on_exit(fn -> File.rm_rf(store) end)
    Shuttle.Test.Env.put_env("SHUTTLE_DATA_DIR", root)
    counter = start_supervised!({Agent, fn -> 0 end})
    Shuttle.Test.Env.put_app_env(:adoption_attempt_counter, counter)
    Shuttle.Test.Env.put_app_env(:adoption_observer, self())

    for id <- ["tests/adopt-one", "tests/adopt-two"] do
      MockRunner.set_fiber(id, Shuttle.Test.PollerHelpers.make_fiber(id))
      MockRunner.set_shuttle(id, "kind: oneshot\n")
      MockRunner.add_tmux_session(Shuttle.Test.FiberUid.session(id))
    end

    pid =
      start_supervised!(
        {Poller,
         name: nil,
         runner: RetryingAdoptionRunner,
         own_host_id: "test-host",
         felt_stores: [MockRunner.felt_root()],
         boot_quarantine: true,
         poll_interval_ms: 60_000}
      )

    assert_receive {:adopting, ^pid}, 5_000

    trace = :trace.session_create(:adoption_watchers, self(), [])
    :trace.function(trace, {Poller, :start_watcher, 3}, [{:_, [], [{:return_trace}]}], [:local])
    :trace.process(trace, pid, true, [:call])

    try do
      send(pid, :continue_adoption)

      assert_receive {:trace, ^pid, :return_from, {Poller, :start_watcher, 3},
                      {:ok, %{pid: first}}},
                     5_000

      monitor = Process.monitor(first)
      assert_receive {:DOWN, ^monitor, :process, ^first, _}, 2_000
      state = :sys.get_state(pid, 30_000)
      assert state.boot_hold == nil
      watchers = Enum.map(Map.values(state.running), & &1.pid)
      assert length(watchers) == 2
      assert Enum.uniq(watchers) == watchers
      refute first in watchers

      refute Enum.any?(MockRunner.commands(), fn
               {"tmux", ["kill-session" | _]} -> true
               _ -> false
             end)
    after
      :trace.session_destroy(trace)
      GenServer.stop(pid)
    end
  end

  test "init performs no filesystem calls before acknowledging its supervisor" do
    Shuttle.Test.Env.own_scope!()
    observer = self()
    callers = Shuttle.Env.callers()

    worker =
      spawn(fn ->
        receive do
          :go ->
            Shuttle.Env.adopt_callers(callers)
            result = Poller.init(own_host_id: "no-io", runner: BlockingInitRunner)
            send(observer, {:initialized, result})
            receive do: (:stop -> :ok)
        end
      end)

    session = :trace.session_create(:poller_init_io, self(), [])
    :trace.function(session, {Shuttle.FS, :_, :_}, true, [:local])
    :trace.function(session, {Shuttle.Env, :cmd, :_}, true, [:local])
    :trace.function(session, {BlockingInitRunner, :cmd, :_}, true, [:local])
    :trace.process(session, worker, true, [:call])

    try do
      send(worker, :go)

      assert_receive {:initialized,
                      {:ok, %{boot_hold: %{stage: "initializing"}}, {:continue, {:boot, _}}}}

      ref = :trace.delivered(session, worker)
      assert_receive {:trace_delivered, ^worker, ^ref}

      refute_received {:trace, ^worker, :call, _}
    after
      :trace.session_destroy(session)
      Process.exit(worker, :kill)
    end
  end

  @tag :tmp_dir
  test "failed readiness is published only after the held Poller snapshot exists", %{
    tmp_dir: root
  } do
    Shuttle.Test.Env.put_env("SHUTTLE_DATA_DIR", root)
    File.write!(Path.join(root, "thread-outbox.json"), "not json")
    session = :trace.session_create(:held_publication, self(), [])

    :trace.function(
      session,
      {Poller, :initialize_publication, 1},
      [{:_, [], [{:return_trace}]}],
      [:local]
    )

    :trace.function(session, {Shuttle.Readiness, :poller_boot, 1}, true, [:local])
    :trace.process(session, self(), true, [:call, :set_on_spawn])
    {:ok, pid} = Poller.start_link(name: nil, own_host_id: "held-publication", felt_stores: [])

    try do
      assert %{boot_hold: %{stage: "outbox_baseline"}} = :sys.get_state(pid)
      ref = :trace.delivered(session, :all)
      assert_receive {:trace_delivered, :all, ^ref}
      events = trace_events(pid, [])

      published =
        Enum.find_index(
          events,
          &match?({:trace, ^pid, :return_from, {Poller, :initialize_publication, 1}, _}, &1)
        )

      held =
        Enum.find_index(events, fn
          {:trace, ^pid, :call, {Shuttle.Readiness, :poller_boot, [%{reason: reason}]}} ->
            reason != "booting"

          _ ->
            false
        end)

      assert is_integer(published) and is_integer(held), inspect(events)
      assert published < held
    after
      :trace.session_destroy(session)
      GenServer.stop(pid)
    end
  end

  defp trace_events(pid, events) do
    receive do
      {:trace, ^pid, :call, _} = event -> trace_events(pid, [event | events])
      {:trace, ^pid, :return_from, _, _} = event -> trace_events(pid, [event | events])
    after
      0 -> Enum.reverse(events)
    end
  end

  @tag :tmp_dir
  test "a corrupt outbox is a named hold and cannot be forced or released", %{tmp_dir: root} do
    Shuttle.Test.Env.put_env("SHUTTLE_DATA_DIR", root)
    snapshot = Path.join(root, "thread-outbox.json")
    File.write!(snapshot, "not json")
    pid = start_supervised!({Poller, name: nil, own_host_id: "held-host", felt_stores: []})
    assert %{boot_hold: %{stage: "outbox_baseline"}, boot_quarantine: true} = :sys.get_state(pid)
    assert {:error, {:boot_hold, _}} = Poller.dispatch_fiber(pid, "anything", force: true)
    assert {:error, {:boot_hold, _}} = Poller.release_boot_quarantine(pid)
    assert File.read!(snapshot) == "not json"
    assert Process.alive?(pid)
    assert %{ready: false, boot_hold: %{stage: "outbox_baseline"}} = Shuttle.Readiness.status()
  end
end
