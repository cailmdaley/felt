defmodule ShuttleWeb.RequestDeadlineTest do
  use ExUnit.Case, async: true

  alias ShuttleWeb.RequestDeadline

  defmodule Handler do
    import Plug.Conn
    def init(opts), do: opts

    def call(conn, opts) do
      Process.flag(:trap_exit, true)

      ports =
        Enum.filter(:erlang.ports(), fn port ->
          :erlang.port_info(port, :connected) == {:connected, self()}
        end)

      send(opts[:observer], {:request_owner, self(), conn.request_path, ports})

      case {conn.request_path, opts[:server]} do
        {"/fast", _} -> :ok
        {"/fifo", _} -> File.read!(opts[:fifo])
        {_, nil} -> receive do: (:respond -> :ok)
        {_, server} -> GenServer.call(server, :block, :infinity)
      end

      send_resp(conn, 200, "ok")
    end
  end

  defmodule Stalled do
    use GenServer
    def start_link(opts), do: GenServer.start_link(__MODULE__, opts)
    def init(opts), do: {:ok, opts}

    def handle_call(:block, _from, opts) do
      send(opts[:observer], :dependency_blocked)
      receive do: (:respond -> {:reply, :ok, opts})
    end
  end

  defp listener(budget, extra \\ []) do
    opts = [observer: self(), identity: make_ref()] ++ extra
    plug = {Handler, opts}

    guard =
      start_supervised!(
        Supervisor.child_spec(
          {RequestDeadline, name: nil, plug: plug, budget: budget},
          id: make_ref()
        )
      )

    server =
      start_supervised!(
        Supervisor.child_spec(
          {Bandit, plug: plug, ip: {127, 0, 0, 1}, port: 0, startup_log: false},
          id: make_ref()
        )
      )

    {:ok, {_, port}} = ThousandIsland.listener_info(server)
    {guard, port}
  end

  defp connect(port) do
    {:ok, socket} = :gen_tcp.connect({127, 0, 0, 1}, port, [:binary, active: false], 1_000)
    socket
  end

  defp request(socket, path) do
    :ok = :gen_tcp.send(socket, "GET #{path} HTTP/1.1\r\nHost: localhost\r\n\r\n")
  end

  defp response(socket, acc \\ "") do
    if String.ends_with?(acc, "\r\n\r\nok") do
      acc
    else
      {:ok, bytes} = :gen_tcp.recv(socket, 0, 1_000)
      response(socket, acc <> bytes)
    end
  end

  defp eventually(fun, attempts \\ 100)
  defp eventually(fun, 0), do: assert(fun.())

  defp eventually(fun, attempts) do
    if fun.() do
      :ok
    else
      Process.sleep(10)
      eventually(fun, attempts - 1)
    end
  end

  for mode <- [:handler, :genserver] do
    test "early disconnect releases all owners and inbound ports blocked in #{mode}" do
      extra =
        case unquote(mode) do
          :handler -> []
          :genserver -> [server: start_supervised!({Stalled, observer: self()})]
        end

      {guard, port} = listener(fn _, _ -> 400 end, extra)

      owners =
        for _ <- 1..12 do
          socket = connect(port)
          request(socket, "/block")
          assert_receive {:request_owner, owner, "/block", [_ | _] = ports}, 1_000
          monitor = Process.monitor(owner)
          :ok = :gen_tcp.close(socket)
          {owner, monitor, ports}
        end

      # A disconnect alone does not unblock these handlers.
      assert Enum.all?(owners, fn {owner, _, _} -> Process.alive?(owner) end)

      for {owner, monitor, ports} <- owners do
        assert_receive {:DOWN, ^monitor, :process, ^owner, :killed}, 1_500
        assert Enum.all?(ports, &(:erlang.port_info(&1) == :undefined))
      end

      assert %{spans: %{}, monitors: %{}} = :sys.get_state(guard)
    end
  end

  test "a connected blocked request gets a closed socket, not an HTTP response" do
    {guard, port} = listener(fn _, _ -> 80 end)
    socket = connect(port)
    request(socket, "/block")
    assert_receive {:request_owner, owner, "/block", _ports}, 2_000
    monitor = Process.monitor(owner)
    assert {:error, :closed} = :gen_tcp.recv(socket, 0, 1_000)
    assert_receive {:DOWN, ^monitor, :process, ^owner, :killed}
    assert %{spans: %{}, monitors: %{}} = :sys.get_state(guard)
  end

  test "response completion cleans the guard and leaves keepalive usable beyond the budget" do
    {guard, port} = listener(fn _, _ -> 70 end)
    socket = connect(port)
    request(socket, "/fast")
    assert_receive {:request_owner, owner, "/fast", _ports}, 2_000
    assert response(socket) =~ "200 OK"
    eventually(fn -> :sys.get_state(guard).spans == %{} end)
    Process.sleep(140)
    assert Process.alive?(owner)
    assert %{spans: %{}, monitors: %{}} = :sys.get_state(guard)
    request(socket, "/fast")
    assert_receive {:request_owner, ^owner, "/fast", _ports}, 2_000
    assert response(socket) =~ "200 OK"
    :gen_tcp.close(socket)
  end

  test "a stale expiry cannot kill a subsequent request on the same HTTP1 owner" do
    {guard, port} = listener(fn _, path -> if path == "/hold", do: 1_000, else: 5_000 end)
    socket = connect(port)
    request(socket, "/hold")
    assert_receive {:request_owner, owner, "/hold", _ports}, 2_000

    [{old_key, %{fuse: old_fuse, fuse_monitor: old_fuse_monitor}}] =
      Map.to_list(:sys.get_state(guard).spans)

    send(owner, :respond)
    assert response(socket) =~ "200 OK"

    request(socket, "/block")
    assert_receive {:request_owner, ^owner, "/block", _ports}, 2_000
    [new_key] = Map.keys(:sys.get_state(guard).spans)
    refute old_key == new_key
    refute Process.alive?(old_fuse)
    send(old_fuse, {:expire, old_key})
    send(guard, {:DOWN, old_fuse_monitor, :process, old_fuse, :killed})
    refute Map.has_key?(:sys.get_state(guard).monitors, old_fuse_monitor)
    Process.sleep(1_100)
    assert Process.alive?(owner)
    assert Map.has_key?(:sys.get_state(guard).spans, new_key)
    send(owner, :respond)
    assert response(socket) =~ "200 OK"
    eventually(fn -> :sys.get_state(guard).spans == %{} end)
    :gen_tcp.close(socket)
  end

  test "owner death removes its timer and monitor without waiting for expiry" do
    {guard, port} = listener(fn _, _ -> 60_000 end)
    socket = connect(port)
    request(socket, "/block")
    assert_receive {:request_owner, owner, "/block", _ports}, 2_000
    Process.exit(owner, :kill)
    eventually(fn -> :sys.get_state(guard).spans == %{} end)
    assert %{monitors: %{}} = :sys.get_state(guard)
    assert {:error, :closed} = :gen_tcp.recv(socket, 0, 1_000)
  end

  test "killing only an active fuse closes the blocked owner and clears the registry" do
    {guard, port} = listener(fn _, _ -> 60_000 end)
    socket = connect(port)
    request(socket, "/block")
    assert_receive {:request_owner, owner, "/block", [_ | _] = ports}, 2_000
    monitor = Process.monitor(owner)
    [{{^owner, _token}, %{fuse: fuse}}] = Map.to_list(:sys.get_state(guard).spans)
    Process.exit(fuse, :kill)

    assert_receive {:DOWN, ^monitor, :process, ^owner, :killed}, 1_000
    assert {:error, :closed} = :gen_tcp.recv(socket, 0, 1_000)
    assert Enum.all?(ports, &(:erlang.port_info(&1) == :undefined))
    assert Process.alive?(guard)
    assert %{spans: %{}, monitors: %{}} = :sys.get_state(guard)
  end

  test "an unavailable telemetry guard fails closed without detaching its handler" do
    observer = self()
    config = %{server: spawn(fn -> :ok end), plug: Handler}
    eventually(fn -> not Process.alive?(config.server) end)
    handler_id = {__MODULE__, make_ref()}
    event = [:bandit, :request, :start]
    :ok = :telemetry.attach(handler_id, event, &RequestDeadline.handle_event/4, config)
    on_exit(fn -> :telemetry.detach(handler_id) end)

    for _ <- 1..2 do
      {owner, monitor} =
        spawn_monitor(fn ->
          :telemetry.execute(event, %{}, %{
            plug: {Handler, []},
            conn: Plug.Test.conn(:get, "/block"),
            telemetry_span_context: make_ref()
          })

          send(observer, :unguarded)
        end)

      assert_receive {:DOWN, ^monitor, :process, ^owner, :killed}
      refute_receive :unguarded, 10
      assert Enum.any?(:telemetry.list_handlers(event), &(&1.id == handler_id))
    end
  end

  test "the production guard filters other Bandit plugs" do
    before = :sys.get_state(RequestDeadline).spans

    :telemetry.execute([:bandit, :request, :start], %{}, %{
      plug: {Handler, []},
      conn: Plug.Test.conn(:get, "/block"),
      telemetry_span_context: make_ref()
    })

    assert :sys.get_state(RequestDeadline).spans == before
  end

  test "route budgets are finite and preserve chooser and slow large-upload contracts" do
    assert RequestDeadline.budget_ms("GET", "/api/v1/file") == 305_000
    assert RequestDeadline.budget_ms("GET", "/api/v1/version") == 8_000
    assert RequestDeadline.budget_ms("HEAD", "/api/v1/transcript/raw") == 305_000
    assert RequestDeadline.budget_ms("GET", "/api/v1/transcript") == 305_000
    assert RequestDeadline.budget_ms("POST", "/api/v1/fleet/remotes") == 95_000
    assert RequestDeadline.budget_ms("POST", "/api/v1/tunnels") == 95_000
    assert RequestDeadline.budget_ms("POST", "/api/v1/dispatch") == 35_000
    assert RequestDeadline.budget_ms("POST", "/api/v1/choose-folder") == 335_000

    for path <- Map.keys(ShuttleWeb.LargeBodyParser.limits()) do
      assert RequestDeadline.budget_ms("POST", path) == 300_000
      assert RequestDeadline.budget_ms("POST", path) > ShuttleWeb.LargeBodyParser.read_timeout()
    end

    assert RequestDeadline.budget_ms("GET", "/api/v1/attachments") == 8_000
  end
end
