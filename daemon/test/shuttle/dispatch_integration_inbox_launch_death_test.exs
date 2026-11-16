defmodule Shuttle.DispatchIntegrationInboxLaunchDeathTest do
  # A message to a dormant fiber whose owner dies while starting the session
  # the message asked for, from the outside: the real `shuttle message`
  # reaches this test's daemon over HTTP, the daemon reserves a launch and
  # dies at the terminal, before the session starts. The launch's outcome is
  # unknown, so the next daemon starts nothing on its own: Shuttle never
  # risks a second worker (docs/dev/dispatch.md, uncertain launch
  # reservations). The message waits in the inbox through that hold, and once
  # an operator releases the reservation the session that starts is offered
  # it exactly once.
  use Shuttle.Test.DispatchIntegrationCase, async: true

  defp pending(id) do
    {out, 0} = shuttle(["inbox", "ls", id, "--json"])
    for entry <- Jason.decode!(out), do: entry["id"]
  end

  test "a message whose launch its owner died starting waits for the operator, then is delivered once",
       %{host: host} do
    id = armed(host, "tests/launch-death")
    serve_api!(host)
    TransportRunner.start!(self())
    poller = poller!(host, runner: TransportRunner)
    test = self()

    send = fn ->
      shuttle([
        "message",
        id,
        "check the fit",
        "--message-id",
        "m-inflight",
        "--from",
        "life/vizier"
      ])
    end

    # The owner takes the message into the inbox, reserves the launch it asks
    # for and dies at the terminal, starting the session. The sender is not
    # told it arrived.
    TransportRunner.gate(:launch)

    spawn(fn ->
      Shuttle.Env.adopt_callers([test])
      send(test, {:sent, send.()})
    end)

    assert_receive {:transport_held, :launch, holder}
    assert pending(id) == ["m-inflight"]
    kill_daemon!(poller, [], holding: holder)
    assert_receive {:sent, {_, status}} when status != 0, 60_000

    # The next daemon starts nothing for it, polled or forced, and the
    # sender's retry adds nothing: the message waits.
    poller = restart!(host, runner: TransportRunner)
    release!(poller)
    poll!(poller)
    assert launches(id) == 0

    assert {409, %{"reason" => "launch_reserved"}} =
             post_api("/api/v1/dispatch", %{"fiber_id" => id, "force" => true})

    assert {_, 0} = send.()
    poll!(poller)
    assert launches(id) == 0
    assert pending(id) == ["m-inflight"]

    # The operator accepts the risk; the session that starts is offered the
    # message by its first prompt, and nothing after it offers it or wakes
    # the session with it.
    assert {_, 0} = shuttle(["dispatch", id, "--release-launch-reservation"])
    drain!(poller)
    assert launches(id) == 1
    %{session_uuid: uuid} = Poller.live_worker(poller, id)
    session = claude_session!(uuid)
    offered = harness_hook!(session, uuid, "UserPromptSubmit")
    assert offered =~ "check the fit"
    assert offered =~ "life/vizier"
    assert pending(id) == []
    refute harness_hook!(session, uuid, "UserPromptSubmit") =~ "check the fit"
    poll!(poller)
    refute harness_hook!(session, uuid, "UserPromptSubmit") =~ "check the fit"
    refute_receive {:wake, _}
    assert launches(id) == 1
  end
end
