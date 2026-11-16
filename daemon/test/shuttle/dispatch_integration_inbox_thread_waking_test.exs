defmodule Shuttle.DispatchIntegrationInboxThreadWakingTest do
  # A waking thread result from the outside: the orchestrator's live worker
  # starts a thread with the real CLI, so the thread records it as the asker,
  # and the thread's ask and close, made with the real CLI and taken by the
  # daemon's own poll, wake that worker on its native messaging socket. The
  # inbox promises each is delivered exactly once, also across a daemon death
  # after the wake.
  use Shuttle.Test.DispatchIntegrationCase, async: true

  test "a result the orchestrator's worker asked for wakes it once, and never again after a death",
       %{host: host} do
    hub = armed(host, "hub")
    serve_api!(host)
    TransportRunner.start!(self())
    poller = poller!(host, runner: TransportRunner)

    # The orchestrator's live worker starts a thread: the thread records it
    # as the asker.
    assert {200, _} = post_api("/api/v1/dispatch", %{"fiber_id" => hub, "force" => true})
    %{session_uuid: uuid} = Poller.live_worker(poller, hub)
    harness = claude_session!(uuid)

    assert {_, 0} =
             shuttle(
               [
                 "-C",
                 host,
                 "thread",
                 hub,
                 "Investigate kernels",
                 "--slug",
                 "kernels",
                 "--disabled"
               ],
               env: [{"CLAUDE_CODE_SESSION_ID", uuid}]
             )

    # Its ask is a result for that worker: the daemon's poll wakes it with it.
    assert {_, 0} = shuttle(["-C", host, "ask", "hub/kernels", "Which kernel?"])
    poll!(poller)
    assert_receive {:wake, woken}
    assert woken =~ "thread hub/kernels asked: Which kernel?"
    assert inbox(hub) == []

    # Exactly once, across the daemon's death: the next daemon's polls
    # neither wake the worker with it again nor offer it to its hooks.
    kill_daemon!(poller)
    poller = restart!(host, runner: TransportRunner)
    release!(poller)
    assert %{session_uuid: ^uuid} = Poller.live_worker(poller, hub)
    poll!(poller)
    refute_receive {:wake, _}
    refute harness_hook!(harness, uuid, "UserPromptSubmit") =~ "Which kernel?"

    # The thread's close, the next result, wakes the same worker, once.
    assert {_, 0} = shuttle(["-C", host, "close", "hub/kernels", "--local"])
    poll!(poller)
    assert_receive {:wake, woken}
    assert woken =~ "thread hub/kernels closed"
    poll!(poller)
    refute_receive {:wake, _}
    assert launches(hub) == 1
  end
end
