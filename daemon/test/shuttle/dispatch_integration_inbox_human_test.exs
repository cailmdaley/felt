defmodule Shuttle.DispatchIntegrationInboxHumanTest do
  # The human's typed line from the outside: the board's request to this
  # test's daemon, and what reaches the worker's terminal (a paste, or the
  # From User launch prompt) and the family board. The inbox promises a typed
  # line at most once: a line whose owner died between recording and typing
  # it is never typed again, and its retry says it may not have arrived.
  # Answering the fiber's question has no entry of its own; it is a side
  # effect of the line, pinned here.
  use Shuttle.Test.DispatchIntegrationCase, async: true

  defp line(id, message_id, text),
    do: %{"fiber_id" => id, "text" => text, "from" => "human", "message_id" => message_id}

  defp rows(events, message_id),
    do: Enum.filter(board_rows(events), &(&1["id"] == "brd-" <> message_id))

  test "a line answers the question once, and a line its owner died typing is never typed again",
       %{host: host} do
    id = armed(host, "tests/human-line", "  ask:\n    text: Which kernel?\n")
    events = serve_api!(host)
    TransportRunner.start!(self())
    poller = poller!(host, runner: TransportRunner)

    # The answer starts the dormant fiber with it as From User, clears the
    # question and writes one answered row.
    answer = line(id, "h-answer", "Use the GPU kernel.")
    assert {200, %{"delivered" => true}} = post_api("/api/v1/deliver", answer)
    assert launches(id) == 1
    assert read_run_script() =~ "From User:\nUse the GPU kernel."
    assert eventually(fn -> is_nil(get_in(read_frontmatter(host, id), ["shuttle", "ask"])) end)
    assert [%{"kind" => "answered"}] = rows(events, "h-answer")

    assert {200, %{"duplicate" => true, "delivered" => true}} =
             post_api("/api/v1/deliver", answer)

    assert launches(id) == 1
    assert [_] = rows(events, "h-answer")

    # The daemon dies holding the next line at the live worker's terminal,
    # after recording it and before typing it.
    TransportRunner.gate(:paste)
    lost = line(id, "h-lost", "Then rerun the fit.")
    request = post_api_async("/api/v1/deliver", lost)
    assert_receive {:transport_held, :paste, holder}
    kill_daemon!(poller, [request], holding: holder)

    poller = restart!(host, runner: TransportRunner)
    assert %{session_uuid: uuid} = Poller.live_worker(poller, id)

    # Never typed again: the retry types nothing and says it may not have
    # arrived, and polls type nothing.
    assert {200, %{"duplicate" => true, "disposition" => "unknown", "delivered" => nil}} =
             post_api("/api/v1/deliver", lost)

    poll!(poller)
    refute Enum.any?(TransportRunner.pastes(), &(&1 =~ "Then rerun the fit."))
    refute hook!(uuid) =~ "Then rerun the fit."

    # The same session's hook does offer what is queued for it: an agent's
    # context, sent now.
    assert {_, 0} =
             shuttle([
               "message",
               id,
               "Also check the kernel.",
               "--context-only",
               "--message-id",
               "h-context",
               "--from",
               "life/vizier"
             ])

    assert hook!(uuid) =~ "Also check the kernel."
    assert [%{"kind" => "human"}] = rows(events, "h-lost")

    # A new line is typed into the same worker, once.
    assert {200, %{"delivered" => true}} =
             post_api("/api/v1/deliver", line(id, "h-next", "And plot the residuals."))

    assert [_] = Enum.filter(TransportRunner.pastes(), &(&1 =~ "And plot the residuals."))
    assert launches(id) == 1
  end
end
