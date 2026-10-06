defmodule Shuttle.PollerBootTest do
  use ExUnit.Case, async: true

  alias Shuttle.Poller

  defmodule BlockingInitRunner do
    @behaviour Shuttle.Runner

    def cmd("shuttle", ["contract"], _opts),
      do: {Integer.to_string(Shuttle.Contract.expected_level()) <> "\n", 0}

    def cmd("tmux", ["ls", "-F", _format], _opts) do
      test_pid = Shuttle.Env.app(:poller_boot_test_pid)
      send(test_pid, {:adoption_blocked, self()})

      receive do
        :finish_adoption -> {"", 1}
      end
    end

    def cmd("felt", args, _opts) do
      if "ls" in args, do: {"[]\n", 0}, else: {"", 1}
    end

    def cmd(_command, _args, _opts), do: {"", 1}
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
    snapshot = Task.async(fn -> Poller.snapshot(name, 5_000) end)
    send(adoption_process, :finish_adoption)

    assert {:ok, poller} = Task.await(starter, 30_000)
    assert is_map(Task.await(snapshot, 30_000))
    assert Process.alive?(poller)
  end
end
