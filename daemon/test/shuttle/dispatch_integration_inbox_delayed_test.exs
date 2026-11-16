defmodule Shuttle.DispatchIntegrationInboxDelayedTest do
  # A delayed message from the outside: the real `shuttle message --in` sends
  # it to this test's daemon over HTTP, and the session a later daemon starts
  # for it is offered it by its real hook. The inbox promises a delayed
  # message is delivered exactly once once due, even when its owner dies while
  # it waits.
  use Shuttle.Test.DispatchIntegrationCase, async: true

  test "a delayed message outlives its owner's death and is delivered exactly once when due",
       %{host: host} do
    id = armed(host, "tests/delayed-survives")
    poller = poller!(host)
    serve_api!(host)

    assert {out, 0} =
             shuttle([
               "message",
               id,
               "check the fit converged",
               "--in",
               "2s",
               "--message-id",
               "later",
               "--from",
               "life/vizier"
             ])

    assert out =~ "scheduled for #{id}"
    assert launches(id) == 0

    kill_daemon!(poller)

    # The next daemon starts a session for it once it is due, and that
    # session's first prompt is offered it.
    poller = restart!(host)
    release!(poller)

    assert eventually(fn ->
             poll!(poller)
             launches(id) == 1
           end)

    %{session_uuid: uuid} = Poller.live_worker(poller, id)
    offered = hook!(uuid)
    assert offered =~ "check the fit converged"
    assert offered =~ "life/vizier"

    # Exactly once: later prompts and polls offer it no more.
    refute hook!(uuid) =~ "check the fit converged"
    poll!(poller)
    refute hook!(uuid) =~ "check the fit converged"
    assert launches(id) == 1
  end
end
