defmodule Shuttle.PollerFixtureTest do
  use ExUnit.Case, async: true
  alias Shuttle.Test.{FeltStoreRunner, PollerHelpers}

  test "fixture teardown stops this Poller's app-supervised work" do
    parent = self()

    {:ok, task} = Task.Supervisor.start_child(Shuttle.TaskSupervisor, fn ->
      receive do
        {:poller, poller} ->
          Shuttle.Env.adopt_callers([poller])
          send(parent, :task_adopted)
          receive do
            :finish -> :ok
          end
      end
    end)

    # Registered before the fixture, so this observes completed fixture cleanup.
    on_exit(fn ->
      alive = Process.alive?(task)
      Task.Supervisor.terminate_child(Shuttle.TaskSupervisor, task)
      refute alive
    end)

    FeltStoreRunner.start!()
    {:ok, poller} = PollerHelpers.start_poller!(
      runner: FeltStoreRunner,
      felt_stores: [FeltStoreRunner.felt_root()],
      own_host_id: "test-host",
      poll_interval_ms: 600_000
    )
    PollerHelpers.await_boot_cycle!(poller)
    send(task, {:poller, poller})
    assert_receive :task_adopted
    assert Process.alive?(task)
  end
end
