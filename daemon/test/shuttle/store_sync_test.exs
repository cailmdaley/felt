defmodule Shuttle.StoreSyncTest do
  use ExUnit.Case, async: true

  defmodule Runner do
    def cmd("felt", ["-C", store, "sync", "--fetch-timeout", "5s"], opts) do
      send(Shuttle.Env.app(:sync_test_owner), {:sync_started, self(), store, opts[:timeout_ms]})

      receive do
        {:finish, result} -> result
      end
    end
  end

  defmodule BoundaryPoller do
    use GenServer
    def start_link(_), do: GenServer.start_link(__MODULE__, nil)
    def init(_), do: {:ok, nil}

    def handle_call({:sync_missing_stores, stores}, _from, state) do
      send(Shuttle.Env.app(:sync_test_owner), {:at_sync_boundary, self()})

      receive do
        :continue -> :ok
      end

      {:reply, Shuttle.StoreSync.sync(stores), state}
    end
  end

  test "read recovery waits for the Poller write boundary before pulling" do
    Shuttle.Test.Env.put_app_env(:felt_runner, Runner)
    Shuttle.Test.Env.put_app_env(:sync_test_owner, self())
    Shuttle.Test.Env.start_scoped!({Shuttle.StoreSync, name: nil})
    Shuttle.Test.Env.start_scoped!({BoundaryPoller, []}, Shuttle.Poller)
    task = Task.async(fn -> Shuttle.Poller.sync_missing_stores(["/store"]) end)
    assert_receive {:at_sync_boundary, boundary}
    refute_receive {:sync_started, _, _, _}
    send(boundary, :continue)
    assert_receive {:sync_started, worker, "/store", :infinity}
    send(worker, {:finish, {"pulled", 0}})
    assert [] = Task.await(task)
  end

  test "concurrent misses share a bounded pull and cache failures across identifiers" do
    Shuttle.Test.Env.put_app_env(:felt_runner, Runner)
    Shuttle.Test.Env.put_app_env(:sync_test_owner, self())
    Shuttle.Test.Env.start_scoped!({Shuttle.StoreSync, name: nil})
    first = Task.async(fn -> Shuttle.StoreSync.sync(["/store"]) end)
    assert_receive {:sync_started, worker, "/store", :infinity}
    second = Task.async(fn -> Shuttle.StoreSync.sync(["/store"]) end)
    send(worker, {:finish, {"network unavailable", 1}})
    assert [{"/store", {:command_error, 1, "network unavailable"}}] = Task.await(first)
    assert [{"/store", {:command_error, 1, "network unavailable"}}] = Task.await(second)

    assert [{"/store", {:command_error, 1, "network unavailable"}}] =
             Shuttle.StoreSync.sync(["/store"])

    refute_receive {:sync_started, _, _, _}
    # Another store has an independent recovery attempt.
    other = Task.async(fn -> Shuttle.StoreSync.sync(["/other-store"]) end)
    assert_receive {:sync_started, worker, "/other-store", :infinity}
    send(worker, {:finish, {"pulled", 0}})
    assert [] = Task.await(other)
  end
end
