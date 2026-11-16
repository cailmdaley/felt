defmodule Shuttle.DispatchIntegrationInboxMessageTest do
  # A message between sessions to a fiber, from the outside: the real
  # `shuttle message` sends it to this test's daemon over HTTP, and the real
  # hook of the session that daemon starts is offered it. The inbox promises
  # it is delivered exactly once, even when its owner dies between enqueuing
  # and delivering it. The message also answers the fiber's outstanding
  # question, which its owner clears on enqueue.
  use Shuttle.Test.DispatchIntegrationCase, async: true

  test "a message enqueued before its owner dies is delivered exactly once by the next daemon",
       %{host: host} do
    id = armed(host, "tests/message-survives", "  ask:\n    text: Did it converge?\n")
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

    # The owner clears the question the fiber had outstanding: the message
    # answers it. The sender runs inside no store, so only the owner can.
    assert eventually(fn -> is_nil(get_in(read_frontmatter(host, id), ["shuttle", "ask"])) end)

    kill_daemon!(poller)

    # The next daemon boots under its own quarantine and holds the message
    # again; once released, it starts the session the message asks for, and
    # that session's first prompt is offered the message.
    poller = restart!(host)
    assert launches(id) == 0
    release!(poller)
    assert launches(id) == 1
    %{session_uuid: uuid} = Poller.live_worker(poller, id)
    session = claude_session!(uuid)
    offered = harness_hook!(session, uuid, "UserPromptSubmit")
    assert offered =~ "check the fit converged"
    assert offered =~ "life/vizier"

    # Exactly once: no later prompt, poll or retry of the id offers it again
    # or wakes the session with it, and the retry answers that it was
    # delivered.
    refute harness_hook!(session, uuid, "UserPromptSubmit") =~ "check the fit converged"
    poll!(poller)
    assert {out, 0} = send.("m-survives", "check the fit converged")
    assert out =~ "delivered to #{id} (m-survives)"
    poll!(poller)
    refute harness_hook!(session, uuid, "UserPromptSubmit") =~ "check the fit converged"
    refute_receive {:wake, _}
    assert launches(id) == 1

    # A new message reaches the same worker, which no hook has reported busy,
    # as a wake, once.
    assert {_, 0} = send.("m-after", "and the residuals")
    assert_receive {:wake, woken}
    assert woken =~ "and the residuals"
    poll!(poller)
    refute_receive {:wake, _}
    assert launches(id) == 1
  end
end
