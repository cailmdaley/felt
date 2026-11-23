defmodule Shuttle.DispatchIntegrationInboxPulseTest do
  # A pulse tick from the outside: the daemon's own poll over a constitution
  # with a `pulse:`, and what reaches its idle Claude worker's native
  # messaging socket, registered by the worker's real hooks. A tick is sent at
  # most once. What guards that across a death is the pulse clock: the daemon
  # moves it past a tick and persists it before sending, so a tick whose
  # daemon died sending it is never due again. The tick in flight then keeps
  # the fiber's pulse reserved until the worker is next seen idle, or for one
  # pulse interval when it never is, after which the next tick goes out.
  #
  # Staged, not driven: the pulse interval's floor is a minute with no knob,
  # so `make_tick_due!/0` and `age_reservation!/2` move the clock the daemon
  # persists into the past while no daemon runs; and the worker's turn state
  # comes from the `:waiting_phases_source` seam, since the suite runs no
  # event stream. Each idle event the seam reports is one the worker's hooks
  # reported.
  use Shuttle.Test.DispatchIntegrationCase, async: true

  defp stage_pulses!(fun) do
    path = Path.join(Shuttle.Env.get("SHUTTLE_DATA_DIR"), "pulses.json")
    pulses = path |> File.read!() |> Jason.decode!() |> Map.new(fn {k, row} -> {k, fun.(row)} end)
    File.write!(path, Jason.encode!(pulses))
  end

  # Staged: the next tick of every pulse in this daemon's clock is due.
  defp make_tick_due! do
    past = DateTime.utc_now() |> DateTime.add(-5, :second) |> DateTime.to_iso8601()
    stage_pulses!(&Map.put(&1, "next_tick", past))
  end

  # Staged: everything so far happened one pulse interval (1m) earlier: every
  # reserved tick's send and the worker's last idle event, `idle_at`.
  defp age_reservation!(uuid, idle_at) do
    stage_pulses!(fn row ->
      assert %{"at" => at} = row["pending"]
      assert at > idle_at
      put_in(row, ["pending", "at"], at - 60_000)
    end)

    idle_at = idle_at - 60_000

    Shuttle.Test.Env.put_app_env(:waiting_phases_source, fn ->
      %{uuid => %{phase: "waiting", last_event_at: idle_at, since: idle_at}}
    end)
  end

  # Staged: the worker `uuid` ended a turn, and is idle, now.
  defp idle!(harness, uuid, transcript) do
    harness_hook!(harness, uuid, "Stop", %{transcript_path: transcript})
    at = System.system_time(:millisecond)

    Shuttle.Test.Env.put_app_env(:waiting_phases_source, fn ->
      %{uuid => %{phase: "waiting", last_event_at: at, since: at}}
    end)

    at
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

  # A 1m-pulse worker ends its first turn, idle; a tick falls due, and its
  # daemon dies sending it, so the worker never receives it. No daemon runs
  # on return.
  defp lose_a_tick!(host) do
    id = oneshot(host, "tests/pulse", "active", "")
    path = fiber_file(host, id)

    File.write!(
      path,
      String.replace(File.read!(path), "  kind: oneshot", "  kind: oneshot\n  pulse: 1m")
    )

    serve_api!(host)
    TransportRunner.start!(self())

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
    idle_at = idle!(harness, uuid, transcript)
    kill_daemon!(poller)

    make_tick_due!()
    poller = daemon!(host)
    sync_poll_cycle!(poller)
    assert_receive {:native_frame, receiver, lost}
    assert lost["message"]["content"] =~ "Shuttle pulse."
    kill_daemon!(poller, [], work: true)
    send(receiver, {:fate, :drop})

    %{harness: harness, uuid: uuid, transcript: transcript, lost: lost, idle_at: idle_at}
  end

  test "a tick lost in its daemon's death is never due again; the next goes out once the worker is idle",
       %{host: host} do
    %{harness: harness, uuid: uuid, transcript: transcript, lost: lost} = lose_a_tick!(host)

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

  test "a lost tick to a worker never seen idle again expires after one interval; the next goes out",
       %{host: host} do
    %{uuid: uuid, idle_at: idle_at, lost: lost} = lose_a_tick!(host)

    # Within the interval the reservation holds, even with a tick due.
    make_tick_due!()
    poller = daemon!(host)
    for _ <- 1..2, do: poll!(poller)
    refute_receive {:native_frame, _, _}
    kill_daemon!(poller)

    # A full interval after the lost send, with no idle event since, the
    # reservation lapses and the clock moves one interval on.
    age_reservation!(uuid, idle_at)
    poller = daemon!(host)
    poll!(poller)
    refute_receive {:native_frame, _, _}
    kill_daemon!(poller)

    make_tick_due!()
    poller = daemon!(host)
    sync_poll_cycle!(poller)
    assert_receive {:native_frame, receiver, next}
    assert next["message"]["content"] =~ "Shuttle pulse."
    assert next["uuid"] != lost["uuid"]
    send(receiver, {:fate, :answer})
    drain!(poller)
  end
end
