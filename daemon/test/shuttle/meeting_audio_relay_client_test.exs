defmodule Shuttle.MeetingAudioRelay.ClientTest do
  use ExUnit.Case, async: true
  alias Shuttle.MeetingAudioRelay.Client

  defmodule Refusal do
    @behaviour Plug
    def init(opts), do: opts

    def call(conn, observer) do
      send(observer, {:request, conn.request_path})

      conn
      |> Plug.Conn.put_resp_header("location", "/second")
      |> Plug.Conn.send_resp(302, "redirect")
    end
  end

  test "rejected upgrade is not redirected, retried, or reconnected" do
    pid =
      start_supervised!(
        {Bandit, plug: {Refusal, self()}, port: 0, ip: {127, 0, 0, 1}, startup_log: false}
      )

    {:ok, {_, port}} = ThousandIsland.listener_info(pid)
    assert {:error, :upgrade_rejected} = Client.connect("http://127.0.0.1:#{port}/first")
    assert_receive {:request, "/first"}
    refute_receive {:request, _}
  end

  test "private tailnet configuration fails closed instead of dialing directly or via proxy" do
    Shuttle.Test.Env.put_app_env(:tailscale_socket, "/tmp/relay-localapi.sock")
    Shuttle.Test.Env.put_app_env(:https_proxy, "127.0.0.1:1")

    assert {:error, {:tailnet_dial, :no_bridge}} =
             Client.connect("https://no-bridge.invalid:443/api/v1/meeting/audio")

    Shuttle.Test.Env.put_app_env(:tailscale_socket, "relative-invalid")

    assert {:error, {:tailnet_dial, :invalid_tailscale_socket}} =
             Client.connect("https://no-bridge.invalid/api/v1/meeting/audio")
  end

  test "shared hosts refuse the unauthenticated HTTPS proxy" do
    Shuttle.Test.Env.put_app_env(:tailscale_socket, false)
    Shuttle.Test.Env.put_app_env(:https_proxy, "127.0.0.1:1")
    Shuttle.Test.Env.put_app_env(:host_class, :shared_multi_user)

    assert {:error, :https_proxy_refused} =
             Client.connect("https://recorder.invalid/api/v1/meeting/audio")
  end

  test "loopback HTTPS bypasses the configured proxy while still verifying TLS" do
    Shuttle.Test.Env.put_app_env(:tailscale_socket, false)
    Shuttle.Test.Env.put_app_env(:https_proxy, "127.0.0.1:1")
    Shuttle.Test.Env.put_app_env(:host_class, :single_user)

    pid =
      start_supervised!(
        {Bandit,
         plug: {Refusal, self()},
         scheme: :https,
         port: 0,
         ip: {127, 0, 0, 1},
         startup_log: false,
         certfile: Path.expand("../fixtures/tailnet/server.crt", __DIR__),
         keyfile: Path.expand("../fixtures/tailnet/server.key", __DIR__)}
      )

    {:ok, {_, port}} = ThousandIsland.listener_info(pid)
    assert {:error, {:tls_alert, _}} = Client.connect("https://127.0.0.1:#{port}/first")
    refute_receive {:request, _}
  end

  test "wire parsing bounds frames and incomplete messages" do
    state = %{buffer: <<>>, fragment: nil}
    assert {:error, :frame_too_large} = Client.consume(state, <<130, 127, 1_000_001::64>>)
    body = :binary.copy(<<0>>, 1_000_000)

    assert {:ok, [{:binary, ^body}, {:text, "ok"}], %{buffer: <<>>}} =
             Client.consume(state, <<130, 127, 1_000_000::64, body::binary, 129, 2, "ok">>)

    assert {:ok, [], state} = Client.consume(state, <<2, 126, 65535::16, 0::size(65535 * 8)>>)

    assert {:error, :message_too_large} =
             Client.consume(state, <<128, 127, 950_000::64, 0::size(950_000 * 8)>>)
  end
end

defmodule Shuttle.MeetingAudioRelay.PrivateTransportTest do
  # TailnetDial's bridge table is global. Own it only in the synchronous tier,
  # as tailnet_dial_test does; the WebSocket listeners are throwaway endpoints.
  use ExUnit.Case, async: false
  alias Shuttle.Test.MeetingAudioRelay.{Ingress, Recorder}
  alias Shuttle.Remote

  test "a hub forwards real WS audio via the private bridge, retaining receiving host and launch" do
    base = "/tmp/relay-td-#{System.unique_integer([:positive])}"
    File.mkdir_p!(base)
    on_exit(fn -> File.rm_rf!(base) end)
    path = Path.join(base, "dial.sock")
    Shuttle.Test.Env.put_app_env(:tailscale_socket, Path.join(base, "localapi.sock"))

    {:ok, manager} =
      Shuttle.TailnetDial.start_link(
        remotes: [],
        tailscale_socket: Path.join(base, "localapi.sock"),
        data_dir: base,
        refresh?: false
      )

    Process.unlink(manager)
    on_exit(fn -> if Process.alive?(manager), do: Supervisor.stop(manager) end)
    host = "recorder-private.invalid"
    Shuttle.TailnetDial.register_bridge(host, 443, "recorder", path)

    start_supervised!(
      {Bandit,
       plug:
         {Ingress,
          routing: [own_host_id: "recorder", remotes: []],
          socket: Recorder,
          socket_opts: [observer: self()]},
       ip: {:local, path},
       port: 0,
       startup_log: false},
      id: :private
    )

    hub =
      start_supervised!(
        {Bandit,
         plug:
           {Ingress,
            routing: [
              own_host_id: "hub",
              remotes: [%Remote{name: "recorder", url: "https://#{host}"}]
            ]},
         ip: {127, 0, 0, 1},
         port: 0,
         startup_log: false},
        id: :hub
      )

    {:ok, {_, port}} = ThousandIsland.listener_info(hub)

    assert {:ok, browser} =
             Shuttle.MeetingAudioRelay.Client.connect(
               "http://127.0.0.1:#{port}/api/v1/meeting/audio?recorder=recorder&launch=private-L1"
             )

    assert_receive {:recorder, _, "private-L1"}, 10_000
    :ok = Shuttle.MeetingAudioRelay.Client.send_frame(browser, :binary, <<255, 0, 127>>)
    assert_receive {:audio, :binary, <<255, 0, 127>>}, 10_000
    Shuttle.MeetingAudioRelay.Client.close(browser)
    assert_receive {:recorder_closed, _}, 10_000
  end
end
