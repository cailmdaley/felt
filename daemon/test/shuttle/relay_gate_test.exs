defmodule Shuttle.RelayGateTest do
  use ExUnit.Case, async: true
  alias Shuttle.RelayGate

  setup do
    %{gate: start_supervised!({RelayGate, name: nil, cooldown_ms: 80})}
  end

  test "four admissions per URL, no waiters, independent URLs", %{gate: gate} do
    deadline = now() + 2_000
    tokens = for _ <- 1..4, do: make_ref()
    for token <- tokens, do: assert(:ok == RelayGate.acquire(gate, "url-a", token, deadline))
    started = now()
    assert {:error, :relay_busy} = RelayGate.acquire(gate, "url-a", make_ref(), deadline)
    assert now() - started < 100
    assert :ok = RelayGate.acquire(gate, "url-b", make_ref(), deadline)
    assert map_size(:sys.get_state(gate).leases) == 5
    [first | _] = tokens
    RelayGate.finish(gate, first, {:ok, 200, "ok"})
    assert :ok = RelayGate.acquire(gate, "url-a", make_ref(), deadline)
  end

  test "failures cool down, HTTP responses clear, expiry recovers, URL edits bypass", %{
    gate: gate
  } do
    first = make_ref()
    in_flight = make_ref()
    assert :ok = RelayGate.acquire(gate, "url", first, now() + 2_000)
    assert :ok = RelayGate.acquire(gate, "url", in_flight, now() + 2_000)
    RelayGate.finish(gate, first, {:error, :timeout})
    assert {:error, :relay_cooldown} = RelayGate.acquire(gate, "url", make_ref(), now() + 2_000)
    assert :ok = RelayGate.acquire(gate, "new-url", make_ref(), now() + 2_000)
    RelayGate.finish(gate, in_flight, {:ok, 503, "busy"})
    next = make_ref()
    assert :ok = RelayGate.acquire(gate, "url", next, now() + 2_000)
    RelayGate.finish(gate, next, {:error, :econnrefused})
    assert {:error, :relay_cooldown} = RelayGate.acquire(gate, "url", make_ref(), now() + 2_000)
    Process.sleep(100)
    assert :ok = RelayGate.acquire(gate, "url", make_ref(), now() + 2_000)
    assert :sys.get_state(gate).failures == %{}
  end

  test "owner death releases a slot and kills its transport worker", %{gate: gate} do
    parent = self()

    owner =
      spawn(fn ->
        token = make_ref()
        :ok = RelayGate.acquire(gate, "url", token, now() + 2_000)
        worker = spawn(fn -> Process.sleep(:infinity) end)
        :ok = RelayGate.attach_worker(gate, token, worker)
        send(parent, {:armed, worker})
        Process.sleep(:infinity)
      end)

    assert_receive {:armed, worker}
    monitor = Process.monitor(worker)
    Process.exit(owner, :kill)
    assert_receive {:DOWN, ^monitor, :process, ^worker, :killed}
    assert :sys.get_state(gate).counts == %{}
    assert :sys.get_state(gate).leases == %{}
  end

  test "deadline kills work but retains admission until the owner finishes", %{gate: gate} do
    token = make_ref()
    :ok = RelayGate.acquire(gate, "url", token, now() + 30)
    worker = spawn(fn -> Process.sleep(:infinity) end)
    monitor = Process.monitor(worker)
    :ok = RelayGate.attach_worker(gate, token, worker)
    assert_receive {:DOWN, ^monitor, :process, ^worker, :killed}
    assert :sys.get_state(gate).counts == %{"url" => 1}
    assert {:error, :timeout} = RelayGate.attach_worker(gate, token, spawn(fn -> :ok end))
    RelayGate.finish(gate, token, {:error, :timeout})
    assert :sys.get_state(gate).counts == %{}
  end

  test "stalled admission fails within 100ms and releases any late lease", %{gate: gate} do
    :ok = :sys.suspend(gate)
    token = make_ref()
    assert {:error, :relay_unavailable} = RelayGate.acquire(gate, "url", token, now() + 1_000)
    RelayGate.finish(gate, token, :abandoned)
    :ok = :sys.resume(gate)
    assert :sys.get_state(gate).leases == %{}
  end

  defp now, do: System.monotonic_time(:millisecond)
end
