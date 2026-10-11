defmodule ShuttleWeb.MeetingAudioRelaySocketTest do
  use ExUnit.Case, async: true
  alias Shuttle.MeetingAudioRelay
  alias Shuttle.Remote
  @timeout 10_000

  alias Shuttle.Test.MeetingAudioRelay.Ingress

  defp server(opts) do
    pid =
      start_supervised!(
        {Bandit, plug: {Ingress, opts}, ip: {127, 0, 0, 1}, port: 0, startup_log: false},
        id: make_ref()
      )

    {:ok, {_, port}} = ThousandIsland.listener_info(pid)
    port
  end

  defp fleet(opts \\ []) do
    recorder =
      server(
        Keyword.merge(
          [routing: [own_host_id: "recorder", remotes: []], socket_opts: [observer: self()]],
          opts
        )
      )

    remote = %Remote{name: "recorder", url: "http://127.0.0.1:#{recorder}"}
    hub = server(routing: [own_host_id: "hub", remotes: [remote]])
    {hub, recorder, remote}
  end

  test "production relay carries binary audio and text/status unchanged, retaining remote close details" do
    {hub, _, _} = fleet()
    ws = connect(hub, "recorder=recorder&launch=L1")
    assert_receive {:recorder, _, "L1"}, @timeout
    assert {:text, ~s({"state":"connected"})} = read(ws)
    send_frame(ws, 2, <<0, 255, 128, 1>>)
    assert_receive {:audio, :binary, <<0, 255, 128, 1>>}, @timeout
    assert {:binary, <<0, 255, 128, 1>>} = read(ws)
    send_frame(ws, 1, "status please")
    assert_receive {:audio, :text, "status please"}, @timeout
    assert {:text, "status please"} = read(ws)
    send_frame(ws, 1, "finish")
    assert {:text, ~s({"state":"replaced"})} = read(ws)
    assert {:close, <<4409::16, "another microphone">>} = read(ws)
    :gen_tcp.close(ws)
  end

  test "browser close immediately releases the recorder connection" do
    {hub, _, _} = fleet()
    ws = connect(hub, "recorder=recorder&launch=L1")
    assert_receive {:recorder, recorder, "L1"}, @timeout
    monitor = Process.monitor(recorder)
    assert {:text, _} = read(ws)
    send_frame(ws, 8, <<1000::16, "done">>)
    assert_receive {:recorder_closed, :remote}, @timeout
    assert_receive {:DOWN, ^monitor, :process, ^recorder, _}, @timeout
    :gen_tcp.close(ws)
  end

  test "abrupt browser transport loss also releases the recorder" do
    {hub, _, _} = fleet()
    ws = connect(hub, "recorder=recorder&launch=L1")
    assert_receive {:recorder, _, "L1"}, @timeout
    assert {:text, _} = read(ws)
    :gen_tcp.close(ws)
    assert_receive {:recorder_closed, _}, @timeout
  end

  test "a stale launch crossing the real relay cannot feed a replacement meeting" do
    dir = Path.join(System.tmp_dir!(), "relay-#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)
    on_exit(fn -> File.rm_rf!(dir) end)
    path = Path.join(dir, "phone.sock")
    {:ok, listener} = :gen_tcp.listen(0, [:binary, ifaddr: {:local, path}, active: false])
    on_exit(fn -> :gen_tcp.close(listener) end)

    {hub, _, _} =
      fleet(
        socket: ShuttleWeb.MeetingAudioSocket,
        socket_opts: [resolve: fn -> {:ok, %{path: path, launch: "replacement"}} end]
      )

    ws = connect(hub, "recorder=recorder&launch=stale")
    assert {:text, status} = read(ws)
    assert %{"state" => "refused"} = Jason.decode!(status)
    assert {:close, <<4404::16, _::binary>>} = read(ws)
    assert {:error, :timeout} = :gen_tcp.accept(listener, 50)
    :gen_tcp.close(ws)
  end

  test "one-hop guard refuses a forwarded request aimed at another recorder" do
    {_, recorder, _} = fleet()
    {:ok, ws} = :gen_tcp.connect({127, 0, 0, 1}, recorder, [:binary, active: false], @timeout)
    :ok = :gen_tcp.send(ws, request(recorder, "recorder=hub&launch=L1&relay=1"))
    assert head(ws) =~ "409"
    refute_receive {:recorder, _, _}
    :gen_tcp.close(ws)
  end

  test "explicit remote launch and addressed forwarded target are required" do
    remote = %Remote{name: "recorder", url: "http://localhost:1"}
    opts = [own_host_id: "hub", remotes: [remote]]
    assert {:error, :launch_required} = MeetingAudioRelay.route(%{"recorder" => "recorder"}, opts)

    for target <- [nil, "", "local", "recorder", "absent"] do
      params = %{"recorder" => target, "launch" => "L1", "relay" => "1"}
      assert {:error, _} = MeetingAudioRelay.route(params, opts)
    end

    assert {:local, "L1"} =
             MeetingAudioRelay.route(
               %{"recorder" => "hub", "launch" => "L1", "relay" => "1"},
               opts
             )

    assert {:error, {:unknown_origin, "absent"}} =
             MeetingAudioRelay.route(%{"recorder" => "absent", "launch" => "L1"}, opts)
  end

  defp connect(port, query) do
    {:ok, ws} = :gen_tcp.connect({127, 0, 0, 1}, port, [:binary, active: false], @timeout)
    :ok = :gen_tcp.send(ws, request(port, query))
    assert head(ws) =~ "101"
    ws
  end

  defp request(port, query),
    do:
      "GET /api/v1/meeting/audio?#{query} HTTP/1.1\r\nHost: 127.0.0.1:#{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"

  defp head(ws) do
    :inet.setopts(ws, packet: :line)
    result = lines(ws, "")
    :inet.setopts(ws, packet: :raw)
    result
  end

  defp lines(ws, acc) do
    {:ok, line} = :gen_tcp.recv(ws, 0, @timeout)
    if line == "\r\n", do: acc <> line, else: lines(ws, acc <> line)
  end

  defp read(ws) do
    {:ok, <<_::4, op::4, 0::1, n::7>>} = :gen_tcp.recv(ws, 2, @timeout)

    n =
      if n == 126 do
        {:ok, <<n::16>>} = :gen_tcp.recv(ws, 2, @timeout)
        n
      else
        n
      end

    {:ok, body} = if n == 0, do: {:ok, ""}, else: :gen_tcp.recv(ws, n, @timeout)
    {%{1 => :text, 2 => :binary, 8 => :close}[op], body}
  end

  defp send_frame(ws, op, body) do
    key = <<1, 2, 3, 4>>
    mask = binary_part(:binary.copy(key, div(byte_size(body) + 3, 4)), 0, byte_size(body))

    :gen_tcp.send(ws, [
      <<1::1, 0::3, op::4, 1::1, byte_size(body)::7>>,
      key,
      :crypto.exor(body, mask)
    ])
  end
end
