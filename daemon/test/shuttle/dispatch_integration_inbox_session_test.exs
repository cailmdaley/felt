defmodule Shuttle.DispatchIntegrationInboxSessionTest do
  # A message to a session address, which names no fiber, from the outside:
  # the real `shuttle message shuttle://…` sends it to this test's daemon over
  # HTTP, and a Claude session registered by its real hooks receives it on its
  # native messaging socket or from its hook. Session messages keep their
  # direct transport and receipts: a repeated message id is never delivered
  # twice, and context queued for the session before its daemon dies is
  # offered once by the session's hook.
  use Shuttle.Test.DispatchIntegrationCase, async: true

  alias Shuttle.Test.ThreadsCase

  test "a session message is sent directly with its receipt and never twice under one id",
       %{host: host} do
    serve_api!(host)
    poller = poller!(host)

    uuid =
      "5e55e55e-0000-4000-8000-#{System.unique_integer([:positive]) |> Integer.to_string() |> String.pad_leading(12, "0")}"

    address = "shuttle://test-host/claude/#{uuid}"

    # The session's native messaging socket, answered as Claude Code answers
    # it: the message is written to the session's transcript.
    dir = Path.join(System.tmp_dir!(), "sn-#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)
    File.chmod!(dir, 0o700)
    socket = Path.join(dir, "s")
    transcript = Path.join(host, "native.jsonl")
    ready = Path.join(host, "ready")
    File.write!(transcript, "")
    File.write!(ready, uuid)

    {:ok, listener} =
      :gen_tcp.listen(0, [:binary, active: false, packet: :line, ifaddr: {:local, socket}])

    File.chmod!(socket, 0o600)
    test = self()

    start_supervised!(
      {Task, fn -> ThreadsCase.native_receiver(listener, transcript, ready, test) end}
    )

    on_exit(fn ->
      :gen_tcp.close(listener)
      File.rm_rf(dir)
    end)

    harness = start_harness!([{"CLAUDE_CODE_MESSAGING_SOCKET", socket}])
    harness_hook!(harness, uuid, "SessionStart", %{transcript_path: transcript})

    send = fn message_id, text, flags ->
      shuttle(
        ["message", address, text, "--message-id", message_id, "--from", "life/vizier"] ++
          flags
      )
    end

    # Idle: sent directly, with an accepted receipt.
    assert {out, 0} = send.("s-direct", "hello there", [])
    assert out =~ "accepted #{address} (s-direct)"
    assert_receive {:wake, woken}
    assert woken =~ "hello there"

    # A repeated id answers its receipt and sends nothing.
    assert {out, 0} = send.("s-direct", "hello there", [])
    assert out =~ "s-direct"
    refute_receive {:wake, _}

    # Context waits in the session's inbox for its next hook. Its daemon dies
    # before any hook runs.
    assert {out, 0} = send.("s-context", "read this next", ["--context-only"])
    assert out =~ "queued #{address} (s-context)"
    kill_daemon!(poller)
    poller = restart!(host)

    # The session's next hook is offered it once, and nothing sends it again:
    # not later hooks, polls, or a retry of its id.
    assert harness_hook!(harness, uuid, "UserPromptSubmit") =~ "read this next"
    refute harness_hook!(harness, uuid, "PostToolUse") =~ "read this next"
    assert {_, 0} = send.("s-context", "read this next", ["--context-only"])
    poll!(poller)
    refute harness_hook!(harness, uuid, "PostToolUse") =~ "read this next"
    refute_receive {:wake, _}
  end
end
