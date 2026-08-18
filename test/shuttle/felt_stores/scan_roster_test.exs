defmodule Shuttle.FeltStores.ScanRosterTest do
  @moduledoc """
  The claim has exactly one job: under a burst, one caller scans and the rest
  find out that somebody already is. Everything `Shuttle.FeltStores` does with a
  stalled store rests on that, because a claim that decides from a stale read
  multiplies probes into the filesystem that is not answering — and ten parked
  probes wedge every filesystem call in the VM.
  """
  use ExUnit.Case, async: false

  alias Shuttle.FeltStores.ScanRoster

  setup do
    on_exit(fn -> :ets.delete_all_objects(:shuttle_felt_store_scans) end)
    {:ok, base: ["/store/#{System.unique_integer([:positive])}"]}
  end

  test "exactly one of a simultaneous burst wins the claim", ctx do
    me = self()

    claimers =
      for _ <- 1..50 do
        Task.async(fn ->
          send(me, {:ready, self()})

          receive do
            :go -> :ok
          end

          result = ScanRoster.claim(ctx.base, self(), 3)
          send(me, {:claimed, result})

          # A claimer stays alive after winning, the way a scanner does: a claim
          # is released when its holder finishes or dies, so a process that
          # claims and immediately exits is correctly reclaimable by the next
          # caller — which would make this test measure the wrong thing.
          receive do
            :finish -> result
          end
        end)
      end

    # Released from a barrier: spawning fifty tasks takes long enough that a
    # broken claim could still look correct if each one ran to completion before
    # the next started.
    for _ <- claimers, do: assert_receive({:ready, _}, 2_000)
    for claimer <- claimers, do: send(claimer.pid, :go)

    results = for _ <- claimers, do: assert_receive({:claimed, r}, 5_000) && r
    for claimer <- claimers, do: send(claimer.pid, :finish)
    Task.await_many(claimers, 5_000)

    assert Enum.count(results, &(&1 == :ok)) == 1
    assert Enum.count(results, &(&1 == {:error, :in_flight})) == 49
  end

  test "a claim held by a dead process is not a claim", ctx do
    dead = spawn(fn -> :ok end)
    ref = Process.monitor(dead)
    assert_receive {:DOWN, ^ref, :process, ^dead, _}, 1_000

    :ets.insert(:shuttle_felt_store_scans, {ctx.base, dead, System.monotonic_time(:millisecond)})

    # Otherwise one brutally-killed scanner would wedge this store list forever,
    # which is worse than the stall it was scanning.
    assert ScanRoster.claim(ctx.base, self(), 3) == :ok
    assert {_base, holder, _started} = ScanRoster.find(ctx.base)
    assert holder == self()
  end

  test "the budget refuses a claim for a base nobody is scanning yet", ctx do
    parked =
      for i <- 1..3 do
        pid = spawn(fn -> Process.sleep(:infinity) end)
        on_exit(fn -> Process.exit(pid, :kill) end)
        assert ScanRoster.claim(["/other/#{i}"], pid, 99) == :ok
        pid
      end

    assert length(parked) == 3
    assert ScanRoster.claim(ctx.base, self(), 3) == {:error, :budget}

    # Refused means refused: the failed claim leaves nothing behind, or the next
    # caller would be told a scan is in flight that never started.
    assert ScanRoster.find(ctx.base) == nil
  end

  test "release frees the store list, and is idempotent", ctx do
    assert ScanRoster.claim(ctx.base, self(), 3) == :ok
    assert ScanRoster.claim(ctx.base, self(), 3) == {:error, :in_flight}
    assert ScanRoster.release(ctx.base) == :ok
    assert ScanRoster.release(ctx.base) == :ok
    assert ScanRoster.claim(ctx.base, self(), 3) == :ok
  end

  test "adopt hands the claim to the scanner without restarting its clock", ctx do
    assert ScanRoster.claim(ctx.base, self(), 3) == :ok
    {_base, _holder, started} = ScanRoster.find(ctx.base)

    scanner = spawn(fn -> Process.sleep(:infinity) end)
    on_exit(fn -> Process.exit(scanner, :kill) end)
    assert ScanRoster.adopt(ctx.base, scanner) == :ok

    assert {_base, ^scanner, ^started} = ScanRoster.find(ctx.base)

    # The overdue check reads that clock, so a scan whose claim changed hands
    # must not look younger than it is.
    assert ScanRoster.adopt(["/never/claimed"], scanner) == :ok
    assert ScanRoster.find(["/never/claimed"]) == nil
  end
end
