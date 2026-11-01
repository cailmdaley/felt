defmodule Shuttle.PollerBootTest do
  use ExUnit.Case, async: true

  alias Shuttle.{FileAccess, Poller}
  alias Shuttle.Test.Env
  alias Shuttle.Test.FeltStoreRunner, as: MockRunner
  import Shuttle.Test.PollerHelpers

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

  @tag :tmp_dir
  test "unavailable cold inventory keeps the Poller alive and refuses lifecycle work until recovery",
       %{tmp_dir: dir} do
    MockRunner.start!()
    protected = Path.join(dir, "protected")
    File.mkdir_p!(protected)
    registry = Path.join(protected, "stores.json")
    File.write!(registry, ~s({"felt_stores":[]}))
    Env.put_env("SHUTTLE_STORES", nil)
    Env.put_env("SHUTTLE_STORES_FILE", registry)
    Env.start_scoped!({FileAccess, name: nil, capacity: 4, protected_roots: [protected]})

    assert_raise FileAccess.Error, fn ->
      FileAccess.task(registry, fn -> {:error, :eacces} end)
    end

    {:ok, poller} =
      start_poller!(runner: MockRunner, own_host_id: "test-host", poll_interval_ms: 60_000)

    assert Process.alive?(poller)

    assert %{store_inventory: %{state: "unavailable", reason: reason}} =
             Poller.snapshot(poller).poll_health

    assert reason =~ protected

    assert {:error, {:store_inventory_unavailable, _}} =
             Poller.dispatch_fiber(poller, "tests/held", force: true)

    assert {:error, {:store_inventory_unavailable, _}} =
             Poller.lifecycle_transition(poller, "resume", "tests/held")

    :ok = FileAccess.reset()
    await(fn -> not :sys.get_state(poller).poll_check_in_progress end)
    send(poller, :run_poll_cycle)
    await(fn -> Poller.snapshot(poller).poll_health.store_inventory.state == "available" end)

    assert %{store_inventory: %{state: "available", reason: nil}} =
             Poller.snapshot(poller).poll_health
  end

  @tag :tmp_dir
  test "uncertain project probes defer dispatch without arming the document", %{tmp_dir: dir} do
    MockRunner.start!()
    MockRunner.reset()
    store = MockRunner.felt_root()
    on_exit(fn -> File.rm_rf(store) end)
    project = Path.join(dir, "protected")
    File.mkdir_p!(project)
    Env.start_scoped!({FileAccess, name: nil, capacity: 4, protected_roots: [project]})
    assert_raise FileAccess.Error, fn -> FileAccess.task(project, fn -> {:error, :eacces} end) end
    id = "tests/protected-project"

    MockRunner.set_shuttle(
      id,
      "kind: oneshot\nhost: test-host\nproject_dir: #{project}\n",
      "closed"
    )

    {:ok, poller} =
      start_poller!(
        runner: MockRunner,
        own_host_id: "test-host",
        felt_stores: [MockRunner.felt_root()],
        poll_interval_ms: 60_000
      )

    before = MockRunner.commands()

    assert {:error, {:filesystem_unavailable, reason}} =
             Poller.dispatch_fiber(poller, id, force: true, resume_mode: "fresh")

    assert reason =~ project
    assert Process.alive?(poller)
    assert MockRunner.fiber(id)["status"] == "closed"

    refute Enum.any?(MockRunner.commands() -- before, fn {_, args} ->
             "reopen" in args or "mark-runtime" in args
           end)
  end

  defp await(fun, tries \\ 300)
  defp await(fun, 0), do: assert(fun.())

  defp await(fun, tries) do
    if fun.(),
      do: :ok,
      else:
        (
          Process.sleep(10)
          await(fun, tries - 1)
        )
  end

  test "a call to the registered Poller during slow init is processed after init" do
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

    # GenServer registers its name before init/1. The call message queues in
    # that registered process while orphan adoption is blocked, then is served
    # from initialized state after init returns.
    snapshot = Task.async(fn -> Poller.snapshot(name, 30_000) end)
    send(adoption_process, :finish_adoption)

    assert {:ok, poller} = Task.await(starter, 30_000)
    assert is_map(Task.await(snapshot, 30_000))
    assert Process.alive?(poller)
  end
end
