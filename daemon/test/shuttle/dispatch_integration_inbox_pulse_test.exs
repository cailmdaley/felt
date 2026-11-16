defmodule Shuttle.DispatchIntegrationInboxPulseTest do
  # A pulse tick from the outside: the daemon's own poll over a constitution
  # with a `pulse:`, and what reaches its idle Claude worker's native
  # messaging socket, registered by the worker's real hooks. The inbox
  # promises a tick at most once: a tick its daemon died sending is never sent
  # again, while the next one is.
  #
  # Staged, not driven: the pulse interval's floor is a minute with no knob,
  # so `make_tick_due!/0` moves the clock the daemon persists into the past
  # while no daemon runs; and the worker's turn state comes from the
  # `:waiting_phases_source` seam, since the suite runs no event stream.
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

  # The session's native messaging socket. Each frame Claude Code would
  # receive is sent to the test, which answers its fate: `:answer` takes it
  # as Claude Code does (into the transcript), `:drop` never answers.
  defp native_socket!(uuid, transcript) do
    dir = Path.join(System.tmp_dir!(), "pn-#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)
    File.chmod!(dir, 0o700)
    socket = Path.join(dir, "s")

    {:ok, listener} =
      :gen_tcp.listen(0, [:binary, active: false, packet: :line, ifaddr: {:local, socket}])

    File.chmod!(socket, 0o600)
    test = self()
    start_supervised!({Task, fn -> receive_frames(listener, uuid, transcript, test) end})

    on_exit(fn ->
      :gen_tcp.close(listener)
      File.rm_rf(dir)
    end)

    socket
  end

  defp receive_frames(listener, uuid, transcript, test) do
    with {:ok, conn} <- :gen_tcp.accept(listener) do
      with {:ok, line} <- :gen_tcp.recv(conn, 0, 10_000) do
        frame = Jason.decode!(line)
        send(test, {:native_frame, self(), frame})

        receive do
          {:fate, :answer} ->
            rows = [
              %{type: "user", sessionId: uuid, uuid: frame["uuid"]},
              %{
                type: "assistant",
                sessionId: uuid,
                uuid: "reply-" <> frame["uuid"],
                parentUuid: frame["uuid"],
                message: %{role: "assistant", model: "claude-test"}
              }
            ]

            File.write!(transcript, Enum.map(rows, &(Jason.encode!(&1) <> "\n")), [:append])

          {:fate, :drop} ->
            :ok
        end
      end

      :gen_tcp.close(conn)
      receive_frames(listener, uuid, transcript, test)
    end
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

  test "a tick its daemon died sending is never sent again, and the next one is", %{host: host} do
    id = oneshot(host, "tests/pulse", "active", "")
    path = fiber_file(host, id)

    File.write!(
      path,
      String.replace(File.read!(path), "  kind: oneshot", "  kind: oneshot\n  pulse: 1m")
    )

    serve_api!(host)
    TransportRunner.start!(self())

    # The first daemon starts the worker and its pulse clock.
    poller = daemon!(host)

    assert eventually(fn ->
             match?(%{session_uuid: u} when is_binary(u), Poller.live_worker(poller, id))
           end)

    %{session_uuid: uuid} = Poller.live_worker(poller, id)
    transcript = Path.join(host, "native.jsonl")
    File.write!(transcript, "")
    socket = native_socket!(uuid, transcript)
    harness = start_harness!([{"CLAUDE_CODE_MESSAGING_SOCKET", socket}])
    harness_hook!(harness, uuid, "SessionStart", %{transcript_path: transcript})
    harness_hook!(harness, uuid, "Stop", %{transcript_path: transcript})

    Shuttle.Test.Env.put_app_env(:waiting_phases_source, fn ->
      %{uuid => %{phase: "waiting", last_event_at: System.system_time(:millisecond)}}
    end)

    kill_daemon!(poller)

    # A tick is due; the next daemon sends it and dies before it is known to
    # have arrived.
    make_tick_due!()
    poller = daemon!(host)
    sync_poll_cycle!(poller)
    assert_receive {:native_frame, receiver, lost}
    assert lost["message"]["content"] =~ "Shuttle pulse."
    kill_daemon!(poller, [], work: true)
    send(receiver, {:fate, :drop})

    # The daemon after it never sends that tick again.
    poller = daemon!(host)
    for _ <- 1..3, do: poll!(poller)
    refute_receive {:native_frame, _, _}
    kill_daemon!(poller)

    # The next tick is sent, under its own identity, and taken.
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
