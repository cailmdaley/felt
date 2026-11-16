defmodule Shuttle.DispatchIntegrationInboxVoiceTest do
  # The human's spoken line from the outside: the voice relay's request to
  # this test's daemon (the `live_input` envelope it forwards each batch in),
  # and what reaches the worker's terminal and the family board. The relay
  # itself is not driven here; its recovery repeats the same request under the
  # batch's id, which the test sends. The inbox promises a spoken line at
  # most once: one whose owner died between recording and typing it is never
  # typed again.
  use Shuttle.Test.DispatchIntegrationCase, async: true

  defp batch(id, message_id, text),
    do: %{"fiber_id" => id, "text" => text, "message_id" => message_id, "live_input" => true}

  defp rows(events, message_id),
    do: Enum.filter(board_rows(events), &(&1["id"] == "brd-" <> message_id))

  test "a spoken line its owner died typing is never typed again, through the boot quarantine",
       %{host: host} do
    id = armed(host, "tests/voice-line")
    events = serve_api!(host)
    TransportRunner.start!(self())
    poller = poller!(host, runner: TransportRunner, boot_quarantine: true)

    # A spoken line starts the dormant fiber through the quarantine, as the
    # human's own line, and writes one row.
    first = batch(id, "voice-first", "me: Claude, check the fit")
    assert {200, %{"delivered" => true}} = post_api("/api/v1/deliver", first)
    assert launches(id) == 1
    assert read_run_script() =~ "From User:\nme: Claude, check the fit"
    assert [%{"kind" => "human"}] = rows(events, "voice-first")
    assert {200, %{"duplicate" => true}} = post_api("/api/v1/deliver", first)
    assert launches(id) == 1

    # The owner dies holding the next batch at the live worker's terminal,
    # after recording it and before typing it.
    TransportRunner.gate(:paste)
    lost = batch(id, "voice-lost", "me: then rerun it")
    request = post_api_async("/api/v1/deliver", lost)
    assert_receive {:transport_held, :paste, holder}
    kill_daemon!(poller, [request], holding: holder)
    refute_received {:answered, ^request, _}

    poller = restart!(host, runner: TransportRunner)
    assert %{session_uuid: uuid} = Poller.live_worker(poller, id)

    # The relay's recovery repeats the batch: nothing is typed, and the answer
    # says it may not have arrived.
    assert {200, %{"duplicate" => true, "disposition" => "unknown", "delivered" => nil}} =
             post_api("/api/v1/deliver", lost)

    poll!(poller)
    refute Enum.any?(TransportRunner.pastes(), &(&1 =~ "then rerun it"))
    refute hook!(uuid) =~ "then rerun it"
    assert [_] = rows(events, "voice-lost")

    # The next batch is typed into the same worker, once.
    assert {200, %{"delivered" => true}} =
             post_api("/api/v1/deliver", batch(id, "voice-next", "me: and plot it"))

    assert [_] = Enum.filter(TransportRunner.pastes(), &(&1 =~ "me: and plot it"))
    assert launches(id) == 1
  end
end
