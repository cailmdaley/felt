defmodule Shuttle.RemoteRegistry.ClientTest do
  @moduledoc """
  Regression coverage for the real `:httpc`-backed client. The bug: `get/2`
  fetched without `body_format: :binary`, so httpc returned the body as a
  charlist of *bytes* and `List.to_string/1` re-UTF-8-encoded each byte —
  double-encoding every multibyte char (the cmbx "— analysis hub" mojibake on
  the composite board). ASCII (< 128) survived, so the corruption hid until a
  special character appeared. These tests round-trip a real multibyte body
  through a live Bandit server and assert byte-faithfulness.
  """
  use ExUnit.Case, async: true

  alias Shuttle.RemoteRegistry.Client.Default

  # Every request here is expected to finish (or to be refused before any
  # I/O), so its timeout is reached only when the test is already failing. A
  # loaded machine can keep httpc and the local Bandit server from answering
  # within a couple of seconds; 15 s keeps such a request off the timeout
  # path, under ExUnit's 60 s test timeout.
  @http_timeout_ms 15_000

  defp applied_https_proxy(profile) do
    case :httpc.get_options([:https_proxy], profile) do
      {:ok, [https_proxy: proxy]} -> proxy
      _ -> :no_profile
    end
  end

  # Body with an em-dash (U+2014), multiplication sign (U+00D7), and an accented
  # vowel (U+00E9) — exactly the characters that mojibake'd in the field.
  @utf8_body ~s({"fibers":[{"name":"cmbx — analysis hub","note":"γ×κ Cramér"}]})

  defmodule EchoPlug do
    @moduledoc false
    @behaviour Plug

    @impl true
    def init(opts), do: opts

    @impl true
    def call(conn, opts) do
      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(Keyword.get(opts, :status, 200), Keyword.fetch!(opts, :body))
    end
  end

  setup do
    # Port 0 lets the OS pick: a pinned port makes each test wait for the
    # previous one's listener to be released, and loses the race often enough
    # to fail on :eaddrinuse.
    {:ok, server} =
      Bandit.start_link(
        plug: {EchoPlug, body: @utf8_body},
        port: 0,
        ip: {127, 0, 0, 1}
      )

    {:ok, {_ip, port}} = ThousandIsland.listener_info(server)
    on_exit(fn -> Process.exit(server, :normal) end)
    {:ok, url: "http://127.0.0.1:#{port}/api/v1/fibers"}
  end

  test "get/2 returns the response body byte-for-byte (no double-encoding)", %{url: url} do
    assert {:ok, body} = Default.get(url, @http_timeout_ms)
    # Byte-identical to what the server sent: the em-dash stays \xe2\x80\x94,
    # not the double-encoded \xc3\xa2\xc2\x80\xc2\x94.
    assert body == @utf8_body
    assert String.contains?(body, "cmbx — analysis hub")
    refute String.contains?(body, "Ã¢")
    assert {:ok, %{"fibers" => [%{"name" => "cmbx — analysis hub"}]}} = Jason.decode(body)
  end

  test "get/2 preserves the body of a 503 response" do
    {:ok, server} =
      Bandit.start_link(
        plug: {EchoPlug, body: @utf8_body, status: 503},
        port: 0,
        ip: {127, 0, 0, 1}
      )

    {:ok, {_ip, port}} = ThousandIsland.listener_info(server)
    on_exit(fn -> Process.exit(server, :normal) end)

    assert Default.get("http://127.0.0.1:#{port}/api/v1/state", @http_timeout_ms) ==
             {:error, {:http_status, 503, @utf8_body}}
  end

  defmodule StreamPlug do
    @moduledoc false
    @behaviour Plug

    @impl true
    def init(opts), do: opts

    @impl true
    def call(%{request_path: "/file"} = conn, _opts),
      do: Plug.Conn.send_resp(conn, 200, "file — bytes")

    def call(conn, opts) do
      owner = Keyword.fetch!(opts, :owner)

      conn =
        conn
        |> Plug.Conn.put_resp_content_type("text/event-stream")
        |> Plug.Conn.put_resp_header("cache-control", "no-cache, no-transform")
        |> Plug.Conn.send_chunked(200)

      send(owner, {:stream_server, self(), Plug.Conn.get_req_header(conn, "connection")})

      if Keyword.get(opts, :immediate_body, false) do
        {:ok, conn} = Plug.Conn.chunk(conn, ": open\n\n")
        serve(conn, owner)
      else
        receive do
          :start_body ->
            {:ok, conn} = Plug.Conn.chunk(conn, ": open\n\n")
            serve(conn, owner)
        after
          15_000 -> conn
        end
      end
    end

    defp serve(conn, owner) do
      receive do
        {:emit, token, bytes} ->
          case Plug.Conn.chunk(conn, bytes) do
            {:ok, conn} ->
              send(owner, {:emitted, token})
              serve(conn, owner)

            {:error, reason} ->
              send(owner, {:closed, token, reason})
              conn
          end

        {:probe_closed, token} ->
          probe_closed(conn, owner, token, 100)

        :finish ->
          send(owner, :server_finished)
          conn
      after
        15_000 -> conn
      end
    end

    defp probe_closed(conn, owner, token, remaining) do
      case Plug.Conn.chunk(conn, ": cancelled\n\n") do
        {:error, reason} ->
          send(owner, {:closed, token, reason})
          conn

        {:ok, conn} when remaining > 0 ->
          receive do
          after
            10 -> probe_closed(conn, owner, token, remaining - 1)
          end

        {:ok, conn} ->
          send(owner, {:still_open, token})
          conn
      end
    end
  end

  defp stream_server(opts \\ []) do
    server =
      start_supervised!(
        {Bandit, plug: {StreamPlug, [owner: self()] ++ opts}, port: 0, ip: {127, 0, 0, 1}}
      )

    {:ok, {_ip, port}} = ThousandIsland.listener_info(server)
    "http://127.0.0.1:#{port}"
  end

  defp open_stream(url, connect_timeout \\ @http_timeout_ms) do
    assert {:ok, id} =
             Default.stream_get(
               url,
               [{"accept", "text/event-stream"}, {"Connection", "keep-alive"}],
               self(),
               connect_timeout
             )

    assert_receive {:stream_server, server, ["close"]}, @http_timeout_ms
    assert_receive {:remote_stream, ^id, {:open, headers, cursor}}, @http_timeout_ms
    assert {"content-type", "text/event-stream; charset=utf-8"} in headers
    # Separate headers from the first body bytes to make the credit tests
    # independent of httpc's initial-body buffering and TCP packet boundaries.
    :ok = Default.stream_next(cursor)
    send(server, :start_body)
    assert_receive {:remote_stream, ^id, {:data, ": open\n\n"}}, @http_timeout_ms
    {id, cursor, server}
  end

  defp receive_stream_bytes(_id, _cursor, remaining) when remaining <= 0, do: ""

  defp receive_stream_bytes(id, cursor, remaining) do
    assert_receive {:remote_stream, ^id, {:data, bytes}}, @http_timeout_ms
    :ok = Default.stream_next(cursor)
    bytes <> receive_stream_bytes(id, cursor, remaining - byte_size(bytes))
  end

  describe "streaming transport" do
    test "delivers bytes before completion and waits for stream_next after each data event" do
      {id, cursor, server} = open_stream(stream_server() <> "/stream")

      try do
        for n <- 1..3 do
          bytes = "id: #{n}\ndata: γ×κ — #{n}\n\n"
          token = make_ref()
          send(server, {:emit, token, bytes})
          assert_receive {:emitted, ^token}, @http_timeout_ms
          refute_receive {:remote_stream, ^id, _}, 100
          assert :ok = Default.stream_next(cursor)
          assert_receive {:remote_stream, ^id, {:data, ^bytes}}, @http_timeout_ms
          refute_received :server_finished
        end

        :ok = Default.stream_next(cursor)
        send(server, :finish)
        assert_receive :server_finished, @http_timeout_ms
        assert_receive {:remote_stream, ^id, :done}, @http_timeout_ms
      after
        assert :ok = Default.stream_cancel(id)
        send(server, :finish)
      end
    end

    test "an immediate body arrives intact before completion, independent of TCP chunk boundaries" do
      url = stream_server(immediate_body: true) <> "/stream"
      assert {:ok, id} = Default.stream_get(url, [], self(), @http_timeout_ms)
      assert_receive {:stream_server, server, ["close"]}, @http_timeout_ms
      assert_receive {:remote_stream, ^id, {:open, _headers, cursor}}, @http_timeout_ms

      try do
        :ok = Default.stream_next(cursor)
        token = make_ref()
        send(server, {:emit, token, "data: γ×κ\n\n"})
        assert_receive {:emitted, ^token}, @http_timeout_ms
        body = receive_stream_bytes(id, cursor, byte_size(": open\n\ndata: γ×κ\n\n"))
        assert body == ": open\n\ndata: γ×κ\n\n"
        refute_received :server_finished
      after
        :ok = Default.stream_cancel(id)
        send(server, :finish)
      end
    end

    test "cancel closes the socket, stops delivery and is idempotent" do
      {id, cursor, server} = open_stream(stream_server() <> "/stream")
      monitor = Process.monitor(cursor)
      assert :ok = Default.stream_cancel(id)
      assert :ok = Default.stream_cancel(id)
      assert_receive {:DOWN, ^monitor, :process, ^cursor, _}, @http_timeout_ms
      token = make_ref()
      send(server, {:probe_closed, token})
      assert_receive {:closed, ^token, _reason}, @http_timeout_ms
      assert :ok = Default.stream_next(cursor)
      refute_receive {:remote_stream, ^id, {:data, _}}, 100
    end

    @tag :timing
    test "an open stream does not stall a concurrent get_file on the same profile" do
      base = stream_server()
      {id, _cursor, server} = open_stream(base <> "/stream")

      try do
        task = Task.async(fn -> Default.get_file(base <> "/file", [], @http_timeout_ms) end)
        assert {:ok, 200, _headers, _type, "file — bytes"} = Task.await(task, 1_000)
        refute_received :server_finished
      after
        :ok = Default.stream_cancel(id)
        send(server, :finish)
      end
    end

    @tag :timing
    test "the connect timeout does not limit the lifetime of an open stream" do
      {id, cursor, server} = open_stream(stream_server() <> "/stream", 500)

      try do
        refute_receive {:remote_stream, ^id, _}, 600
        token = make_ref()
        send(server, {:emit, token, "data: still here\n\n"})
        assert_receive {:emitted, ^token}, @http_timeout_ms
        :ok = Default.stream_next(cursor)
        assert_receive {:remote_stream, ^id, {:data, "data: still here\n\n"}}, @http_timeout_ms
      after
        :ok = Default.stream_cancel(id)
        send(server, :finish)
      end
    end

    test "a non-streamed 404 keeps its status, headers and binary body" do
      server =
        start_supervised!(
          {Bandit, plug: {EchoPlug, body: @utf8_body, status: 404}, port: 0, ip: {127, 0, 0, 1}}
        )

      {:ok, {_ip, port}} = ThousandIsland.listener_info(server)

      assert {:ok, id} =
               Default.stream_get(
                 "http://127.0.0.1:#{port}/missing",
                 [],
                 self(),
                 @http_timeout_ms
               )

      try do
        assert_receive {:remote_stream, ^id, {:response, 404, headers, @utf8_body}},
                       @http_timeout_ms

        assert {"content-type", "application/json; charset=utf-8"} in headers
        refute_received {:remote_stream, ^id, {:open, _, _}}
      after
        :ok = Default.stream_cancel(id)
      end
    end

    test "asynchronous connection failures are sent to the owner" do
      {:ok, listener} = :gen_tcp.listen(0, [:binary, active: false, ip: {127, 0, 0, 1}])
      {:ok, port} = :inet.port(listener)
      :ok = :gen_tcp.close(listener)

      assert {:ok, id} =
               Default.stream_get("http://127.0.0.1:#{port}/stream", [], self(), @http_timeout_ms)

      try do
        assert_receive {:remote_stream, ^id, {:error, _reason}}, @http_timeout_ms
      after
        :ok = Default.stream_cancel(id)
      end
    end

    test "the receiver cannot crash its httpc handler on malformed replies" do
      id = make_ref()

      assert :ok =
               Default.relay_stream_message(
                 {make_ref(), :stream_start, :bad_headers, self()},
                 self(),
                 id
               )

      assert_receive {:remote_stream, ^id, {:error, _}}
    end
  end

  describe "the fleet proxy" do
    test "lands on our proxied profile and nowhere else", %{url: url} do
      # httpc's proxy is per profile, not per request, so the point of owning
      # the profile is that this setting never reaches `:default` and never
      # leaks onto another httpc user in the VM.
      Shuttle.Test.Env.put_app_env(:https_proxy, "127.0.0.1:1055")
      assert {:ok, _} = Default.get(url, @http_timeout_ms)

      assert {{~c"127.0.0.1", 1055}, [~c"localhost", ~c"127.0.0.1", ~c"::1"]} =
               applied_https_proxy(:shuttle_fleet)

      assert {:ok, [https_proxy: {:undefined, []}]} = :httpc.get_options([:https_proxy], :default),
             "the default profile must stay untouched"
    end

    test "clearing it switches profiles instead of stopping one", %{url: url} do
      # The direct profile never carries a proxy, so "no proxy" is a profile
      # CHOICE rather than a reconfiguration. That matters because the only way
      # to unset httpc's proxy is to stop the profile, and stopping one kills
      # every request in flight on it with an exit — which would take down the
      # registry that polls inline in its own GenServer.
      Shuttle.Test.Env.put_app_env(:https_proxy, "127.0.0.1:1055")
      assert {:ok, _} = Default.get(url, @http_timeout_ms)

      Shuttle.Test.Env.put_app_env(:https_proxy, false)
      assert {:ok, body} = Default.get(url, @http_timeout_ms)
      assert body == @utf8_body

      assert {:undefined, []} = applied_https_proxy(:shuttle_fleet_direct)

      # And the proxied profile is still alive, still configured, and still
      # usable the moment the fleet file names a proxy again.
      assert {{~c"127.0.0.1", 1055}, _} = applied_https_proxy(:shuttle_fleet)
    end

    test "an http:// remote is never sent through it", %{url: url} do
      # httpc only consults https_proxy for https URLs, so an ssh-tunnelled
      # remote at http://127.0.0.1:<port> keeps working even when the proxy
      # address points at nothing.
      Shuttle.Test.Env.put_app_env(:https_proxy, "127.0.0.1:9")
      assert {:ok, body} = Default.get(url, @http_timeout_ms)
      assert body == @utf8_body
    end
  end

  describe "the fleet proxy on a host that is not single-user" do
    setup do
      # Port 9 is discard: if the refusal failed and the request went through
      # the proxy, it would come back as a connect error, not the refusal.
      Shuttle.Test.Env.put_app_env(:https_proxy, "127.0.0.1:9")
      :ok
    end

    for {class, name} <- [shared_multi_user: "shared-multi-user", exposed: "exposed"] do
      @class class
      @name name

      test "#{name}: an https request fails with the refusal as its reason" do
        Shuttle.Test.Env.put_app_env(:host_class, @class)
        reason = "https_proxy refused: host class #{@name}"

        assert Default.get("https://hub.example.invalid/api/v1/state", @http_timeout_ms) ==
                 {:error, reason}

        assert Default.get("https://hub.example.invalid/x", [], @http_timeout_ms) ==
                 {:error, reason}

        assert Default.post(
                 "https://hub.example.invalid/x",
                 "{}",
                 "application/json",
                 @http_timeout_ms
               ) ==
                 {:error, reason}

        assert Default.get_file("https://hub.example.invalid/x", @http_timeout_ms) ==
                 {:error, reason}

        assert Default.head_file("https://hub.example.invalid/x", [], @http_timeout_ms) ==
                 {:error, reason}

        assert Default.stream_get("https://hub.example.invalid/x", [], self(), @http_timeout_ms) ==
                 {:error, reason}
      end
    end

    test "an http:// remote still goes direct", %{url: url} do
      Shuttle.Test.Env.put_app_env(:host_class, :shared_multi_user)
      assert {:ok, body} = Default.get(url, @http_timeout_ms)
      assert body == @utf8_body
    end

    test "a single-user host sends https through the proxy" do
      # A fake proxy: accept one connection and report the first bytes httpc
      # sends it. A CONNECT for the remote's authority is the proxy in use.
      Shuttle.Test.Env.put_app_env(:host_class, :single_user)
      {:ok, listener} = :gen_tcp.listen(0, [:binary, active: false, ip: {127, 0, 0, 1}])
      {:ok, port} = :inet.port(listener)
      Shuttle.Test.Env.put_app_env(:https_proxy, "127.0.0.1:#{port}")
      parent = self()

      # Every bound below is reached only on failure: the fake proxy closes the
      # connection as soon as it has read the CONNECT, which ends the request
      # at once. They are generous so a loaded scheduler (httpc's handler must
      # run, dial and write before the request timeout cancels it) cannot fail
      # a request that is going through the proxy.
      Task.start(fn ->
        with {:ok, conn} <- :gen_tcp.accept(listener, 30_000),
             {:ok, data} <- :gen_tcp.recv(conn, 0, 30_000) do
          send(parent, {:proxy_saw, data})
          :gen_tcp.close(conn)
        end
      end)

      result = Default.get("https://hub.example.invalid/api/v1/state", 30_000)

      assert_receive {:proxy_saw, data},
                     30_000,
                     "the proxy saw no request; get returned #{inspect(result)}"

      assert {:error, _} = result
      assert data =~ ~r/\ACONNECT hub\.example\.invalid:443 HTTP\/1\.1\r\n/
      :gen_tcp.close(listener)
    end

    test "an upper-case HTTPS:// scheme is refused like a lower-case one" do
      Shuttle.Test.Env.put_app_env(:host_class, :shared_multi_user)

      assert Default.get("HTTPS://hub.example.invalid/api/v1/state", @http_timeout_ms) ==
               {:error, "https_proxy refused: host class shared-multi-user"}
    end

    test "the refusal surfaces as the remote's last_error in the registry" do
      Shuttle.Test.Env.put_app_env(:host_class, :shared_multi_user)

      remote = %Shuttle.Remote{
        name: "hub-a",
        url: "https://hub-a.example.invalid",
        poll_interval_ms: 1,
        request_timeout_ms: 1_000,
        stale_multiplier: 2,
        tunnel: %{manager: :none, multiplex: false, label: nil}
      }

      {:ok, _pid} =
        Shuttle.RemoteRegistry.start_link(
          name: :reg_proxy_refused,
          remotes: [remote],
          auto_poll: false,
          tick_interval_ms: 60_000
        )

      :ok = Shuttle.RemoteRegistry.poll_now(:reg_proxy_refused)

      hub = Shuttle.RemoteRegistry.snapshot(:reg_proxy_refused, "hub-a")
      assert hub.stale
      assert hub.last_error == "https_proxy refused: host class shared-multi-user"
    end
  end
end
