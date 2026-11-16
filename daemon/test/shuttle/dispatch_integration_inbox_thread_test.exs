defmodule Shuttle.DispatchIntegrationInboxThreadTest do
  # Thread results from the outside: threads asked and closed with the real
  # CLI, the daemon's own poll, and what the orchestrator's next worker is
  # offered by its real hook. The inbox promises a thread result is delivered
  # exactly once, even when the daemon dies after taking it and before any
  # worker has it.
  use Shuttle.Test.DispatchIntegrationCase, async: true

  defp thread!(host, slug) do
    assert {_, 0} =
             shuttle([
               "-C",
               host,
               "thread",
               "hub",
               "Investigate #{slug}",
               "--slug",
               slug,
               "--disabled"
             ])

    "hub/" <> slug
  end

  test "an ask and a close taken before the daemon dies reach the orchestrator's next worker once",
       %{host: host} do
    hub = armed(host, "hub")
    serve_api!(host)
    poller = poller!(host)
    asker = thread!(host, "asker")
    closer = thread!(host, "closer")

    assert {_, 0} = shuttle(["-C", host, "ask", asker, "Which kernel?"])
    assert {_, 0} = shuttle(["-C", host, "close", closer, "--local"])

    # The daemon takes both results on its poll; nobody asked for them, so
    # they wait for the orchestrator's next worker. Then it dies.
    poll!(poller)
    assert launches(hub) == 0
    kill_daemon!(poller)

    # The next daemon's worker on the orchestrator is offered each result by
    # its prompts, one lifecycle signal per offer, and exactly once: later
    # prompts, tool calls and polls offer neither again.
    poller = poller!(host)
    poll!(poller)
    assert {200, _} = post_api("/api/v1/dispatch", %{"fiber_id" => hub, "force" => true})
    assert launches(hub) == 1
    %{session_uuid: uuid} = Poller.live_worker(poller, hub)
    offered = for _ <- 1..3, into: "", do: hook!(uuid)
    poll!(poller)
    offered = offered <> hook!(uuid) <> hook!(uuid, "PostToolUse")
    assert [_, _] = String.split(offered, "thread #{asker} asked: Which kernel?")
    assert [_, _] = String.split(offered, "thread #{closer} closed")
  end
end
