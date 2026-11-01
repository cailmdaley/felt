defmodule ShuttleWeb.RequestDeadlineRestartTest do
  use ExUnit.Case

  alias ShuttleWeb.RequestDeadline

  defmodule BlockedPoller do
    use GenServer
    def start_link(observer), do: GenServer.start_link(__MODULE__, observer, name: Shuttle.Poller)
    def init(observer), do: {:ok, observer}

    def handle_call(_request, _from, observer) do
      send(observer, :poller_blocked)
      receive do: (:respond -> {:reply, :ok, observer})
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

  defp connect(port) do
    {:ok, socket} = :gen_tcp.connect({127, 0, 0, 1}, port, [:binary, active: false], 1_000)
    socket
  end

  test "the core guard starts before the endpoint and socket sends have a finite cap" do
    children = Shuttle.Application.child_specs()
    guard_index = Enum.find_index(children, &(&1.id == RequestDeadline))
    endpoint_index = Enum.find_index(children, &(&1.id == ShuttleWeb.Endpoint))
    assert is_integer(guard_index) and guard_index < endpoint_index

    transport =
      Application.fetch_env!(:shuttle, ShuttleWeb.Endpoint)
      |> Keyword.fetch!(:http)
      |> Keyword.fetch!(:thousand_island_options)
      |> Keyword.fetch!(:transport_options)

    assert get_in(Application.fetch_env!(:shuttle, ShuttleWeb.Endpoint), [
             :http,
             :http_2_options,
             :enabled
           ]) == false

    assert transport[:send_timeout] == 5_000
    assert transport[:send_timeout_close] == true
  end

  test "hard-killed production guard closes active owners and restarts without stale telemetry" do
    start_supervised!({BlockedPoller, self()})

    server =
      start_supervised!(
        {Bandit, plug: ShuttleWeb.Endpoint, ip: {127, 0, 0, 1}, port: 0, startup_log: false}
      )

    {:ok, {_, port}} = ThousandIsland.listener_info(server)
    guard = Process.whereis(RequestDeadline)
    socket = connect(port)

    :ok =
      :gen_tcp.send(
        socket,
        "POST /api/v1/quarantine/release HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n"
      )

    assert_receive :poller_blocked, 5_000
    [{{owner, _token}, %{fuse: fuse}}] = Map.to_list(:sys.get_state(guard).spans)
    owner_monitor = Process.monitor(owner)

    ports =
      Enum.filter(:erlang.ports(), &(:erlang.port_info(&1, :connected) == {:connected, owner}))

    assert [_ | _] = ports
    Process.exit(guard, :kill)
    assert_receive {:DOWN, ^owner_monitor, :process, ^owner, :killed}, 1_000
    assert {:error, :closed} = :gen_tcp.recv(socket, 0, 1_000)
    assert Enum.all?(ports, &(:erlang.port_info(&1) == :undefined))
    eventually(fn -> not Process.alive?(fuse) end)

    eventually(fn ->
      is_pid(Process.whereis(RequestDeadline)) and Process.whereis(RequestDeadline) != guard
    end)

    stop_supervised!(BlockedPoller)

    for _ <- 1..2 do
      healthy = connect(port)

      :ok =
        :gen_tcp.send(
          healthy,
          "GET /api/v1/version HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"
        )

      assert {:ok, response} = :gen_tcp.recv(healthy, 0, 5_000)
      assert response =~ "200 OK"
      :gen_tcp.close(healthy)
    end

    id = {RequestDeadline, RequestDeadline}

    for event <- [[:bandit, :request, :start], [:bandit, :request, :stop]] do
      assert [%{id: ^id}] =
               Enum.filter(:telemetry.list_handlers(event), fn handler ->
                 match?({RequestDeadline, _}, handler.id)
               end)
    end

    eventually(fn -> :sys.get_state(RequestDeadline).spans == %{} end)
  end

  test "hard-killing the fuse supervisor closes active requests without restarting the guard" do
    start_supervised!({BlockedPoller, self()})

    server =
      start_supervised!(
        {Bandit, plug: ShuttleWeb.Endpoint, ip: {127, 0, 0, 1}, port: 0, startup_log: false}
      )

    {:ok, {_, port}} = ThousandIsland.listener_info(server)
    guard = Process.whereis(RequestDeadline)
    supervisor = Process.whereis(Shuttle.TaskSupervisor)

    sockets =
      for _ <- 1..2 do
        socket = connect(port)

        :ok =
          :gen_tcp.send(
            socket,
            "POST /api/v1/quarantine/release HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n"
          )

        socket
      end

    assert_receive :poller_blocked, 5_000
    eventually(fn -> map_size(:sys.get_state(guard).spans) == 2 end)

    owners =
      for {{owner, _token}, %{fuse: fuse}} <- :sys.get_state(guard).spans do
        {owner, Process.monitor(owner), fuse}
      end

    Process.exit(supervisor, :kill)

    for {owner, monitor, fuse} <- owners do
      assert_receive {:DOWN, ^monitor, :process, ^owner, :killed}, 1_000
      refute Process.alive?(fuse)
    end

    for socket <- sockets do
      assert {:error, :closed} = :gen_tcp.recv(socket, 0, 1_000)
    end

    assert Process.whereis(RequestDeadline) == guard
    assert %{spans: %{}, monitors: %{}} = :sys.get_state(guard)

    eventually(fn ->
      is_pid(Process.whereis(Shuttle.TaskSupervisor)) and
        Process.whereis(Shuttle.TaskSupervisor) != supervisor
    end)
  end
end
