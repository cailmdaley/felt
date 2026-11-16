defmodule Shuttle.DispatchIntegrationInboxDelayedTest do
  # A delayed message from the outside: the real `shuttle message --in` sends
  # it to this test's daemon over HTTP, and the session a later daemon starts
  # for it is offered it by its real hook. The inbox promises a delayed
  # message is delivered exactly once once due, and not before, even when its
  # owner dies while it waits.
  use Shuttle.Test.DispatchIntegrationCase, async: true

  # The daemon's polls until one starts a session for `id`, newest first:
  # when each ended, and whether a session had started by then.
  defp polls_until_launch(poller, id, polls) do
    poll!(poller)
    polls = [{DateTime.utc_now(), launches(id)} | polls]

    case polls do
      [{_, 0} | _] when length(polls) < 600 -> polls_until_launch(poller, id, polls)
      _ -> polls
    end
  end

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
               "3s",
               "--message-id",
               "later",
               "--from",
               "life/vizier"
             ])

    assert out =~ "scheduled for #{id}"
    [_, at] = Regex.run(~r/scheduling later for (\S+);/, out)
    {:ok, due, _} = DateTime.from_iso8601(at)
    assert launches(id) == 0

    kill_daemon!(poller)

    # The next daemon holds it until it is due: no poll that ended before the
    # instant started a session, and at least one did end before it. Then it
    # starts a session for it, and that session's first prompt is offered it.
    poller = restart!(host)
    release!(poller)

    polls = polls_until_launch(poller, id, [])
    assert [{ended, 1} | waiting] = polls
    assert DateTime.compare(ended, due) != :lt
    assert Enum.any?(waiting, fn {ended, 0} -> DateTime.compare(ended, due) == :lt end)

    %{session_uuid: uuid} = Poller.live_worker(poller, id)
    session = claude_session!(uuid)
    offered = harness_hook!(session, uuid, "UserPromptSubmit")
    assert offered =~ "check the fit converged"
    assert offered =~ "life/vizier"

    # Exactly once: later prompts and polls neither offer it nor wake the
    # session with it.
    refute harness_hook!(session, uuid, "UserPromptSubmit") =~ "check the fit converged"
    poll!(poller)
    refute harness_hook!(session, uuid, "UserPromptSubmit") =~ "check the fit converged"
    refute_receive {:wake, _}
    assert launches(id) == 1
  end
end
