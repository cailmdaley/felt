defmodule Shuttle.DispatchIntegrationInboxSessionBusyTest do
  # A message that asks for a turn, sent to a Claude session in the middle of
  # its turn, from the outside: the real `shuttle message shuttle://…`, from a
  # sender with a session return address, reaches this test's daemon over
  # HTTP. It goes straight to the session's native messaging socket, which
  # queues it behind the running turn, once; the session's inbox holds
  # nothing for its hook, so no later hook, poll or retry delivers it again.
  use Shuttle.Test.DispatchIntegrationCase, async: true

  test "an ask to a busy Claude session is sent natively once and leaves its inbox empty",
       %{host: host} do
    serve_api!(host)
    poller = poller!(host)

    uuid = session_uuid()
    address = "shuttle://test-host/claude/#{uuid}"
    sender = "shuttle://test-host/claude/#{session_uuid()}"
    harness = claude_session!(uuid)

    # The session's turn is running.
    harness_hook!(harness, uuid, "UserPromptSubmit")

    send = fn ->
      shuttle(["message", address, "check the fit", "--message-id", "s-busy", "--from", sender])
    end

    assert {out, 0} = send.()
    assert out =~ "accepted #{address} (s-busy)"
    assert_receive {:wake, woken}
    assert woken =~ "check the fit"
    assert inbox(address) == []

    # Nothing delivers it again: not the session's hooks, a poll, or a retry
    # of its id.
    refute harness_hook!(harness, uuid, "PostToolUse") =~ "check the fit"
    poll!(poller)
    assert {out, 0} = send.()
    assert out =~ "accepted #{address} (s-busy)"
    refute harness_hook!(harness, uuid, "Stop") =~ "check the fit"
    refute_receive {:wake, _}
  end

  defp session_uuid do
    n = System.unique_integer([:positive]) |> Integer.to_string() |> String.pad_leading(12, "0")
    "b0b0b0b0-0000-4000-8000-#{n}"
  end
end
