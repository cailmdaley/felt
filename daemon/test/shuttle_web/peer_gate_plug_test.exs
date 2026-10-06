defmodule ShuttleWeb.PeerGatePlugTest do
  use ExUnit.Case, async: true

  import ExUnit.CaptureLog
  import Plug.Test

  alias ShuttleWeb.PeerGatePlug
  alias ShuttleWeb.PeerPlug

  @loopback {127, 0, 0, 1}
  @expected_uid 1000
  @linux_root_skip_message (case System.cmd("id", ["-u"]) do
                              {uid, 0} ->
                                if String.trim(uid) == "0",
                                  do: "real-listener gate test requires a non-root uid",
                                  else: false

                              _ ->
                                false
                            end)

  defp call_gate(uid, class \\ :shared_multi_user, transport \\ :tcp, login \\ nil) do
    peer_data =
      case transport do
        :tcp -> %{address: @loopback, port: 43_210, ssl_cert: nil}
        :unix -> %{address: {:local, ""}, port: 0, ssl_cert: nil}
      end

    conn =
      conn(:get, "/")
      |> put_peer_data(peer_data)
      |> maybe_add_login(login)
      |> PeerPlug.call(uid_resolver: fn _peer, _listen -> uid end)

    PeerGatePlug.call(conn, host_class: class, expected_uid: @expected_uid)
  end

  defp maybe_add_login(conn, nil), do: conn

  defp maybe_add_login(conn, login),
    do: Plug.Conn.put_req_header(conn, "tailscale-user-login", login)

  test "admits the daemon uid and retains the forwarded login" do
    conn = call_gate(@expected_uid, :shared_multi_user, :tcp, "user@example.com")

    refute conn.halted
    assert conn.assigns.peer.tailscale_login == "user@example.com"
  end

  test "refuses every peer when no expected uid is configured (fails closed)" do
    conn =
      conn(:get, "/")
      |> put_peer_data(%{address: @loopback, port: 43_210, ssl_cert: nil})
      |> PeerPlug.call(uid_resolver: fn _peer, _listen -> @expected_uid end)
      |> PeerGatePlug.call(host_class: :shared_multi_user, expected_uid: nil)

    assert conn.halted
    assert conn.status == 403
  end

  test "root has no admission exception" do
    conn = call_gate(0)

    assert conn.halted
    assert conn.status == 403
    assert Jason.decode!(conn.resp_body)["reason"] == "uid 0 is not the daemon's uid 1000"
  end

  test "throttles refusal warnings by uid for 60 seconds" do
    uid = 2_000_000 + System.unique_integer([:positive])
    first_log = capture_log(fn -> call_gate(uid) end)
    second_log = capture_log(fn -> call_gate(uid) end)

    assert first_log =~ "refused TCP peer"
    refute second_log =~ "refused TCP peer"

    interval_uid = uid + 1_000_000_000
    assert ShuttleWeb.PeerGateThrottle.allow_warning?(interval_uid, 0)
    refute ShuttleWeb.PeerGateThrottle.allow_warning?(interval_uid, 59_999)
    assert ShuttleWeb.PeerGateThrottle.allow_warning?(interval_uid, 60_000)
  end

  # Negative control: remove allow_warning?/2's ArgumentError rescue and this call raises.
  test "allows a refusal warning when the throttle table is missing" do
    :ok = Supervisor.terminate_child(Shuttle.Supervisor, ShuttleWeb.PeerGateThrottle)

    try do
      uid = System.unique_integer([:positive])
      assert ShuttleWeb.PeerGateThrottle.allow_warning?(uid)
    after
      {:ok, _pid} = Supervisor.restart_child(Shuttle.Supervisor, ShuttleWeb.PeerGateThrottle)
    end
  end

  test "refuses a foreign uid with a JSON 403" do
    conn = call_gate(2000, :exposed, :tcp, "forged@example.com")

    assert conn.halted
    assert conn.status == 403

    assert Jason.decode!(conn.resp_body) == %{
             "error" => "peer_refused",
             "reason" => "uid 2000 is not the daemon's uid 1000"
           }
  end

  test "refuses an unresolved uid" do
    conn = call_gate(nil)

    assert conn.halted
    assert conn.status == 403

    assert Jason.decode!(conn.resp_body) == %{
             "error" => "peer_refused",
             "reason" => "peer uid unresolved: no matching /proc TCP row"
           }
  end

  test "does not gate TCP on a single-user host" do
    conn = call_gate(2000, :single_user, :tcp, "untrusted@example.com")

    refute conn.halted
    assert conn.status == nil
    assert conn.assigns.peer.tailscale_login == nil
  end

  test "does not gate unix peers" do
    conn = call_gate(nil, :shared_multi_user, :unix, "socket-user@example.com")

    refute conn.halted
    assert conn.status == nil
    assert conn.assigns.peer.tailscale_login == "socket-user@example.com"
  end

  @tag :linux
  @tag skip: @linux_root_skip_message
  test "a real Bandit TCP listener gates requests by the proc-resolved uid" do
    {uid_text, 0} = System.cmd("id", ["-u"])
    uid = String.to_integer(String.trim(uid_text))
    refute uid == 0
    port = unused_port()
    Shuttle.Test.Env.put_app_env(:listen, "tcp://127.0.0.1:#{port}")
    Shuttle.Test.Env.put_app_env(:host_class, :shared_multi_user)
    Shuttle.Test.Env.put_app_env(:peer_gate, "uid")
    Shuttle.Test.Env.put_app_env(:peer_gate_expected_uid, uid)
    Shuttle.Test.Env.put_app_env(:peer_gate_uid_source, "euid")

    {:ok, server} =
      Bandit.start_link(
        plug: ShuttleWeb.Endpoint,
        ip: @loopback,
        port: port,
        startup_log: false
      )

    on_exit(fn -> Process.exit(server, :normal) end)

    {allowed_head, allowed_body} = request_version(port)
    assert allowed_head =~ "HTTP/1.1 200"

    assert %{
             "peer_gate" => "uid",
             "peer_gate_uid" => ^uid,
             "peer_gate_uid_source" => "euid"
           } = Jason.decode!(allowed_body)

    Shuttle.Test.Env.put_app_env(:peer_gate_expected_uid, uid + 1)
    {refused_head, refused_body} = request_version(port)

    assert refused_head =~ "HTTP/1.1 403"
    assert Jason.decode!(refused_body)["error"] == "peer_refused"
  end

  @tag :tmp_dir
  test "the endpoint's Bandit options keep a resolved uid for the whole keep-alive connection",
       %{tmp_dir: root} do
    table = Path.join([root, "net", "tcp"])
    File.mkdir_p!(Path.dirname(table))
    port = unused_port()
    Shuttle.Test.Env.put_app_env(:listen, "tcp://127.0.0.1:#{port}")
    Shuttle.Test.Env.put_app_env(:host_class, :shared_multi_user)
    Shuttle.Test.Env.put_app_env(:peer_gate, "uid")
    Shuttle.Test.Env.put_app_env(:peer_gate_expected_uid, 4321)
    Shuttle.Test.Env.put_app_env(:proc_net_root, root)

    http_1_options =
      :shuttle
      |> Application.fetch_env!(ShuttleWeb.Endpoint)
      |> Keyword.fetch!(:http)
      |> Keyword.get(:http_1_options, [])

    {:ok, server} =
      Bandit.start_link(
        plug: ShuttleWeb.Endpoint,
        ip: @loopback,
        port: port,
        http_1_options: http_1_options,
        startup_log: false
      )

    on_exit(fn -> Process.exit(server, :normal) end)

    header =
      "  sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n"

    {:ok, socket} = :gen_tcp.connect(@loopback, port, [:binary, active: false], 2_000)
    {:ok, {_address, client_port}} = :inet.sockname(socket)

    File.write!(
      table,
      header <>
        "  0: #{proc_hex(@loopback)}:#{port_hex(client_port)} #{proc_hex(@loopback)}:#{port_hex(port)} 01 00000000:00000000 00:00000000 00000000 4321 0 10001 1\n"
    )

    assert keepalive_status(socket) == 200

    # The row is gone; the same connection is still admitted, a new one is not.
    File.write!(table, header)
    assert keepalive_status(socket) == 200
    :ok = :gen_tcp.close(socket)

    capture_log(fn ->
      {refused_head, _body} = request_version(port)
      assert refused_head =~ "HTTP/1.1 403"
    end)
  end

  defp keepalive_status(socket) do
    :ok =
      :gen_tcp.send(socket, "GET /api/v1/version HTTP/1.1\r\nhost: localhost\r\n\r\n")

    {:ok, <<"HTTP/1.1 ", status::binary-size(3), _rest::binary>>} =
      :gen_tcp.recv(socket, 0, 2_000)

    drain(socket)
    String.to_integer(status)
  end

  defp drain(socket) do
    case :gen_tcp.recv(socket, 0, 200) do
      {:ok, _data} -> drain(socket)
      {:error, :timeout} -> :ok
    end
  end

  defp proc_hex(address) do
    bytes = Tuple.to_list(address)
    bytes = if :erlang.system_info(:endian) == :little, do: Enum.reverse(bytes), else: bytes
    Enum.map_join(bytes, &(Integer.to_string(&1, 16) |> String.pad_leading(2, "0")))
  end

  defp port_hex(port), do: port |> Integer.to_string(16) |> String.pad_leading(4, "0")

  defp unused_port do
    {:ok, socket} = :gen_tcp.listen(0, [:binary, active: false, ip: @loopback])
    {:ok, {@loopback, port}} = :inet.sockname(socket)
    :ok = :gen_tcp.close(socket)
    port
  end

  defp request_version(port) do
    {:ok, socket} = :gen_tcp.connect(@loopback, port, [:binary, active: false], 2_000)

    :ok =
      :gen_tcp.send(
        socket,
        "GET /api/v1/version HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n"
      )

    response = recv_all(socket, "")
    :ok = :gen_tcp.close(socket)
    [head, body] = String.split(response, "\r\n\r\n", parts: 2)
    {head, body}
  end

  defp recv_all(socket, acc) do
    case :gen_tcp.recv(socket, 0, 2_000) do
      {:ok, data} -> recv_all(socket, acc <> data)
      {:error, :closed} -> acc
    end
  end
end
