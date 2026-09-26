defmodule ShuttleWeb.PeerGatePlugTest do
  use ExUnit.Case, async: false

  import Plug.Test

  alias ShuttleWeb.PeerGatePlug
  alias ShuttleWeb.PeerPlug

  @loopback {127, 0, 0, 1}
  @expected_uid 1000

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
  test "a real Bandit TCP listener gates requests by the proc-resolved uid" do
    {uid_text, 0} = System.cmd("id", ["-u"])
    uid = String.to_integer(String.trim(uid_text))
    port = unused_port()
    keys = [:listen, :host_class, :peer_gate, :peer_gate_expected_uid, :peer_gate_uid_source]
    previous = Map.new(keys, &{&1, Application.fetch_env(:shuttle, &1)})

    on_exit(fn ->
      Enum.each(previous, fn
        {key, {:ok, value}} -> Application.put_env(:shuttle, key, value)
        {key, :error} -> Application.delete_env(:shuttle, key)
      end)
    end)

    Application.put_env(:shuttle, :listen, "tcp://127.0.0.1:#{port}")
    Application.put_env(:shuttle, :host_class, :shared_multi_user)
    Application.put_env(:shuttle, :peer_gate, "uid")
    Application.put_env(:shuttle, :peer_gate_expected_uid, uid)
    Application.put_env(:shuttle, :peer_gate_uid_source, "euid")

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

    Application.put_env(:shuttle, :peer_gate_expected_uid, uid + 1)
    {refused_head, refused_body} = request_version(port)

    assert refused_head =~ "HTTP/1.1 403"
    assert Jason.decode!(refused_body)["error"] == "peer_refused"
  end

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
