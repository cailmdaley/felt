defmodule Shuttle.DispatchIntegrationInboxNotifyIdleTest do
  # A subscription to a fiber's idleness, from the outside: the real
  # `shuttle message <fiber> --notify-when-idle` with no text reaches this
  # test's daemon over HTTP, and the subscription is made with the fiber's
  # live worker, whose native messaging socket is asked for one idle notice.
  # When the worker answers that it went idle, the subscribing session gets
  # the notice once. The subscription is no message: nothing reaches the
  # fiber's inbox, and a fiber with no live worker refuses it and starts
  # nothing.
  use Shuttle.Test.DispatchIntegrationCase, async: true

  defp uuid,
    do:
      "5b5c71be-0000-4000-8000-#{System.unique_integer([:positive]) |> Integer.to_string() |> String.pad_leading(12, "0")}"

  test "a notify-only send to a fiber subscribes its live worker and notifies the subscriber once",
       %{host: host} do
    id = armed(host, "tests/notify-idle")
    dormant = armed(host, "tests/notify-idle-dormant")
    serve_api!(host)
    poller = poller!(host)
    assert {200, _} = post_api("/api/v1/dispatch", %{"fiber_id" => id, "force" => true})
    %{session_uuid: worker} = Poller.live_worker(poller, id)
    claude_session!(worker, :hold)

    subscriber = uuid()
    claude_session!(subscriber)
    from = "shuttle://test-host/claude/#{subscriber}"

    subscribe = fn fiber, message_id ->
      shuttle([
        "message",
        fiber,
        "--notify-when-idle",
        "--notify-wake",
        "--message-id",
        message_id,
        "--from",
        from
      ])
    end

    # The owner subscribes the fiber's live worker: the receipt names it, and
    # its native socket is asked for one idle notice.
    assert {out, 0} = subscribe.(id, "n-idle")
    assert out =~ "subscribed shuttle://test-host/claude/#{worker} (n-idle)"

    assert_receive {:native_frame, receiver,
                    %{"action" => "notify_when_idle", "from" => "uds:" <> path, "msg_id" => ask}},
                   15_000

    send(receiver, {:fate, :drop})
    assert inbox(id) == []
    refute_receive {:wake, _}

    # The worker answers that its turn ended, as Claude Code does, over a
    # connection it holds open while the watcher reads it; the subscriber is
    # woken with the notice, once.
    {:ok, conn} = :gen_tcp.connect({:local, path}, 0, [:binary, active: false])

    :ok =
      :gen_tcp.send(
        conn,
        Jason.encode!(%{
          type: "control",
          action: "peer_idle_notice",
          orig_msg_id: ask,
          state: "idle"
        }) <> "\n"
      )

    assert_receive {:wake, notice}, 30_000
    :gen_tcp.close(conn)
    assert notice =~ "Idle notice: shuttle://test-host/claude/#{worker} ended its turn"
    assert notice =~ "[subscription n-idle]"
    refute_receive {:wake, _}, 1_000

    # A fiber with no live worker has nobody to watch: the subscription is
    # refused, and no session starts for it.
    assert {_, status} = subscribe.(dormant, "n-dormant")
    assert status != 0
    assert launches(dormant) == 0
    assert inbox(dormant) == []
    assert launches(id) == 1
  end
end
