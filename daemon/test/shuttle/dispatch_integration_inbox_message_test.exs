defmodule Shuttle.DispatchIntegrationInboxMessageTest do
  # A message between sessions to a fiber, from the outside: the real
  # `shuttle message` sends it to this test's daemon over HTTP, and the real
  # hook of the session that daemon starts is offered it. The inbox promises
  # it is delivered exactly once, even when its owner dies between enqueuing
  # and delivering it.
  use Shuttle.Test.DispatchIntegrationCase, async: true

  test "a message enqueued before its owner dies is delivered exactly once by the next daemon",
       %{host: host} do
    id = armed(host, "tests/message-survives")
    poller = poller!(host, boot_quarantine: true)
    serve_api!(host)

    send = fn message_id, text ->
      shuttle(["message", id, text, "--message-id", message_id, "--from", "life/vizier"])
    end

    # The owner takes it into the inbox and holds the session it asks for.
    assert {out, 0} = send.("m-survives", "check the fit converged")
    assert out =~ "queued for #{id}"
    assert out =~ "boot quarantine"
    assert launches(id) == 0

    kill_daemon!(poller)

    # The next daemon boots under its own quarantine and holds the message
    # again; once released, it starts the session the message asks for, and
    # that session's first prompt is offered the message.
    poller = restart!(host)
    assert launches(id) == 0
    release!(poller)
    assert launches(id) == 1
    %{session_uuid: uuid} = Poller.live_worker(poller, id)
    offered = hook!(uuid)
    assert offered =~ "check the fit converged"
    assert offered =~ "life/vizier"

    # Exactly once: no later prompt, poll or retry of the id offers it again.
    refute hook!(uuid) =~ "check the fit converged"
    poll!(poller)
    assert {_, 0} = send.("m-survives", "check the fit converged")
    poll!(poller)
    refute hook!(uuid) =~ "check the fit converged"
    assert launches(id) == 1

    # A new message reaches the same worker the same way.
    assert {_, 0} = send.("m-after", "and the residuals")
    poll!(poller)
    assert hook!(uuid) =~ "and the residuals"
    assert launches(id) == 1
  end
end
