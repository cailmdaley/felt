defmodule Shuttle.DispatchIntegrationInboxCrossHostTest do
  # A message to a fiber another daemon owns, from the outside: the real
  # `shuttle message` on a sending host reaches its own daemon, which forwards
  # it over HTTP to the owner's `/api/v1/deliver`; the owner's next session
  # is offered it by its real hook. Both daemons run in this VM, each in a
  # scope of its own (environment, data directory, Poller and host id) behind
  # its own loopback port. The owner keeps the inbox's promise across its own
  # death: the message is delivered exactly once.
  use Shuttle.Test.DispatchIntegrationCase, async: true

  # A second daemon, `hub-host`: a process owning a scope of its own, with a
  # Poller over no stores, the owner as its one remote, and its API served.
  # Answers its URL.
  defp sending_daemon!(host, owner_url) do
    test = self()
    data = Path.join(host, "hub-data")
    File.mkdir_p!(data)
    %URI{port: owner_port} = URI.parse(owner_url)

    daemon =
      spawn(fn ->
        receive do
          {:run, fun} -> fun.()
        end

        send(test, :hub_ready)
        Process.sleep(:infinity)
      end)

    Shuttle.Test.Env.adopt_scope!(daemon)
    on_exit(fn -> Process.exit(daemon, :kill) end)

    send(
      daemon,
      {:run,
       fn ->
         Shuttle.Test.Env.put_env("SHUTTLE_DATA_DIR", data)
         Shuttle.Test.Env.put_env("SHUTTLE_SESSIONS_FILE", Path.join(data, "sessions.jsonl"))
         Shuttle.Test.Env.put_env("SHUTTLE_STORES", Path.join(host, "hub-store"))
         Shuttle.Test.Env.put_app_env(:remotes, [%{name: "test-host", port: owner_port}])

         {:ok, poller} =
           Shuttle.Poller.start_link(
             name: nil,
             own_host_id: "hub-host",
             felt_stores: [],
             poll_interval_ms: 600_000,
             change_interval_ms: :infinity,
             publish_debounce_ms: 0,
             daemon_heartbeat_file: Path.join(data, "heartbeat.json")
           )

         Shuttle.Test.Env.put_server(Shuttle.Poller, poller)
         send(test, {:hub_poller, poller})
       end}
    )

    assert_receive {:hub_poller, poller}
    assert_receive :hub_ready
    await_boot_cycle!(poller)

    api =
      start_supervised!(
        {Bandit, plug: {ScopedAPI, daemon}, port: 0, ip: {127, 0, 0, 1}, startup_log: false},
        id: make_ref()
      )

    {:ok, {_, port}} = ThousandIsland.listener_info(api)
    "http://127.0.0.1:#{port}"
  end

  test "a message the sender's daemon forwards to the fiber's owner is delivered once across the owner's death",
       %{host: host} do
    id = armed(host, "tests/remote-message")
    poller = poller!(host, boot_quarantine: true)
    serve_api!(host)
    owner_url = Shuttle.Env.get("SHUTTLE_DAEMON_URL")
    hub_url = sending_daemon!(host, owner_url)

    # The sending host has the fiber's document, synchronized, and its own
    # daemon.
    send = fn message_id, text ->
      shuttle(["message", id, text, "--message-id", message_id, "--from", "life/vizier"],
        env: [
          {"SHUTTLE_HOST", "hub-host"},
          {"SHUTTLE_DAEMON_URL", hub_url},
          {"SHUTTLE_DATA_DIR", Path.join(host, "hub-data")}
        ]
      )
    end

    assert {out, 0} = send.("m-remote", "check the remote fit")
    assert out =~ "queued for #{id}"
    assert out =~ "boot quarantine"
    assert launches(id) == 0

    kill_daemon!(poller)

    poller = poller!(host)
    assert launches(id) == 1
    %{session_uuid: uuid} = Poller.live_worker(poller, id)
    assert hook!(uuid) =~ "check the remote fit"
    refute hook!(uuid) =~ "check the remote fit"
    assert {_, 0} = send.("m-remote", "check the remote fit")
    poll!(poller)
    refute hook!(uuid) =~ "check the remote fit"
    assert launches(id) == 1
  end
end
