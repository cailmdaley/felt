defmodule Shuttle.DispatchIntegrationInboxRollForwardTest do
  # A message to a live worker whose owner dies while waking it, from the
  # outside: the real `shuttle message` reaches this test's daemon over HTTP,
  # the daemon claims the message for the worker's conversation and sends it
  # to the worker's native messaging socket, and dies, with the command
  # sending it, before the worker answers. The worker's conversation then
  # ends with it unanswered. The claim outlives the death; since nobody knows
  # whether the ended conversation read the message, the next daemon carries
  # it forward to the conversation that replaces it, once, marked as a
  # possible repeat.
  use Shuttle.Test.DispatchIntegrationCase, async: true

  # Kills, as a hard kill of the daemon's process group would, every OS
  # process whose command line contains `fragment`; answers their pids.
  defp kill_commands!(fragment) do
    {ps, 0} = System.cmd("ps", ["-axo", "pid=,command="])

    for line <- String.split(ps, "\n", trim: true),
        [pid, command] = String.split(String.trim(line), " ", parts: 2),
        String.contains?(command, fragment) do
      {_, 0} = System.cmd("kill", ["-9", pid])
      pid
    end
  end

  test "a message its owner died waking a worker with is carried to the next conversation once, marked",
       %{host: host} do
    id = armed(host, "tests/roll-forward")
    serve_api!(host)
    TransportRunner.start!(self())
    poller = poller!(host, runner: TransportRunner)
    assert {200, _} = post_api("/api/v1/dispatch", %{"fiber_id" => id, "force" => true})
    %{session_uuid: first} = Poller.live_worker(poller, id)
    transcript = Path.join(host, "first.jsonl")
    File.write!(transcript, "")
    socket = native_socket!(first, transcript, :hold)

    harness =
      start_harness!([
        {"CLAUDE_CODE_MESSAGING_SOCKET", socket},
        {"SHUTTLE_BOARD", "off"},
        {"SHUTTLE_EVENTS", "off"}
      ])

    harness_hook!(harness, first, "SessionStart", %{transcript_path: transcript})
    test = self()

    send = fn ->
      shuttle([
        "message",
        id,
        "check the fit",
        "--message-id",
        "m-pinned",
        "--from",
        "life/vizier"
      ])
    end

    # The owner wakes the worker with the message and dies with the frame
    # unanswered: its request, its work and the command sending the frame
    # die with it. The sender is not told it arrived.
    spawn(fn ->
      Shuttle.Env.adopt_callers([test])
      send(test, {:sent, send.()})
    end)

    assert_receive {:native_frame, receiver, frame}
    assert frame["message"]["content"] =~ "check the fit"
    kill_daemon!(poller)
    assert [_ | _] = kill_commands!("inbox consume fiber:")
    send(receiver, {:fate, :drop})
    assert_receive {:sent, {_, status}} when status != 0, 60_000
    assert [%{"id" => "m-pinned", "attempt" => %{"conversation" => conversation}}] = inbox(id)
    assert conversation =~ first

    # The worker's conversation ends: its terminal, its process and its
    # socket are gone.
    Port.close(harness)
    File.rm!(socket)
    Enum.each(IntegrationRunner.tmux_sessions(), &IntegrationRunner.remove_tmux_session/1)

    # The next daemon starts a conversation to replace it, and wakes it with
    # the message, once, marked as a possible repeat.
    poller = restart!(host, runner: TransportRunner)
    release!(poller)
    assert launches(id) == 2
    %{session_uuid: next} = Poller.live_worker(poller, id)
    assert next != first
    session = claude_session!(next)
    refute harness_hook!(session, next, "UserPromptSubmit") =~ "check the fit"
    poll!(poller)
    assert_receive {:wake, woken}
    assert woken =~ "Possible repeat"
    assert woken =~ "check the fit"
    assert inbox(id) == []
    poll!(poller)
    refute harness_hook!(session, next, "UserPromptSubmit") =~ "check the fit"
    refute_receive {:wake, _}
    assert launches(id) == 2
  end
end
