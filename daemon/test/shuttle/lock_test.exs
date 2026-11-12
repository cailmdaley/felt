defmodule Shuttle.LockTest do
  use ExUnit.Case, async: true

  alias Shuttle.Lock

  defp key, do: {__MODULE__, make_ref()}

  # A process that takes `key`, reports holding it, and keeps it until told.
  defp holder(key, label) do
    test = self()

    spawn(fn ->
      Lock.transaction(key, fn ->
        send(test, {:holding, label})

        receive do
          :release -> :ok
        end
      end)

      send(test, {:released, label})
    end)
  end

  test "waiters run in arrival order as soon as the holder releases" do
    key = key()
    first = holder(key, :first)
    assert_receive {:holding, :first}

    second = holder(key, :second)
    await_waiters(key, 1)
    third = holder(key, :third)
    await_waiters(key, 2)
    refute_received {:holding, _}

    send(first, :release)
    assert_receive {:holding, :second}
    refute_received {:holding, :third}
    send(second, :release)
    assert_receive {:holding, :third}
    send(third, :release)
    assert_receive {:released, :third}
    refute Map.has_key?(:sys.get_state(Lock).keys, key)
  end

  test "a holder that exits releases its key, and an exited waiter leaves the queue" do
    key = key()
    first = holder(key, :first)
    assert_receive {:holding, :first}
    gone = holder(key, :gone)
    await_waiters(key, 1)
    next = holder(key, :next)
    await_waiters(key, 2)

    Process.exit(gone, :kill)
    await_waiters(key, 1)
    Process.exit(first, :kill)
    assert_receive {:holding, :next}
    refute_received {:holding, :gone}
    send(next, :release)
    assert_receive {:released, :next}
  end

  test "a holder may take its key again" do
    key = key()
    assert Lock.transaction(key, fn -> Lock.transaction(key, fn -> :inner end) end) == :inner
    refute Map.has_key?(:sys.get_state(Lock).keys, key)
  end

  test "a raising transaction releases its key" do
    key = key()
    assert_raise RuntimeError, fn -> Lock.transaction(key, fn -> raise "boom" end) end
    refute Map.has_key?(:sys.get_state(Lock).keys, key)
  end

  # Until `count` processes queue behind the holder; the test's timeout bounds it.
  defp await_waiters(key, count) do
    with %{^key => {_holder, waiters}} <- :sys.get_state(Lock).keys,
         ^count <- :queue.len(waiters) do
      :ok
    else
      _ ->
        Process.sleep(1)
        await_waiters(key, count)
    end
  end
end
