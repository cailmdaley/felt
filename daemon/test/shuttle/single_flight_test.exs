defmodule Shuttle.SingleFlightTest do
  use ExUnit.Case, async: true

  alias Shuttle.SingleFlight

  test "concurrent callers with one key share a single execution" do
    key = {:test, make_ref()}
    runs = :counters.new(1, [])
    test = self()

    fun = fn ->
      :counters.add(runs, 1, 1)
      send(test, {:running, self()})

      receive do
        :release -> :answer
      end
    end

    first = Task.async(fn -> SingleFlight.run(key, fun) end)
    assert_receive {:running, worker}

    waiters = for _ <- 1..5, do: Task.async(fn -> SingleFlight.run(key, fun) end)
    wait_for_waiters(key, 6)
    send(worker, :release)

    assert Enum.map([first | waiters], &Task.await/1) == List.duplicate(:answer, 6)
    assert :counters.get(runs, 1) == 1
  end

  test "a finished run is not reused" do
    key = {:test, make_ref()}
    runs = :counters.new(1, [])
    fun = fn -> :counters.add(runs, 1, 1) end

    SingleFlight.run(key, fun)
    SingleFlight.run(key, fun)

    assert :counters.get(runs, 1) == 2
  end

  test "a crashed run exits every waiter with its reason" do
    key = {:test, make_ref()}
    test = self()

    fun = fn ->
      send(test, {:running, self()})

      receive do
        :release -> exit(:boom)
      end
    end

    tasks =
      for _ <- 1..3 do
        Task.async(fn -> catch_exit(SingleFlight.run(key, fun)) end)
      end

    assert_receive {:running, worker}
    wait_for_waiters(key, 3)
    send(worker, :release)

    assert Enum.map(tasks, &Task.await/1) == [:boom, :boom, :boom]
  end

  defp wait_for_waiters(key, count) do
    %{flights: flights} = :sys.get_state(SingleFlight)

    case flights do
      %{^key => {_worker, waiters}} when length(waiters) == count ->
        :ok

      _ ->
        Process.sleep(5)
        wait_for_waiters(key, count)
    end
  end
end
