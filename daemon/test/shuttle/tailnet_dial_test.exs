defmodule Shuttle.TailnetDialTest do
  use ExUnit.Case, async: false
  import ExUnit.CaptureLog
  alias Shuttle.Remote
  alias Shuttle.TailnetDial

  @profile :shuttle_tailnet_dial_test
  @host "hub-a.example.ts.net"
  @cert Path.expand("../fixtures/tailnet/server.crt", __DIR__)
  @key Path.expand("../fixtures/tailnet/server.key", __DIR__)
  @ca Path.expand("../fixtures/tailnet/ca.crt", __DIR__)

  defmodule HTTPSPlug do
    @moduledoc false
    @behaviour Plug

    @impl true
    def init(opts), do: opts

    @impl true
    def call(conn, parent) do
      send(parent, {:https_request, Plug.Conn.get_req_header(conn, "host")})
      Plug.Conn.send_resp(conn, 200, "tailnet-response")
    end
  end

  setup do
    base = "/tmp/td-#{System.unique_integer([:positive])}"
    File.mkdir_p!(base)
    File.chmod!(base, 0o755)
    on_exit(fn -> File.rm_rf(base) end)

    {:ok, server} =
      Bandit.start_link(
        plug: {HTTPSPlug, self()},
        scheme: :https,
        port: 0,
        ip: {127, 0, 0, 1},
        certfile: @cert,
        keyfile: @key,
        startup_log: false
      )

    {:ok, {_ip, tls_port}} = ThousandIsland.listener_info(server)
    on_exit(fn -> Process.exit(server, :normal) end)

    {:ok, base: base, tls_port: tls_port}
  end

  test "socket path components cannot collide between sanitized and literal remote names", %{
    base: base
  } do
    unsafe_name = "hub/a"
    digest = :crypto.hash(:sha256, unsafe_name) |> Base.encode16(case: :lower)

    refute TailnetDial.socket_path(unsafe_name, base) == TailnetDial.socket_path(digest, base)
  end

  test "hashed socket components use a compact 16-hex digest", %{base: base} do
    name = String.duplicate("remote-", 12)
    filename = name |> TailnetDial.socket_path(base) |> Path.basename()

    assert filename =~ ~r/\Ahash-[0-9a-f]{16}\.sock\z/
  end

  test "an overlong physical socket path is rejected without a bind MatchError", %{base: base} do
    remote = remote(@host, 443)
    localapi = Path.join(base, "localapi.sock")
    data_dir = Path.join(base, String.duplicate("d", 75))

    log =
      capture_log(fn ->
        {:ok, manager} =
          TailnetDial.start_link(
            remotes: [remote],
            tailscale_socket: localapi,
            data_dir: data_dir,
            refresh?: false
          )

        Process.unlink(manager)
        send(self(), {:long_path_manager, manager})
      end)

    assert_receive {:long_path_manager, manager}, 1_000
    on_exit(fn -> if Process.alive?(manager), do: Supervisor.stop(manager, :normal) end)

    assert {:tailnet_dial, :listen, {:socket_path_too_long, bytes, limit}} =
             TailnetDial.last_error(remote.name)

    assert bytes >= limit
    assert log =~ "socket path is #{bytes} bytes"
    assert log =~ "platform limit is #{limit} bytes"
    assert Process.alive?(manager)
    assert Process.alive?(Process.whereis(Shuttle.TailnetDial.DynamicSupervisor))
    assert {:error, :enoent} = File.lstat(TailnetDial.socket_path(remote.name, data_dir))
    assert %{bridges: [%{status: "error", error_stage: "listen"}]} = TailnetDial.status()
  end

  test "LocalAPI dial upgrade carries verified TLS and preserves HTTP authority", %{
    base: base,
    tls_port: tls_port
  } do
    certs = test_cacerts()
    previous = Application.get_env(:shuttle, :tailnet_dial_cacerts)
    Application.delete_env(:shuttle, :tailnet_dial_cacerts)
    on_exit(fn -> restore_cacerts(previous) end)

    localapi = start_localapi(base, mode: :relay, tls_port: tls_port, parent: self())
    previous_socket = Application.get_env(:shuttle, :tailscale_socket)
    previous_proxy = Application.get_env(:shuttle, :https_proxy)
    Application.put_env(:shuttle, :tailscale_socket, localapi)
    Application.put_env(:shuttle, :https_proxy, false)

    on_exit(fn ->
      restore_app_env(:tailscale_socket, previous_socket)
      restore_app_env(:https_proxy, previous_proxy)
    end)

    remote = start_bridge(base, localapi, @host, tls_port)

    url = "https://#{@host}:#{tls_port}/api/v1/version"

    assert {:error, {:tailnet_dial, :tls, %{httpc: _httpc_reason, bridge: _tls_reason}}} =
             Shuttle.RemoteRegistry.Client.Default.get(url, 5_000)

    assert_receive {:dial_request, rejected_request}, 5_000
    assert rejected_request =~ "Dial-Host: #{@host}\r\n"

    assert eventually(fn ->
             match?({:tailnet_dial, :tls, _}, TailnetDial.last_error(remote.name))
           end)

    assert {:tailnet_dial, :tls, reason} = TailnetDial.last_error(remote.name)
    assert Enum.any?(["unknown_ca", "selfsigned_peer", "bad_cert"], &(inspect(reason) =~ &1))

    Application.put_env(:shuttle, :tailnet_dial_cacerts, certs)

    assert {:ok, "tailnet-response"} =
             Shuttle.RemoteRegistry.Client.Default.get(url, 5_000)

    assert_receive {:dial_request, accepted_request}, 5_000
    assert accepted_request =~ "POST /localapi/v0/dial HTTP/1.1"
    assert accepted_request =~ "Dial-Host: #{@host}\r\n"
    assert accepted_request =~ "Dial-Port: #{tls_port}\r\n"
    assert accepted_request =~ "Sec-Tailscale: localapi\r\n"
    assert_receive {:https_request, [host_header]}, 5_000
    assert host_header == "#{@host}:#{tls_port}"
    assert TailnetDial.last_error(remote.name) == nil
    assert Process.alive?(Process.whereis(Shuttle.TailnetDial))
  end

  test "the private HTTP authority omits an explicit default HTTPS port", %{
    base: base,
    tls_port: tls_port
  } do
    previous_cacerts = Application.get_env(:shuttle, :tailnet_dial_cacerts)
    previous_socket = Application.get_env(:shuttle, :tailscale_socket)
    previous_proxy = Application.get_env(:shuttle, :https_proxy)
    Application.put_env(:shuttle, :tailnet_dial_cacerts, test_cacerts())
    on_exit(fn -> restore_cacerts(previous_cacerts) end)

    localapi = start_localapi(base, mode: :relay, tls_port: tls_port, parent: self())
    Application.put_env(:shuttle, :tailscale_socket, localapi)
    Application.put_env(:shuttle, :https_proxy, false)

    on_exit(fn ->
      restore_app_env(:tailscale_socket, previous_socket)
      restore_app_env(:https_proxy, previous_proxy)
    end)

    _remote = start_bridge(base, localapi, @host, 443)

    assert {:ok, "tailnet-response"} =
             Shuttle.RemoteRegistry.Client.Default.get(
               "https://#{@host}:443/api/v1/version",
               5_000
             )

    assert_receive {:dial_request, request}, 5_000
    assert request =~ "Dial-Port: 443\r\n"
    assert_receive {:https_request, [host_header]}, 5_000
    assert host_header == @host
  end

  test "a configured private dial fails closed while its bridge is unavailable", %{
    base: base,
    tls_port: tls_port
  } do
    previous_socket = Application.get_env(:shuttle, :tailscale_socket)
    previous_proxy = Application.get_env(:shuttle, :https_proxy)
    Application.put_env(:shuttle, :tailscale_socket, Path.join(base, "localapi.sock"))
    Application.put_env(:shuttle, :https_proxy, false)

    on_exit(fn ->
      restore_app_env(:tailscale_socket, previous_socket)
      restore_app_env(:https_proxy, previous_proxy)
    end)

    assert {:error, {:tailnet_dial, :unavailable, {:no_bridge, @host, ^tls_port}}} =
             Shuttle.RemoteRegistry.Client.Default.get(
               "https://#{@host}:#{tls_port}/api/v1/version",
               1_000
             )

    refute_receive {:https_request, _}, 100
  end

  test "an invalid private socket configuration refuses HTTPS instead of dialing directly", %{
    base: base
  } do
    remote_file = Path.join(base, "invalid-remotes.json")
    previous_file = System.get_env("FELT_REMOTES_FILE")
    previous_socket = Application.get_env(:shuttle, :tailscale_socket)
    previous_proxy = Application.get_env(:shuttle, :https_proxy)
    System.put_env("FELT_REMOTES_FILE", remote_file)
    Application.delete_env(:shuttle, :tailscale_socket)
    Application.put_env(:shuttle, :https_proxy, false)

    File.write!(
      remote_file,
      Jason.encode!(%{"defaults" => %{"tailscale_socket" => "relative.sock"}})
    )

    on_exit(fn ->
      restore_env("FELT_REMOTES_FILE", previous_file)
      restore_app_env(:tailscale_socket, previous_socket)
      restore_app_env(:https_proxy, previous_proxy)
    end)

    assert {:error, {:tailnet_dial, :config, :invalid_tailscale_socket}} =
             Shuttle.RemoteRegistry.Client.Default.get("https://#{@host}/api/v1/version", 1_000)

    assert %{configured: true, socket: nil, bridges: []} = TailnetDial.status()
  end

  test "an idle client connection expires after twice the remote request timeout", %{base: base} do
    previous_cacerts = Application.get_env(:shuttle, :tailnet_dial_cacerts)
    Application.put_env(:shuttle, :tailnet_dial_cacerts, test_cacerts())
    on_exit(fn -> restore_cacerts(previous_cacerts) end)

    {tls_port, _peer} = start_silent_tls_peer(base)
    localapi = start_localapi(base, mode: :relay, tls_port: tls_port, parent: self())
    remote = start_bridge(base, localapi, @host, 443, request_timeout_ms: 250)
    path = TailnetDial.socket_path(remote.name, Path.join(base, "data"))
    baseline = Task.Supervisor.children(Shuttle.TaskSupervisor)

    {:ok, client} = :gen_tcp.connect({:local, path}, 0, [:binary, active: false], 5_000)
    assert_receive {:silent_tls_handshake, _peer_pid}, 5_000

    assert eventually(fn -> Task.Supervisor.children(Shuttle.TaskSupervisor) == baseline end, 200)
    assert TailnetDial.last_error(remote.name) == {:tailnet_dial, :relay, :idle_timeout}
    :gen_tcp.close(client)
  end

  test "a closed client cannot leave a stalled TLS relay task behind", %{base: base} do
    previous_cacerts = Application.get_env(:shuttle, :tailnet_dial_cacerts)
    Application.put_env(:shuttle, :tailnet_dial_cacerts, test_cacerts())
    on_exit(fn -> restore_cacerts(previous_cacerts) end)

    {tls_port, _peer} = start_silent_tls_peer(base)
    localapi = start_localapi(base, mode: :relay, tls_port: tls_port, parent: self())
    remote = start_bridge(base, localapi, @host, 443, request_timeout_ms: 250)
    path = TailnetDial.socket_path(remote.name, Path.join(base, "data"))
    baseline = Task.Supervisor.children(Shuttle.TaskSupervisor)

    {:ok, client} = :gen_tcp.connect({:local, path}, 0, [:binary, active: false], 5_000)
    assert_receive {:localapi_relay_pid, relay_pid}, 5_000
    assert_receive {:silent_tls_handshake, _peer_pid}, 5_000
    send(relay_pid, :hold)
    assert_receive {:localapi_relay_held, ^relay_pid}, 5_000
    :gen_tcp.close(client)

    assert eventually(fn -> Task.Supervisor.children(Shuttle.TaskSupervisor) == baseline end, 600)
    assert TailnetDial.last_error(remote.name) == nil
  end

  test "a half-closed TLS peer cannot leave a draining relay task behind", %{base: base} do
    previous_cacerts = Application.get_env(:shuttle, :tailnet_dial_cacerts)
    Application.put_env(:shuttle, :tailnet_dial_cacerts, test_cacerts())
    on_exit(fn -> restore_cacerts(previous_cacerts) end)

    {tls_port, _peer} = start_silent_tls_peer(base, close_write?: true)
    localapi = start_localapi(base, mode: :relay, tls_port: tls_port, parent: self())
    remote = start_bridge(base, localapi, @host, 443, request_timeout_ms: 250)
    path = TailnetDial.socket_path(remote.name, Path.join(base, "data"))
    baseline = Task.Supervisor.children(Shuttle.TaskSupervisor)

    {:ok, client} = :gen_tcp.connect({:local, path}, 0, [:binary, active: false], 5_000)
    assert_receive {:silent_tls_handshake, _peer_pid}, 5_000
    assert_receive {:silent_tls_write_closed, _peer_pid}, 5_000

    assert eventually(fn -> Task.Supervisor.children(Shuttle.TaskSupervisor) == baseline end, 600)
    assert TailnetDial.last_error(remote.name) == {:tailnet_dial, :relay, :drain_timeout}
    :gen_tcp.close(client)
  end

  test "an absent LocalAPI socket closes its client and records the dial failure", %{base: base} do
    localapi = Path.join(base, "absent.sock")
    remote = start_bridge(base, localapi, @host, 443)
    bridge_path = TailnetDial.socket_path(remote.name, Path.join(base, "data"))

    assert {:error, _reason} = request_via_bridge(bridge_path, @host, 443)

    assert eventually(fn ->
             match?({:tailnet_dial, :localapi_connect, _}, TailnetDial.last_error(remote.name))
           end)

    assert Process.alive?(Process.whereis(Shuttle.TailnetDial))
  end

  test "a non-101 LocalAPI response records its status and body", %{base: base} do
    localapi = start_localapi(base, mode: {:reject, 403, "dial forbidden"}, parent: self())
    remote = start_bridge(base, localapi, @host, 443)
    bridge_path = TailnetDial.socket_path(remote.name, Path.join(base, "data"))

    assert {:error, _reason} = request_via_bridge(bridge_path, @host, 443)
    assert_receive {:dial_request, _request}, 5_000

    assert eventually(fn ->
             TailnetDial.last_error(remote.name) ==
               {:tailnet_dial, :localapi_status, {:http_status, 403, "dial forbidden"}}
           end)

    assert %{bridges: [%{status: "error", error_stage: "localapi_status"}]} = TailnetDial.status()
  end

  test "private dial transport errors retain the LocalAPI cause across request APIs", %{
    base: base
  } do
    localapi = start_localapi(base, mode: {:reject, 403, "dial forbidden"}, parent: self())
    previous_socket = Application.get_env(:shuttle, :tailscale_socket)
    previous_proxy = Application.get_env(:shuttle, :https_proxy)
    Application.put_env(:shuttle, :tailscale_socket, localapi)
    Application.put_env(:shuttle, :https_proxy, false)

    on_exit(fn ->
      restore_app_env(:tailscale_socket, previous_socket)
      restore_app_env(:https_proxy, previous_proxy)
    end)

    remote = start_bridge(base, localapi, @host, 443)
    url = "https://#{@host}/api/v1/version"

    assert_private_dial_error(Shuttle.RemoteRegistry.Client.Default.get(url, 1_000))

    assert_private_dial_error(
      Shuttle.RemoteRegistry.Client.Default.get(url, [{"if-none-match", "etag"}], 1_000)
    )

    assert_private_dial_error(
      Shuttle.RemoteRegistry.Client.Default.post(url, "{}", "application/json", 1_000)
    )

    assert_private_dial_error(Shuttle.RemoteRegistry.Client.Default.get_file(url, 1_000))
    assert_private_dial_error(Shuttle.RemoteRegistry.Client.Default.get_file(url, [], 1_000))

    assert TailnetDial.last_error(remote.name) ==
             {:tailnet_dial, :localapi_status, {:http_status, 403, "dial forbidden"}}
  end

  test "a 101 without the ts-dial upgrade is refused", %{base: base} do
    localapi = start_localapi(base, mode: :bad_upgrade, parent: self())
    remote = start_bridge(base, localapi, @host, 443)
    bridge_path = TailnetDial.socket_path(remote.name, Path.join(base, "data"))

    assert {:error, _reason} = request_via_bridge(bridge_path, @host, 443)
    assert_receive {:dial_request, _request}, 5_000

    assert eventually(fn ->
             TailnetDial.last_error(remote.name) ==
               {:tailnet_dial, :localapi_upgrade, :invalid_upgrade_headers}
           end)

    refute_receive {:https_request, _}, 100
  end

  test "TLS hostname verification rejects a certificate for another SNI", %{
    base: base,
    tls_port: tls_port
  } do
    certs = test_cacerts()
    previous = Application.get_env(:shuttle, :tailnet_dial_cacerts)
    Application.put_env(:shuttle, :tailnet_dial_cacerts, certs)
    on_exit(fn -> restore_cacerts(previous) end)

    wrong_host = "wrong.example.ts.net"
    localapi = start_localapi(base, mode: :relay, tls_port: tls_port, parent: self())
    remote = start_bridge(base, localapi, wrong_host, tls_port)
    bridge_path = TailnetDial.socket_path(remote.name, Path.join(base, "data"))

    assert {:error, _reason} = request_via_bridge(bridge_path, wrong_host, tls_port)

    assert eventually(fn ->
             match?({:tailnet_dial, :tls, _}, TailnetDial.last_error(remote.name))
           end)

    assert {:tailnet_dial, :tls, reason} = TailnetDial.last_error(remote.name)
    assert inspect(reason) =~ "hostname_check_failed"
    refute_receive {:https_request, _}, 100
  end

  test "fleet token changes add, replace, and remove per-remote bridges", %{base: base} do
    remote_file = Path.join(base, "remotes.json")
    localapi = Path.join(base, "localapi.sock")
    previous_file = System.get_env("FELT_REMOTES_FILE")
    previous_remotes = Application.get_env(:shuttle, :remotes)
    previous_socket = Application.get_env(:shuttle, :tailscale_socket)
    System.put_env("FELT_REMOTES_FILE", remote_file)
    Application.delete_env(:shuttle, :remotes)
    Application.delete_env(:shuttle, :tailscale_socket)
    write_fleet(remote_file, localapi, [{"hub-a", "hub-a.example.ts.net"}])

    on_exit(fn ->
      restore_env("FELT_REMOTES_FILE", previous_file)
      restore_app_env(:remotes, previous_remotes)
      restore_app_env(:tailscale_socket, previous_socket)
    end)

    {:ok, manager} = TailnetDial.start_link(data_dir: Path.join(base, "data"))
    Process.unlink(manager)
    on_exit(fn -> if Process.alive?(manager), do: Supervisor.stop(manager, :normal) end)

    assert eventually(
             fn -> is_binary(TailnetDial.socket_for("hub-a.example.ts.net", 443)) end,
             400
           )

    first_path = TailnetDial.socket_for("hub-a.example.ts.net", 443)

    assert %{configured: true, socket: ^localapi, bridges: [%{name: "hub-a", status: "ready"}]} =
             TailnetDial.status()

    first_pid = TailnetDial.bridge_pid("hub-a")
    assert is_pid(first_pid)

    assert :ok =
             DynamicSupervisor.terminate_child(Shuttle.TailnetDial.DynamicSupervisor, first_pid)

    write_fleet(remote_file, localapi, [
      {"hub-a", "hub-b.example.ts.net"},
      {"hub-b", "hub-c.example.ts.net"}
    ])

    send(Shuttle.TailnetDial.Reconciler, :refresh)

    assert eventually(
             fn ->
               TailnetDial.socket_for("hub-a.example.ts.net", 443) == nil and
                 TailnetDial.socket_for("hub-b.example.ts.net", 443) == first_path and
                 is_binary(TailnetDial.socket_for("hub-c.example.ts.net", 443))
             end,
             400
           )

    second_path = TailnetDial.socket_for("hub-c.example.ts.net", 443)

    write_fleet(remote_file, localapi, [])

    assert eventually(
             fn ->
               TailnetDial.socket_for("hub-b.example.ts.net", 443) == nil and
                 TailnetDial.socket_for("hub-c.example.ts.net", 443) == nil and
                 File.lstat(first_path) == {:error, :enoent} and
                 File.lstat(second_path) == {:error, :enoent}
             end,
             400
           )
  end

  test "the bridge refuses a traversable socket directory with Host's refusal", %{base: base} do
    data_dir = Path.join(base, "data")
    dial_dir = Path.join([data_dir, "sock", "dial"])
    File.mkdir_p!(dial_dir)
    File.chmod!(dial_dir, 0o755)
    localapi = Path.join(base, "localapi.sock")
    remote = remote(@host, 443)

    assert {:ok, manager} =
             TailnetDial.start_link(
               remotes: [remote],
               tailscale_socket: localapi,
               data_dir: data_dir,
               refresh?: false
             )

    Process.unlink(manager)
    on_exit(fn -> if Process.alive?(manager), do: Supervisor.stop(manager, :normal) end)
    path = TailnetDial.socket_path(remote.name, data_dir)

    assert eventually(fn ->
             match?({:tailnet_dial, :listen, _}, TailnetDial.last_error(remote.name))
           end)

    assert {:ok, %File.Stat{mode: mode}} = File.stat(dial_dir)
    assert Bitwise.band(mode, 0o777) == 0o755
    refute File.exists?(path)

    assert {:tailnet_dial, :listen, reason} = TailnetDial.last_error(remote.name)
    assert inspect(reason) =~ "refusing to listen in socket directory"
    assert inspect(reason) =~ "0755"
  end

  defp start_bridge(base, localapi, host, port, opts \\ []) do
    remote = remote(host, port, opts)
    data_dir = Path.join(base, "data")

    {:ok, manager} =
      TailnetDial.start_link(
        remotes: [remote],
        tailscale_socket: localapi,
        data_dir: data_dir,
        refresh?: false
      )

    Process.unlink(manager)
    on_exit(fn -> if Process.alive?(manager), do: Supervisor.stop(manager, :normal) end)
    socket = TailnetDial.socket_for(host, port)
    assert is_binary(socket)
    assert {:ok, %File.Stat{type: :other}} = File.lstat(socket)
    remote
  end

  defp remote(host, port, opts \\ []) do
    %Remote{
      name: "hub-a",
      url: "https://#{host}:#{port}",
      request_timeout_ms: Keyword.get(opts, :request_timeout_ms, 2_000),
      tunnel: %{manager: :none, multiplex: false, label: nil}
    }
  end

  defp request_via_bridge(path, host, port, timeout_ms \\ 5_000) do
    case :inets.start(:httpc, profile: @profile) do
      {:ok, _pid} -> :ok
      {:error, {:already_started, _pid}} -> :ok
    end

    :ok =
      :httpc.set_options([ipfamily: :local, unix_socket: String.to_charlist(path)], @profile)

    url = "http://#{host}:#{port}/api/v1/version"

    :httpc.request(
      :get,
      {String.to_charlist(url), []},
      [{:timeout, timeout_ms}, {:connect_timeout, timeout_ms}],
      [body_format: :binary],
      @profile
    )
  end

  defp start_silent_tls_peer(_base, opts \\ []) do
    parent = self()

    pid =
      spawn(fn ->
        {:ok, listener} =
          :ssl.listen(0, [
            :binary,
            active: false,
            certfile: String.to_charlist(@cert),
            keyfile: String.to_charlist(@key),
            ip: {127, 0, 0, 1},
            reuseaddr: true
          ])

        {:ok, {{127, 0, 0, 1}, port}} = :ssl.sockname(listener)
        send(parent, {:silent_tls_peer_ready, self(), port})
        {:ok, transport} = :ssl.transport_accept(listener, 5_000)
        {:ok, socket} = :ssl.handshake(transport, 5_000)
        send(parent, {:silent_tls_handshake, self()})

        if Keyword.get(opts, :close_write?, false) do
          :ok = :ssl.shutdown(socket, :write)
          send(parent, {:silent_tls_write_closed, self()})
        end

        receive do
          :stop -> :ssl.close(socket)
        end

        :ssl.close(listener)
      end)

    assert_receive {:silent_tls_peer_ready, ^pid, port}, 5_000
    on_exit(fn -> if Process.alive?(pid), do: Process.exit(pid, :kill) end)
    {port, pid}
  end

  defp start_localapi(base, opts) do
    path = Path.join(base, "localapi.sock")

    {:ok, listener} =
      :gen_tcp.listen(0, [
        :binary,
        active: false,
        packet: :raw,
        ifaddr: {:local, path},
        backlog: 10
      ])

    pid = spawn(fn -> fake_localapi_accept(listener, opts) end)

    on_exit(fn ->
      :gen_tcp.close(listener)
      Process.exit(pid, :kill)
    end)

    path
  end

  defp fake_localapi_accept(listener, opts) do
    case :gen_tcp.accept(listener) do
      {:ok, socket} ->
        pid =
          spawn(fn ->
            receive do
              :ready -> fake_localapi_connection(socket, opts)
            end
          end)

        :ok = :gen_tcp.controlling_process(socket, pid)
        send(pid, :ready)
        fake_localapi_accept(listener, opts)

      {:error, :closed} ->
        :ok
    end
  end

  defp fake_localapi_connection(socket, opts) do
    request = recv_until_headers(socket, "")
    send(Keyword.fetch!(opts, :parent), {:dial_request, request})

    case Keyword.fetch!(opts, :mode) do
      {:reject, status, body} ->
        :ok =
          :gen_tcp.send(
            socket,
            "HTTP/1.1 #{status} Forbidden\r\ncontent-length: #{byte_size(body)}\r\nconnection: close\r\n\r\n#{body}"
          )

        :gen_tcp.close(socket)

      :bad_upgrade ->
        :ok =
          :gen_tcp.send(
            socket,
            "HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: upgrade\r\n\r\n"
          )

        :gen_tcp.close(socket)

      :relay ->
        :ok =
          :gen_tcp.send(
            socket,
            "HTTP/1.1 101 Switching Protocols\r\nupgrade: ts-dial\r\nconnection: upgrade\r\n\r\n"
          )

        {:ok, upstream} =
          :gen_tcp.connect({127, 0, 0, 1}, Keyword.fetch!(opts, :tls_port), [
            :binary,
            active: false,
            packet: :raw
          ])

        parent = Keyword.fetch!(opts, :parent)
        send(parent, {:localapi_relay_pid, self()})
        relay(socket, upstream, parent)
    end
  end

  defp recv_until_headers(socket, acc) do
    case :gen_tcp.recv(socket, 0, 5_000) do
      {:ok, data} ->
        next = acc <> data
        if String.contains?(next, "\r\n\r\n"), do: next, else: recv_until_headers(socket, next)

      {:error, reason} ->
        raise "LocalAPI request failed: #{inspect(reason)}"
    end
  end

  defp relay(left, right, parent) do
    :ok = :inet.setopts(left, active: :once)
    :ok = :inet.setopts(right, active: :once)
    relay(left, right, parent, true, true, false)
  end

  defp relay(_left, _right, _parent, false, false, _held?), do: :ok

  defp relay(left, right, parent, left_open?, right_open?, held?) do
    receive do
      :hold ->
        send(parent, {:localapi_relay_held, self()})
        relay(left, right, parent, left_open?, right_open?, true)

      {:tcp, ^left, _data} when held? ->
        relay(left, right, parent, left_open?, right_open?, held?)

      {:tcp, ^right, _data} when held? ->
        relay(left, right, parent, left_open?, right_open?, held?)

      {:tcp, ^left, data} ->
        case :gen_tcp.send(right, data) do
          :ok ->
            if left_open?, do: :inet.setopts(left, active: :once)
            relay(left, right, parent, left_open?, right_open?, held?)

          {:error, :closed} ->
            :ok

          {:error, reason} ->
            raise "LocalAPI relay send failed: #{inspect(reason)}"
        end

      {:tcp, ^right, data} ->
        case :gen_tcp.send(left, data) do
          :ok ->
            if right_open?, do: :inet.setopts(right, active: :once)
            relay(left, right, parent, left_open?, right_open?, held?)

          {:error, :closed} ->
            :ok

          {:error, reason} ->
            raise "LocalAPI relay send failed: #{inspect(reason)}"
        end

      {:tcp_closed, ^left} when held? ->
        relay(left, right, parent, false, right_open?, held?)

      {:tcp_closed, ^left} ->
        _ = :gen_tcp.shutdown(right, :write)
        relay(left, right, parent, false, right_open?, held?)

      {:tcp_closed, ^right} ->
        _ = :gen_tcp.shutdown(left, :write)
        relay(left, right, parent, left_open?, false, held?)

      {:tcp_error, _socket, reason} ->
        raise "LocalAPI relay failed: #{inspect(reason)}"
    end
  end

  defp assert_private_dial_error(
         {:error,
          {:tailnet_dial, :localapi_status,
           %{httpc: httpc_reason, bridge: {:http_status, 403, "dial forbidden"}}}}
       ) do
    refute is_nil(httpc_reason)
  end

  defp assert_private_dial_error(result),
    do: flunk("expected private LocalAPI transport cause, got: #{inspect(result)}")

  defp test_cacerts do
    [{:Certificate, der, :not_encrypted}] = :public_key.pem_decode(File.read!(@ca))
    [der]
  end

  defp write_fleet(path, localapi, remotes) do
    document = %{
      "version" => 1,
      "defaults" => %{"tailscale_socket" => localapi},
      "remotes" =>
        Enum.map(remotes, fn {name, host} -> %{"name" => name, "url" => "https://#{host}"} end)
    }

    File.write!(path, Jason.encode!(document))
  end

  defp restore_env(name, nil), do: System.delete_env(name)
  defp restore_env(name, value), do: System.put_env(name, value)

  defp restore_app_env(name, nil), do: Application.delete_env(:shuttle, name)
  defp restore_app_env(name, value), do: Application.put_env(:shuttle, name, value)

  defp restore_cacerts(nil), do: Application.delete_env(:shuttle, :tailnet_dial_cacerts)
  defp restore_cacerts(value), do: Application.put_env(:shuttle, :tailnet_dial_cacerts, value)

  defp eventually(fun, attempts \\ 100)
  defp eventually(_fun, 0), do: false

  defp eventually(fun, attempts) do
    if fun.(),
      do: true,
      else:
        (
          Process.sleep(10)
          eventually(fun, attempts - 1)
        )
  end
end
