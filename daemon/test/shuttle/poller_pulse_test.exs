defmodule Shuttle.PollerPulseTest do
  use ExUnit.Case, async: true
  import Shuttle.Test.PollerHelpers
  alias Shuttle.{Poller, Pulse}
  alias Shuttle.Test.{Env, FeltStoreRunner}

  setup do
    FeltStoreRunner.start!()

    FeltStoreRunner.set_shuttle("watch", """
    kind: oneshot
    agent: claude-sonnet
    pulse: 1m
    resolved:
      pulse_interval_ms: 60000
    """)

    parent = self()
    phase = start_supervised!({Agent, fn -> %{} end})

    Env.put_app_env(:waiting_phases_source, fn ->
      Agent.get(phase, & &1)
    end)

    Env.put_app_env(:pulse_sender, fn payload ->
      send(parent, {:pulse_sent, self(), payload})

      receive do
        :finish -> {:ok, 200, %{"status" => "accepted"}}
        :reject -> {:ok, 409, %{"status" => "rejected"}}
        :crash -> exit(:pulse_test_crash)
      end
    end)

    {:ok, poller} =
      start_poller!(
        runner: FeltStoreRunner,
        felt_stores: [FeltStoreRunner.felt_root()],
        poll_interval_ms: 60_000,
        heartbeat_interval_ms: 60_000
      )

    await_boot_cycle!(poller)

    [worker] = Map.values(:sys.get_state(poller).running)
    uuid = worker.session_uuid
    Agent.update(phase, fn _ -> %{uuid => %{last_event_at: 0, phase: "waiting"}} end)
    %{poller: poller, phase: phase, uuid: uuid}
  end

  defp due(poller) do
    :sys.replace_state(poller, fn state ->
      [key] = Map.keys(state.pulses)
      put_in(state.pulses[key]["next_tick"], "2026-01-01T00:00:00Z")
    end)
  end

  defp cycle(poller) do
    before = :sys.get_state(poller).poll_cycles
    send(poller, :run_poll_cycle)

    await(fn ->
      state = :sys.get_state(poller)
      state.poll_cycles > before and not state.poll_check_in_progress
    end)
  end

  defp windowed(uuid) do
    yesterday = DateTime.utc_now() |> DateTime.add(-86400) |> DateTime.to_iso8601()

    FeltStoreRunner.set_shuttle("watch", """
    kind: oneshot
    agent: claude-sonnet
    pulse:
      every: 1m
      window: {start: "00:00", end: "23:59", tz: Etc/UTC}
    resolved:
      pulse_interval_ms: 60000
    runtime:
      session_uuid: #{uuid}
      dispatched_at: #{yesterday}
    """)
  end

  defp await(fun, attempts \\ 3000)

  defp await(fun, attempts) when attempts > 0 do
    if fun.(),
      do: :ok,
      else:
        (receive do
         after
           5 -> await(fun, attempts - 1)
         end)
  end

  defp await(_fun, 0), do: flunk("Poller did not reach the expected state")

  test "a live pulse persists before send, stays in its conversation and never stacks", %{
    poller: poller,
    uuid: uuid,
    phase: phase
  } do
    due(poller)
    before = File.read!(FeltStoreRunner.fiber("watch")["path"])
    cycle(poller)
    assert_receive {:pulse_sent, task, payload}, 5000
    assert payload["address"] == "shuttle://local/claude/#{uuid}"
    assert payload["idle_only"] == true
    assert payload["text"] =~ "Previous pulse: none (first pulse)"
    assert [%{"last_tick" => nil} = row] = Map.values(Pulse.load())
    refute Pulse.due?(row, DateTime.utc_now())
    due(poller)
    cycle(poller)
    refute_receive {:pulse_sent, _, _}
    send(task, :finish)
    await(fn -> :sys.get_state(poller).pulse_jobs == %{} end)
    assert [%{"last_tick" => tick}] = Map.values(Pulse.load())
    assert is_binary(tick)
    assert [pending] = Map.values(Pulse.load())
    assert pending["state"] == "sending"
    due(poller)
    cycle(poller)
    refute_receive {:pulse_sent, _, _}

    Agent.update(phase, fn _ ->
      %{uuid => %{phase: "waiting", last_event_at: System.system_time(:millisecond) + 1}}
    end)

    cycle(poller)
    assert [released] = Map.values(Pulse.load())
    assert released["state"] == "scheduled"
    refute Pulse.due?(released, DateTime.utc_now())
    assert File.read!(FeltStoreRunner.fiber("watch")["path"]) == before
    assert FeltStoreRunner.fiber("watch")["status"] == "active"

    assert {:ok, %{fibers: [%{pulse: %{"last_tick" => ^tick}}]}} =
             Poller.cached_fiber_documents(poller)
  end

  test "busy turns skip a deadline, pause stops ticks and quarantine holds", %{
    poller: poller,
    phase: phase,
    uuid: uuid
  } do
    Agent.update(phase, fn _ -> %{uuid => %{phase: "working", last_event_at: 0}} end)
    due(poller)
    cycle(poller)
    refute_receive {:pulse_sent, _, _}
    assert [row] = Map.values(:sys.get_state(poller).pulses)
    refute Pulse.due?(row, DateTime.utc_now())
    assert row["last_tick"] == nil
    Agent.update(phase, fn _ -> %{uuid => %{phase: "waiting", last_event_at: 0}} end)
    :sys.replace_state(poller, &%{&1 | boot_quarantine: true})
    due(poller)
    cycle(poller)
    refute_receive {:pulse_sent, _, _}

    await(fn ->
      match?([%{"state" => "held", "next_tick" => nil}], Poller.snapshot(poller).pulses)
    end)

    FeltStoreRunner.set_fiber("watch", Map.put(FeltStoreRunner.fiber("watch"), "status", "open"))
    :sys.replace_state(poller, &%{&1 | boot_quarantine: false})
    cycle(poller)
    refute_receive {:pulse_sent, _, _}

    await(fn ->
      match?([%{"state" => "paused", "next_tick" => nil}], Poller.snapshot(poller).pulses)
    end)
  end

  test "a sender crash consumes its deadline and releases the single-flight slot", %{
    poller: poller
  } do
    due(poller)
    cycle(poller)
    assert_receive {:pulse_sent, task, _}, 5000
    send(task, :crash)
    await(fn -> :sys.get_state(poller).pulse_jobs == %{} end)
    cycle(poller)
    refute_receive {:pulse_sent, _, _}
    assert [%{"last_tick" => nil} = row] = Map.values(Pulse.load())
    refute Pulse.due?(row, DateTime.utc_now())
  end

  test "a window opening waits for idle then starts a fresh session without waking the old one",
       %{
         poller: poller,
         phase: phase,
         uuid: uuid
       } do
    windowed(uuid)

    Agent.update(phase, fn _ -> %{uuid => %{phase: "working", last_event_at: 0}} end)
    cycle(poller)
    due(poller)
    cycle(poller)
    assert [%{session_uuid: ^uuid}] = Map.values(:sys.get_state(poller).running)
    assert [row] = Map.values(:sys.get_state(poller).pulses)
    assert Pulse.due?(row, DateTime.utc_now())
    refute_receive {:pulse_sent, _, _}

    Agent.update(phase, fn _ -> %{uuid => %{phase: "waiting", last_event_at: 0}} end)
    cycle(poller)
    assert [worker] = Map.values(:sys.get_state(poller).running)
    refute worker.session_uuid == uuid
    refute_receive {:pulse_sent, _, _}
    assert [row] = Map.values(Pulse.load())
    refute Pulse.due?(row, DateTime.utc_now())
    assert is_binary(row["last_tick"])
    cycle(poller)
    assert [%{session_uuid: fresh}] = Map.values(:sys.get_state(poller).running)
    assert fresh == worker.session_uuid
  end

  test "a failed window teardown preserves the old worker and retries when it can stop", %{
    poller: poller,
    uuid: uuid
  } do
    windowed(uuid)
    cycle(poller)
    FeltStoreRunner.set_kill_session_failure(true)
    due(poller)
    cycle(poller)
    assert [%{session_uuid: ^uuid}] = Map.values(:sys.get_state(poller).running)
    refute_receive {:pulse_sent, _, _}
    FeltStoreRunner.set_kill_session_failure(false)
    cycle(poller)
    assert [worker] = Map.values(:sys.get_state(poller).running)
    refute worker.session_uuid == uuid
  end

  test "an exited session starts fresh at the next window's tick", %{poller: poller, uuid: uuid} do
    windowed(uuid)
    cycle(poller)
    [worker] = Map.values(:sys.get_state(poller).running)
    FeltStoreRunner.remove_tmux_session(worker.session)
    due(poller)
    cycle(poller)
    assert [fresh] = Map.values(:sys.get_state(poller).running)
    refute fresh.session_uuid == uuid
    refute_receive {:pulse_sent, _, _}
  end

  test "a known rejection releases the reservation without retrying the consumed deadline", %{
    poller: poller
  } do
    due(poller)
    cycle(poller)
    assert_receive {:pulse_sent, task, _}, 5000
    send(task, :reject)
    await(fn -> :sys.get_state(poller).pulse_jobs == %{} end)
    assert [row] = Map.values(Pulse.load())
    assert row["state"] == "scheduled"
    assert row["pending"] == nil
    assert row["last_tick"] == nil
    refute Pulse.due?(row, DateTime.utc_now())
  end
end
