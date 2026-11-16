defmodule Shuttle.DispatchIntegrationInboxPulseTest do
  # A pulse tick from the outside: the daemon's own poll over a constitution
  # with a `pulse:`, and what reaches its idle Claude worker's native
  # messaging socket, registered by the worker's real hooks. A tick is sent at
  # most once. What guards that across a death is the pulse clock: the daemon
  # moves it past a tick and persists it before sending, so a tick whose
  # daemon died sending it is never due again. The tick in flight then keeps
  # the fiber's pulse reserved until the worker is next seen idle, after which
  # the next tick goes out.
  #
  # Staged, not driven: the pulse interval's floor is a minute with no knob,
  # so `make_tick_due!/0` moves the clock the daemon persists into the past
  # while no daemon runs; and the worker's turn state comes from the
  # `:waiting_phases_source` seam, since the suite runs no event stream. Each
  # idle event the seam reports is one the worker's hooks reported.
  use Shuttle.Test.DispatchIntegrationCase, async: true

  # Staged: the next tick of every pulse in this daemon's clock is due.
  defp make_tick_due! do
    path = Path.join(Shuttle.Env.get("SHUTTLE_DATA_DIR"), "pulses.json")
    past = DateTime.utc_now() |> DateTime.add(-5, :second) |> DateTime.to_iso8601()

    pulses =
      path
      |> File.read!()
      |> Jason.decode!()
      |> Map.new(fn {key, row} -> {key, Map.put(row, "next_tick", past)} end)

    File.write!(path, Jason.encode!(pulses))
  end

  # Staged: the worker `uuid` ended a turn, and is idle, now.
  defp idle!(harness, uuid, transcript) do
    harness_hook!(harness, uuid, "Stop", %{transcript_path: transcript})
    at = System.system_time(:millisecond)

    Shuttle.Test.Env.put_app_env(:waiting_phases_source, fn ->
      %{uuid => %{phase: "waiting", last_event_at: at}}
    end)
  end

  # A daemon over `host`, booted as every daemon boots, under the boot
  # quarantine, and released: a pulse waits for the release.
  defp daemon!(host) do
    {:ok, poller} =
      start_poller!(
        runner: TransportRunner,
        poll_interval_ms: 600_000,
        felt_stores: [host],
        boot_quarantine: true
      )

    await_boot_cycle!(poller)

    assert {200, %{"ok" => true}} = post_api("/api/v1/quarantine/release", %{})
    poller
  end

  test "a tick lost in its daemon's death is never due again; the next goes out once the worker is idle",
       %{host: host} do
    id = oneshot(host, "tests/pulse", "active", "")
    path = fiber_file(host, id)

    File.write!(
      path,
      String.replace(File.read!(path), "  kind: oneshot", "  kind: oneshot\n  pulse: 1m")
    )

    serve_api!(host)
    TransportRunner.start!(self())

    # The first daemon starts the worker and its pulse clock; the worker ends
    # its first turn.
    poller = daemon!(host)

    assert eventually(fn ->
             match?(%{session_uuid: u} when is_binary(u), Poller.live_worker(poller, id))
           end)

    %{session_uuid: uuid} = Poller.live_worker(poller, id)
    transcript = Path.join(host, "native.jsonl")
    File.write!(transcript, "")
    socket = native_socket!(uuid, transcript, :hold)
    harness = start_harness!([{"CLAUDE_CODE_MESSAGING_SOCKET", socket}])
    harness_hook!(harness, uuid, "SessionStart", %{transcript_path: transcript})
    idle!(harness, uuid, transcript)
    kill_daemon!(poller)

    # A tick is due; the next daemon sends it and dies sending it. The worker
    # never receives it.
    make_tick_due!()
    poller = daemon!(host)
    sync_poll_cycle!(poller)
    assert_receive {:native_frame, receiver, lost}
    assert lost["message"]["content"] =~ "Shuttle pulse."
    kill_daemon!(poller, [], work: true)
    send(receiver, {:fate, :drop})

    # The daemon after it never sends that tick again: its clock had already
    # moved on.
    poller = daemon!(host)
    for _ <- 1..3, do: poll!(poller)
    refute_receive {:native_frame, _, _}

    # The worker is next seen idle, which ends the lost tick's reservation;
    # the next tick is sent, under its own identity, and taken.
    idle!(harness, uuid, transcript)
    poll!(poller)
    kill_daemon!(poller)
    make_tick_due!()
    poller = daemon!(host)
    sync_poll_cycle!(poller)
    assert_receive {:native_frame, receiver, next}
    assert next["message"]["content"] =~ "Shuttle pulse."
    assert next["uuid"] != lost["uuid"]
    send(receiver, {:fate, :answer})
    drain!(poller)
    for _ <- 1..2, do: poll!(poller)
    refute_receive {:native_frame, _, _}
  end
end
