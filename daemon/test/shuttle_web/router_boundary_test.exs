defmodule ShuttleWeb.RouterBoundaryTest do
  use ExUnit.Case, async: true

  alias ShuttleWeb.RouterBoundary

  defmodule DependencyPlug do
    import Plug.Conn
    def init(opts), do: opts

    def call(conn, opts) do
      if opts[:sent], do: send_resp(conn, 200, "already sent")

      try do
        GenServer.call(opts[:server], :read, opts[:timeout] || 10)
      catch
        :exit, reason ->
          if opts[:wrapped] do
            raise Plug.Conn.WrapperError,
              conn: conn,
              kind: :exit,
              reason: reason,
              stack: __STACKTRACE__
          else
            :erlang.raise(:exit, reason, __STACKTRACE__)
          end
      end
    end
  end

  defmodule BrokenPlug do
    def init(opts), do: opts
    def call(_conn, :exit), do: exit(:unrelated)
    def call(_conn, :error), do: raise("broken")
    def call(_conn, :fake_timeout), do: exit({:timeout, {OtherModule, :call, []}})
  end

  defp call(opts) do
    RouterBoundary.call(
      Plug.Test.conn(:get, "/dependency"),
      RouterBoundary.init(plug: DependencyPlug, plug_opts: opts)
    )
  end

  for wrapped <- [false, true] do
    test "noproc GenServer exit returns JSON 503 (wrapped=#{wrapped})" do
      {server, monitor} = spawn_monitor(fn -> :ok end)
      assert_receive {:DOWN, ^monitor, :process, ^server, :normal}
      conn = call(server: server, wrapped: unquote(wrapped))
      assert conn.status == 503
      assert conn.halted

      assert Plug.Conn.get_resp_header(conn, "content-type") == [
               "application/json; charset=utf-8"
             ]

      assert %{"error" => "dependency unavailable or timed out"} = Jason.decode!(conn.resp_body)
    end

    test "stalled GenServer exit returns JSON 503 (wrapped=#{wrapped})" do
      server = spawn(fn -> receive do: (:stop -> :ok) end)
      on_exit(fn -> Process.exit(server, :kill) end)
      conn = call(server: server, wrapped: unquote(wrapped))
      assert conn.status == 503
    end
  end

  test "a real Bandit listener renders a dependency timeout as JSON 503" do
    dependency = spawn(fn -> receive do: (:stop -> :ok) end)
    on_exit(fn -> Process.exit(dependency, :kill) end)

    server =
      start_supervised!(
        {Bandit,
         plug:
           {RouterBoundary, plug: DependencyPlug, plug_opts: [server: dependency, wrapped: true]},
         ip: {127, 0, 0, 1},
         port: 0,
         startup_log: false}
      )

    {:ok, {_, port}} = ThousandIsland.listener_info(server)
    {:ok, socket} = :gen_tcp.connect({127, 0, 0, 1}, port, [:binary, active: false], 1_000)
    :ok = :gen_tcp.send(socket, "GET /dependency HTTP/1.1\r\nHost: localhost\r\n\r\n")
    assert {:ok, response} = :gen_tcp.recv(socket, 0, 5_000)
    assert response =~ "503 Service Unavailable"
    assert response =~ "application/json"
    assert response =~ "dependency unavailable or timed out"
    :gen_tcp.close(socket)
  end

  test "unrelated exits and exceptions are not hidden" do
    for {kind, expected} <- [exit: :unrelated, fake_timeout: {:timeout, {OtherModule, :call, []}}] do
      assert catch_exit(RouterBoundary.call(Plug.Test.conn(:get, "/"), {BrokenPlug, kind})) ==
               expected
    end

    assert_raise RuntimeError, "broken", fn ->
      RouterBoundary.call(Plug.Test.conn(:get, "/"), {BrokenPlug, :error})
    end
  end

  test "a response already sent cannot be replaced with a 503" do
    {server, monitor} = spawn_monitor(fn -> :ok end)
    assert_receive {:DOWN, ^monitor, :process, ^server, :normal}
    assert {:noproc, {GenServer, :call, _}} = catch_exit(call(server: server, sent: true))
  end
end
