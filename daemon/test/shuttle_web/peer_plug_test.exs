defmodule ShuttleWeb.PeerPlugTest do
  use ExUnit.Case, async: false
  import Plug.Test

  alias ShuttleWeb.PeerPlug

  @loopback {127, 0, 0, 1}

  defp peer(conn, opts \\ []) do
    opts = Keyword.put_new(opts, :uid_resolver, fn _peer_data, _listen -> nil end)
    PeerPlug.call(conn, PeerPlug.init(opts)).assigns.peer
  end

  describe "on loopback tcp" do
    test "a direct request is tcp and unforwarded" do
      assert peer(conn(:get, "/")) == %{
               transport: :tcp,
               uid: nil,
               forwarded: false,
               tailscale_login: nil
             }
    end

    test "a tailscale login header is recorded as forwarded but never trusted" do
      conn =
        conn(:get, "/")
        |> Plug.Conn.put_req_header("tailscale-user-login", "someone@example.com")

      assert peer(conn) == %{
               transport: :tcp,
               uid: nil,
               forwarded: true,
               tailscale_login: nil
             }
    end

    test "records a uid resolved for the TCP peer" do
      resolver = fn _peer_data, listen ->
        assert listen == Shuttle.listen()
        42
      end

      assert peer(conn(:get, "/"), uid_resolver: resolver).uid == 42
    end

    @tag :tmp_dir
    test "uses the configured proc root when none is passed to the plug", %{tmp_dir: root} do
      net_dir = Path.join(root, "net")
      File.mkdir_p!(net_dir)
      {:ok, {:tcp, listen_address, listen_port}} = Shuttle.Host.parse_listen(Shuttle.listen())
      assert listen_address == @loopback
      address = proc_ipv4(@loopback)
      peer_port = 54_321

      listen_port_hex =
        listen_port |> Integer.to_string(16) |> String.upcase() |> String.pad_leading(4, "0")

      File.write!(
        Path.join(net_dir, "tcp"),
        "  sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n" <>
          "  0: #{address}:D431 #{address}:#{listen_port_hex} 01 00000000:00000000 00:00000000 00000000 4321 0 10001 1\n"
      )

      previous = Application.fetch_env(:shuttle, :proc_net_root)
      Application.put_env(:shuttle, :proc_net_root, root)

      on_exit(fn ->
        case previous do
          {:ok, value} -> Application.put_env(:shuttle, :proc_net_root, value)
          :error -> Application.delete_env(:shuttle, :proc_net_root)
        end
      end)

      conn =
        conn(:get, "/") |> put_peer_data(%{address: @loopback, port: peer_port, ssl_cert: nil})

      resolved = PeerPlug.call(conn, host_class: :shared_multi_user)

      assert resolved.assigns.peer.uid == 4321
    end

    for header <- ["x-forwarded-for", "x-forwarded-host", "forwarded", "tailscale-user-name"] do
      test "#{header} marks the request forwarded" do
        conn = conn(:get, "/") |> Plug.Conn.put_req_header(unquote(header), "x")
        assert peer(conn).forwarded
      end
    end
  end

  defp proc_ipv4(address) do
    bytes = Tuple.to_list(address)
    bytes = if :erlang.system_info(:endian) == :little, do: Enum.reverse(bytes), else: bytes

    bytes
    |> Enum.map(&(Integer.to_string(&1, 16) |> String.pad_leading(2, "0")))
    |> Enum.join()
    |> String.upcase()
  end

  describe "on a unix socket" do
    defp unix_conn,
      do: conn(:get, "/") |> put_peer_data(%{address: {:local, ""}, port: 0, ssl_cert: nil})

    test "the transport is unix" do
      assert peer(unix_conn()) == %{
               transport: :unix,
               uid: nil,
               forwarded: false,
               tailscale_login: nil
             }
    end

    test "the tailscale login header is recorded (not trusted; nothing reads it yet)" do
      conn = Plug.Conn.put_req_header(unix_conn(), "tailscale-user-login", "someone@example.com")

      assert peer(conn) == %{
               transport: :unix,
               uid: nil,
               forwarded: true,
               tailscale_login: "someone@example.com"
             }
    end
  end

  describe "through a real Bandit unix listener" do
    # What Bandit actually reports for a `{:local, path}` listener, measured
    # rather than assumed — the moduledoc's claim rests on this test.
    defmodule Echo do
      @moduledoc false
      @behaviour Plug

      @impl true
      def init(opts), do: opts

      @impl true
      def call(conn, _opts) do
        conn = PeerPlug.call(conn, [])

        body =
          :erlang.term_to_binary(%{
            peer_data: Plug.Conn.get_peer_data(conn),
            remote_ip: conn.remote_ip,
            peer: conn.assigns.peer
          })

        Plug.Conn.send_resp(conn, 200, body)
      end
    end

    setup do
      path = "/tmp/shuttle-peer-#{System.unique_integer([:positive])}.sock"

      {:ok, server} =
        Bandit.start_link(plug: Echo, ip: {:local, path}, port: 0, startup_log: false)

      on_exit(fn ->
        Process.exit(server, :normal)
        File.rm(path)
      end)

      {:ok, path: path}
    end

    test "get_peer_data reports an unnamed local address", %{path: path} do
      reply =
        request(
          path,
          "GET / HTTP/1.1\r\nhost: localhost\r\n" <>
            "tailscale-user-login: someone@example.com\r\nconnection: close\r\n\r\n"
        )

      assert %{
               peer_data: %{address: {:local, ""}, port: 0, ssl_cert: nil},
               remote_ip: {:local, ""},
               peer: %{
                 transport: :unix,
                 forwarded: true,
                 tailscale_login: "someone@example.com"
               }
             } = reply
    end

    defp request(path, raw) do
      {:ok, socket} = :gen_tcp.connect({:local, path}, 0, [:binary, active: false], 2_000)
      :ok = :gen_tcp.send(socket, raw)
      response = recv_all(socket, "")
      :gen_tcp.close(socket)

      [_head, body] = String.split(response, "\r\n\r\n", parts: 2)
      :erlang.binary_to_term(body)
    end

    defp recv_all(socket, acc) do
      case :gen_tcp.recv(socket, 0, 2_000) do
        {:ok, data} -> recv_all(socket, acc <> data)
        {:error, :closed} -> acc
      end
    end
  end

  describe "the endpoint over a unix socket" do
    # The whole pipeline, CORS included: a client dialing the socket sends
    # `Host: localhost`, which the loopback authority check accepts.
    setup do
      path = "/tmp/shuttle-ep-#{System.unique_integer([:positive])}.sock"

      {:ok, server} =
        Bandit.start_link(
          plug: ShuttleWeb.Endpoint,
          ip: {:local, path},
          port: 0,
          startup_log: false
        )

      on_exit(fn ->
        Process.exit(server, :normal)
        File.rm(path)
      end)

      {:ok, path: path}
    end

    test "GET /api/v1/version answers with listen and host_class", %{path: path} do
      {:ok, socket} = :gen_tcp.connect({:local, path}, 0, [:binary, active: false], 2_000)

      :ok =
        :gen_tcp.send(
          socket,
          "GET /api/v1/version HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n"
        )

      response = recv_all(socket, "")
      [head, body] = String.split(response, "\r\n\r\n", parts: 2)
      assert head =~ "HTTP/1.1 200"

      decoded = Jason.decode!(body)
      assert decoded["listen"] == Shuttle.listen()
      assert decoded["host_class"] == "single-user"
    end
  end
end
