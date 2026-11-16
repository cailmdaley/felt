defmodule Shuttle.DispatchIntegrationInboxFreshTest do
  # An agent's `--fresh` from the outside: the real `shuttle message --fresh`
  # sends it to this test's daemon over HTTP, and the session it starts
  # carries the text in its launch prompt. The inbox promises a fresh request
  # at most once: one whose owner died between recording it and launching is
  # never launched again, and its retry says the launch is unconfirmed.
  use Shuttle.Test.DispatchIntegrationCase, async: true

  defp fresh(id, message_id, text),
    do:
      shuttle([
        "message",
        id,
        text,
        "--fresh",
        "--message-id",
        message_id,
        "--from",
        "life/vizier"
      ])

  defp carrying(text),
    do: Enum.count(TransportRunner.launched(), &(&1 =~ "From life/vizier:\n" <> text))

  test "a fresh request its owner died launching is never launched again", %{host: host} do
    id = armed(host, "tests/fresh-request")
    serve_api!(host)
    TransportRunner.start!(self())
    poller = poller!(host, runner: TransportRunner)

    assert {out, 0} = fresh(id, "f-first", "start over")
    assert out =~ "started a fresh session on #{id}"
    assert carrying("start over") == 1

    # The owner dies holding the next request's launch at the terminal, after
    # recording it and before the session starts. The request is the one the
    # CLI sends.
    TransportRunner.gate(:launch)

    request =
      post_api_async("/api/v1/deliver", %{
        "fiber_id" => id,
        "origin" => "test-host",
        "text" => "rerun from scratch",
        "from" => "life/vizier",
        "message_id" => "f-lost",
        "resume_mode" => "fresh"
      })

    assert_receive {:transport_held, :launch, ^poller}
    kill_daemon!(poller, [request])
    refute_received {:answered, ^request, _}

    poller = poller!(host, runner: TransportRunner)

    # Never launched again: the sender's retry starts nothing and says so.
    assert {out, 0} = fresh(id, "f-lost", "rerun from scratch")
    assert out =~ "launch unconfirmed"
    poll!(poller)
    assert carrying("rerun from scratch") == 0

    # A new request starts its session, once. It goes to another fiber: the
    # launch the dead daemon left unconfirmed holds this one's until an
    # operator releases it (docs/dev/dispatch.md, uncertain launch
    # reservations).
    other = armed(host, "tests/fresh-other")
    poll!(poller)
    assert {out, 0} = fresh(other, "f-next", "begin again")
    assert out =~ "started a fresh session on #{other}"
    assert {_, 0} = fresh(other, "f-next", "begin again")
    assert carrying("begin again") == 1
  end
end
