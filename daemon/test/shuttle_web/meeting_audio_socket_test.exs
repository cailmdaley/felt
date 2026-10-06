defmodule ShuttleWeb.MeetingAudioSocketTest do
  use ExUnit.Case, async: true

  # Socket connect/recv bounds are reached only when the peer never answers, so
  # they are generous: a passing test never waits on them, and a loaded machine
  # can take seconds to schedule the handler. Deliberate "nothing arrives"
  # waits stay short and literal.
  @io_timeout 30_000

  alias ShuttleWeb.MeetingAudioSocket, as: Relay

  # macOS caps a Unix socket path at 104 bytes, so the socket lives in a short
  # directory of its own rather than ExUnit's tmp_dir.
  setup do
    dir =
      Path.join(System.tmp_dir!(), "hk-" <> Integer.to_string(System.unique_integer([:positive])))

    File.mkdir_p!(dir)
    on_exit(fn -> File.rm_rf(dir) end)
    %{path: Path.join(dir, "phone.sock")}
  end

  defp listen(path) do
    {:ok, listener} =
      :gen_tcp.listen(0, [:binary, ifaddr: {:local, path}, active: false, reuseaddr: false])

    listener
  end

  defp accept(listener) do
    {:ok, peer} = :gen_tcp.accept(listener, @io_timeout)
    peer
  end

  defp received(peer, bytes) do
    {:ok, data} = :gen_tcp.recv(peer, bytes, @io_timeout)
    data
  end

  defp json({:text, body}), do: Jason.decode!(body)

  defp resolve_to(answer), do: [resolve: fn -> answer end, retry_ms: 10]

  defp live(path, launch \\ "L1"), do: {:ok, %{path: path, launch: launch}}

  test "connects at once to a listening hark and relays binary frames unchanged", %{path: path} do
    listener = listen(path)

    assert {:push, [status], state} = Relay.init(resolve_to(live(path)))
    assert json(status) == %{"state" => "connected"}
    peer = accept(listener)

    assert {:ok, state} = Relay.handle_in({<<1, 2, 3, 4>>, opcode: :binary}, state)
    assert {:ok, state} = Relay.handle_in({<<5, 6>>, opcode: :binary}, state)
    assert received(peer, 6) == <<1, 2, 3, 4, 5, 6>>

    assert {:ok, ^state} = Relay.handle_in({"hello", opcode: :text}, state)
    assert :ok = Relay.terminate(:normal, state)
    assert {:error, :closed} = :gen_tcp.recv(peer, 0, @io_timeout)
  end

  test "drops audio while hark loads: nothing said before it listens reaches it", %{path: path} do
    assert {:push, [status], state} = Relay.init(resolve_to(live(path)))
    assert %{"state" => "waiting", "reason" => reason} = json(status)
    assert reason =~ "loading"
    assert_receive :retry

    {:ok, state} = Relay.handle_in({"early-", opcode: :binary}, state)
    {:ok, state} = Relay.handle_in({"speech", opcode: :binary}, state)

    # Still not listening: the retry stays quiet rather than repeating "waiting".
    assert {:ok, state} = Relay.handle_info(:retry, state)
    assert_receive :retry

    listener = listen(path)
    assert {:push, [status], state} = Relay.handle_info(:retry, state)
    assert json(status) == %{"state" => "connected"}
    peer = accept(listener)

    {:ok, state} = Relay.handle_in({"live", opcode: :binary}, state)
    # Exactly the live frame: hark pads gaps itself, so replayed audio would
    # be counted twice.
    assert received(peer, 4) == "live"
    assert {:error, :timeout} = :gen_tcp.recv(peer, 0, 100)
    Relay.terminate(:normal, state)
  end

  test "a launch that has not written its lifecycle file yet is waited for" do
    assert {:push, [status], _state} = Relay.init(resolve_to(:pending))
    assert %{"state" => "waiting", "reason" => reason} = json(status)
    assert reason =~ "starting"
  end

  test "no phone meeting closes with a reason the page can show" do
    for {answer, code, kind, words} <- [
          {{:error, :none}, 4404, "refused", "no meeting"},
          {{:error, :not_phone}, 4404, "refused", "not a phone"},
          {{:error, :ended}, 4410, "ended", "ended"},
          {{:error, {:failed, "no models"}}, 4410, "ended", "failed: no models"}
        ] do
      assert {:stop, :normal, {^code, reason}, [status], _state} = Relay.init(resolve_to(answer))
      assert reason =~ words
      assert json(status) == %{"state" => kind, "reason" => reason}
    end
  end

  test "a socket bound to one meeting refuses another", %{path: path} do
    opts = resolve_to(live(path, "other")) |> Keyword.put(:launch, "L1")
    assert {:stop, :normal, {4404, reason}, [status], _state} = Relay.init(opts)
    assert reason =~ "different meeting"
    assert json(status)["state"] == "refused"

    listener = listen(path)

    assert {:push, _connected, state} =
             Relay.init(Keyword.put(resolve_to(live(path)), :launch, "L1"))

    accept(listener)
    Relay.terminate(:normal, state)
  end

  test "a long close reason is cut to 123 bytes on a character boundary; the frame keeps it all" do
    error = String.duplicate("é", 100)

    assert {:stop, :normal, {4410, reason}, [status], _state} =
             Relay.init(resolve_to({:error, {:failed, error}}))

    assert byte_size(reason) <= 123
    assert String.valid?(reason)
    assert json(status)["reason"] == "the meeting failed: " <> error
    assert Relay.truncate_utf8("short") == "short"
    assert Relay.truncate_utf8("aé", 2) == "a"
  end

  test "hark closing the socket at the meeting's end closes the WebSocket as ended", %{
    path: path
  } do
    listener = listen(path)
    {:ok, phase} = Agent.start_link(fn -> live(path) end)
    opts = [resolve: fn -> Agent.get(phase, & &1) end, retry_ms: 10, launch: "L1"]

    {:push, _connected, state} = Relay.init(opts)
    peer = accept(listener)
    Agent.update(phase, fn _ -> {:error, :ended} end)
    :gen_tcp.close(peer)

    assert_receive {:tcp_closed, socket} = closed, @io_timeout
    assert socket == state.socket
    assert {:stop, :normal, {4410, reason}, [status], state} = Relay.handle_info(closed, state)
    assert reason =~ "ended"
    assert json(status)["state"] == "ended"
    assert state.socket == nil
  end

  test "hark closing the socket while a new meeting is live ends this one, not replaced", %{
    path: path
  } do
    listener = listen(path)
    {:ok, phase} = Agent.start_link(fn -> live(path) end)
    opts = [resolve: fn -> Agent.get(phase, & &1) end, retry_ms: 10, launch: "L1"]

    {:push, _connected, state} = Relay.init(opts)
    peer = accept(listener)
    Agent.update(phase, fn _ -> live(path, "L2") end)
    :gen_tcp.close(peer)

    assert_receive {:tcp_closed, _socket} = closed, @io_timeout
    assert {:stop, :normal, {4410, _reason}, [status], _state} = Relay.handle_info(closed, state)
    assert json(status)["state"] == "ended"
  end

  test "hark closing the socket while the meeting is still live means another sender took over",
       %{path: path} do
    listener = listen(path)
    {:push, _connected, state} = Relay.init(Keyword.put(resolve_to(live(path)), :launch, "L1"))
    peer = accept(listener)
    :gen_tcp.close(peer)

    assert_receive {:tcp_closed, _socket} = closed, @io_timeout
    assert {:stop, :normal, {4409, reason}, [status], _state} = Relay.handle_info(closed, state)
    assert reason =~ "another device"
    assert json(status)["state"] == "replaced"
  end

  describe "through the endpoint" do
    setup %{path: path} do
      {:ok, phase} = Agent.start_link(fn -> {:ok, %{path: path, launch: "L1"}} end)

      Shuttle.Test.Env.put_app_env(:meeting_audio_socket,
        resolve: fn -> Agent.get(phase, & &1) end,
        retry_ms: 10
      )

      {:ok, server} =
        Bandit.start_link(
          plug: ShuttleWeb.Endpoint,
          ip: {127, 0, 0, 1},
          port: 0,
          startup_log: false
        )

      {:ok, {_ip, port}} = ThousandIsland.listener_info(server)

      %{port: port, phase: phase}
    end

    test "a same-origin page streams into hark and hears when the meeting ends", %{
      path: path,
      port: port,
      phase: phase
    } do
      listener = listen(path)
      {status, ws} = handshake(port, "http://127.0.0.1:#{port}", "L1")
      assert status =~ "HTTP/1.1 101"
      peer = accept(listener)

      assert {:text, connected} = read_frame(ws)
      assert Jason.decode!(connected) == %{"state" => "connected"}

      :ok = :gen_tcp.send(ws, client_frame(0x2, <<0, 1, 255, 127>>))
      assert received(peer, 4) == <<0, 1, 255, 127>>

      Agent.update(phase, fn _ -> {:error, :ended} end)
      :gen_tcp.close(peer)

      assert {:text, ended} = read_frame(ws)
      assert %{"state" => "ended"} = Jason.decode!(ended)
      assert {:close, <<4410::16, reason::binary>>} = read_frame(ws)
      assert reason =~ "ended"
    end

    test "the launch query binds the socket: another meeting's id is refused", %{port: port} do
      {status, ws} = handshake(port, "http://127.0.0.1:#{port}", "L9")
      assert status =~ "HTTP/1.1 101"
      assert {:text, refused} = read_frame(ws)
      assert %{"state" => "refused"} = Jason.decode!(refused)
      assert {:close, <<4404::16, _reason::binary>>} = read_frame(ws)
    end

    test "a plain GET is told the route takes a WebSocket", %{port: port} do
      {:ok, http} = :gen_tcp.connect({127, 0, 0, 1}, port, [:binary, active: false], @io_timeout)

      :ok =
        :gen_tcp.send(
          http,
          "GET /api/v1/meeting/audio HTTP/1.1\r\nHost: 127.0.0.1:#{port}\r\nConnection: close\r\n\r\n"
        )

      assert read_head(http) =~ "HTTP/1.1 426"
    end

    test "another site's page cannot open the relay", %{port: port} do
      {status, _ws} = handshake(port, "https://elsewhere.example")
      assert status =~ "HTTP/1.1 403"
    end
  end

  defp handshake(port, origin, launch \\ "L1") do
    {:ok, ws} = :gen_tcp.connect({127, 0, 0, 1}, port, [:binary, active: false], @io_timeout)
    key = Base.encode64(:crypto.strong_rand_bytes(16))

    request =
      "GET /api/v1/meeting/audio?launch=#{launch} HTTP/1.1\r\n" <>
        "Host: 127.0.0.1:#{port}\r\n" <>
        "Origin: #{origin}\r\n" <>
        "Upgrade: websocket\r\nConnection: Upgrade\r\n" <>
        "Sec-WebSocket-Key: #{key}\r\nSec-WebSocket-Version: 13\r\n\r\n"

    :ok = :gen_tcp.send(ws, request)
    {read_head(ws), ws}
  end

  # The response head, read a line at a time so that WebSocket frames sent in
  # the same TCP segment stay in the socket for read_frame.
  defp read_head(ws) do
    :ok = :inet.setopts(ws, packet: :line)
    head = read_lines(ws, "")
    :ok = :inet.setopts(ws, packet: :raw)
    head
  end

  defp read_lines(ws, acc) do
    {:ok, line} = :gen_tcp.recv(ws, 0, @io_timeout)
    acc = acc <> line
    if line == "\r\n", do: acc, else: read_lines(ws, acc)
  end

  # A server frame: unmasked, payloads here under 64 KiB.
  defp read_frame(ws) do
    {:ok, <<_fin::1, _rsv::3, opcode::4, 0::1, len::7>>} = :gen_tcp.recv(ws, 2, @io_timeout)

    len =
      if len == 126 do
        {:ok, <<extended::16>>} = :gen_tcp.recv(ws, 2, @io_timeout)
        extended
      else
        len
      end

    {:ok, payload} = if len == 0, do: {:ok, ""}, else: :gen_tcp.recv(ws, len, @io_timeout)
    {%{0x1 => :text, 0x2 => :binary, 0x8 => :close}[opcode], payload}
  end

  # A client frame: masked, as browsers send them.
  defp client_frame(opcode, payload) do
    mask = :crypto.strong_rand_bytes(4)
    <<1::1, 0::3, opcode::4, 1::1, byte_size(payload)::7>> <> mask <> mask(payload, mask)
  end

  defp mask(payload, <<a, b, c, d>>) do
    keys = Stream.cycle([a, b, c, d])

    payload
    |> :binary.bin_to_list()
    |> Enum.zip(keys)
    |> Enum.map(fn {byte, key} -> Bitwise.bxor(byte, key) end)
    |> :binary.list_to_bin()
  end
end
