defmodule Shuttle.RelayClientTest do
  use ExUnit.Case, async: false
  alias Shuttle.Test.Env
  alias Shuttle.{OriginRouter, RelayGate, Remote}
  alias Shuttle.RemoteRegistry.Client.Default
  alias Shuttle.Test.HungRelayRemote

  defmodule Callback do
    def post(url, body, type, timeout),
      do: respond({:post, url, body, type, timeout}, {:ok, 200, "ok"})

    def get_file(url, timeout), do: respond({:get, url, timeout})
    def get_file(url, headers, timeout), do: respond({:file, url, headers, timeout})
    def head_file(url, headers, timeout), do: respond({:head, url, headers, timeout})

    defp respond(call, response \\ {:ok, 200, "application/octet-stream", "ok"}) do
      send(self(), {:callback, call, Process.get(:callback_context)})
      response
    end
  end

  defmodule OncePlug do
    @behaviour Plug
    def init(opts), do: opts

    def call(conn, opts) do
      send(opts[:observer], {:post_attempt, conn.method, conn.request_path})

      conn
      |> Plug.Conn.put_resp_header("retry-after", "0")
      |> Plug.Conn.put_resp_header("location", "/again")
      |> Plug.Conn.send_resp(opts[:status], "no")
    end
  end

  setup do
    gate = start_supervised!({RelayGate, name: nil})

    for {key, value} <- [relay_gate: gate, write_forward_client: Default] do
      Env.put_app_env(key, value)
    end

    hung = start_supervised!(HungRelayRemote)

    %{
      gate: gate,
      hung: hung,
      remote: %Remote{name: "owner", url: HungRelayRemote.snapshot(hung).url}
    }
  end

  test "all relay shapes share four slots, fail fast, and real sockets close on owner death",
       ctx do
    parent = self()

    owners =
      for method <- [:post, :get, :file, :head] do
        scoped_spawn(fn -> send(parent, {:result, relay(method, ctx.remote)}) end)
      end

    eventually(fn -> HungRelayRemote.snapshot(ctx.hung).requests == 4 end)
    state = :sys.get_state(ctx.gate)
    workers = Enum.map(state.leases, fn {_token, lease} -> lease.worker end)
    assert length(workers) == 4
    assert Enum.all?(workers, &Process.alive?/1)

    started = now()

    for method <- [:post, :get, :file, :head] do
      assert {:error, {:forward_failed, "owner", :relay_busy}} = relay(method, ctx.remote)
    end

    assert now() - started < 200
    assert HungRelayRemote.snapshot(ctx.hung).requests == 4
    Enum.each(owners, &Process.exit(&1, :kill))
    eventually(fn -> HungRelayRemote.snapshot(ctx.hung).active == 0 end)
    eventually(fn -> :sys.get_state(ctx.gate).leases == %{} end)
    assert Enum.all?(workers, &(not Process.alive?(&1)))
    assert :sys.get_state(ctx.gate).failures == %{}
  end

  test "receive deadline cancels selected profile, cools down, URL reconfiguration isolates",
       ctx do
    for method <- [:post, :get, :file, :head] do
      remote = %{ctx.remote | url: ctx.remote.url <> "/#{method}"}
      started = now()
      assert {:error, {:forward_failed, "owner", :timeout}} = relay(method, remote, 80)
      assert now() - started < 500
      eventually(fn -> HungRelayRemote.snapshot(ctx.hung).active == 0 end)
      assert {:error, {:forward_failed, "owner", :relay_cooldown}} = relay(method, remote, 80)
    end

    assert HungRelayRemote.snapshot(ctx.hung).requests == 4
    assert :sys.get_state(ctx.gate).leases == %{}
    assert {:ok, [socket_opts: opts]} = :httpc.get_options([:socket_opts], :shuttle_fleet_direct)
    assert opts[:send_timeout] == 1_000
    assert opts[:send_timeout_close]
  end

  test "an already-started unconfigured profile gets send bounds before submission", ctx do
    # Model another caller creating the shared profile without socket bounds.
    :inets.start(:httpc, profile: :shuttle_fleet_direct)
    :ok = :httpc.set_options([socket_opts: []], :shuttle_fleet_direct)
    assert {:error, :timeout} = Default.get(ctx.remote.url, 80)
    assert {:ok, [socket_opts: opts]} = :httpc.get_options([:socket_opts], :shuttle_fleet_direct)
    assert opts[:send_timeout] == 1_000
    assert opts[:send_timeout_close]
  end

  test "owner death before gate registration reaps the unregistered worker", ctx do
    :ok = :sys.suspend(ctx.gate)
    owner = scoped_spawn(fn -> Default.get(ctx.remote.url, 2_000) end)

    try do
      eventually(fn -> queued_worker(ctx.gate) != nil end)
      worker = queued_worker(ctx.gate)
      monitor = Process.monitor(worker)
      Process.exit(owner, :kill)
      assert_receive {:DOWN, ^monitor, :process, ^worker, :normal}, 200
      assert HungRelayRemote.snapshot(ctx.hung).requests == 0
    after
      Process.exit(owner, :kill)
      :sys.resume(ctx.gate)
    end

    eventually(fn -> :sys.get_state(ctx.gate).leases == %{} end)
  end

  test "Default setup/submission is bounded even with its own httpc manager suspended", ctx do
    # Warm the profile before suspending only this test VM's manager.
    assert {:error, :timeout} = Default.get(ctx.remote.url, 30)
    manager = Process.whereis(:httpc_shuttle_fleet_direct)
    assert is_pid(manager)
    :ok = :sys.suspend(manager)

    try do
      started = now()
      assert {:error, :timeout} = Default.get(ctx.remote.url, 80)
      assert now() - started < 500
      state = :sys.get_state(ctx.gate)
      assert state.leases == %{}
      assert {:error, {:forward_failed, "owner", :timeout}} = relay(:file, ctx.remote, 80)
      assert :sys.get_state(ctx.gate).leases == %{}
    after
      :sys.resume(manager)
    end

    # Submission IDs are unavailable until the OTP manager returns. An
    # abandoned submission can still start after that manager resumes; its
    # own receive/connect timers close it. No caller or worker waits for it.
    eventually(fn -> HungRelayRemote.snapshot(ctx.hung).active == 0 end, 2_000)
  end

  test "injected callbacks keep caller context and explicit transfer budgets", ctx do
    Env.put_app_env(:write_forward_client, Callback)
    Process.put(:callback_context, :preserved)
    assert {:forwarded, 200, "ok"} = relay(:post, ctx.remote)
    assert_receive {:callback, {:post, url, body, "application/json", 5_000}, :preserved}
    assert url =~ "/control"
    assert Jason.decode!(body) == %{"message" => "keep me"}

    assert {:forwarded, 200, "application/octet-stream", "ok"} = relay(:get, ctx.remote)
    assert_receive {:callback, {:get, url, 5_000}, :preserved}
    refute url =~ "origin"

    for method <- [:file, :head] do
      assert {:forwarded, 200, [], "application/octet-stream", "ok"} = relay(method, ctx.remote)
      assert_receive {:callback, {^method, _url, _headers, 5_000}, :preserved}
    end

    assert :sys.get_state(ctx.gate).leases == %{}
  end

  test "POST preserves 307 and 503 without redirect or Retry-After resubmission", ctx do
    for status <- [307, 503] do
      server =
        start_supervised!(
          Supervisor.child_spec(
            {Bandit,
             plug: {OncePlug, status: status, observer: self()}, port: 0, ip: {127, 0, 0, 1}},
            id: {:once, status}
          )
        )

      {:ok, {_, port}} = ThousandIsland.listener_info(server)
      remote = %{ctx.remote | url: "http://127.0.0.1:#{port}"}
      assert {:forwarded, ^status, "no"} = relay(:post, remote)
      assert_receive {:post_attempt, "POST", "/control"}
      refute_receive {:post_attempt, _, _}, 100
    end
  end

  test "real Bandit file handlers from twenty early-disconnected clients are bounded", ctx do
    Env.put_app_env(:remotes, [%{name: "owner", url: ctx.remote.url}])

    server =
      start_supervised!(
        {Bandit, plug: ShuttleWeb.Endpoint, port: 0, ip: {127, 0, 0, 1}, startup_log: false}
      )

    {:ok, {_, port}} = ThousandIsland.listener_info(server)

    for _ <- 1..20 do
      {:ok, socket} = :gen_tcp.connect({127, 0, 0, 1}, port, [:binary, active: false], 1_000)

      :ok =
        :gen_tcp.send(
          socket,
          "GET /api/v1/file?path=%2Fhung&origin=owner HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"
        )

      :gen_tcp.close(socket)
    end

    eventually(fn -> HungRelayRemote.snapshot(ctx.hung).requests >= 4 end)
    Process.sleep(150)
    snapshot = HungRelayRemote.snapshot(ctx.hung)

    assert snapshot.requests == 4,
           "retained requests=#{snapshot.requests}, outbound=#{snapshot.active}, inbound=#{inbound_sockets(port)}"

    assert snapshot.active == 4
    assert inbound_sockets(port) == 4
    state = :sys.get_state(ctx.gate)
    handlers = Enum.map(state.leases, fn {_token, lease} -> lease.caller end)
    workers = Enum.map(state.leases, fn {_token, lease} -> lease.worker end)
    assert length(handlers) == 4
    assert Enum.all?(handlers ++ workers, &Process.alive?/1)

    eventually(
      fn ->
        HungRelayRemote.snapshot(ctx.hung).active == 0 and
          inbound_sockets(port) == 0
      end,
      32_000
    )

    eventually(fn -> :sys.get_state(ctx.gate).leases == %{} end)
    assert Enum.all?(handlers ++ workers, &(not Process.alive?(&1)))
    assert HungRelayRemote.snapshot(ctx.hung).requests == 4
  end

  defp relay(method, remote, timeout \\ nil) do
    opts = [forward_timeout_ms: timeout || 5_000]

    case method do
      :post ->
        OriginRouter.forward(
          remote,
          "/control",
          %{"origin" => "owner", "message" => "keep me"},
          opts
        )

      :get ->
        OriginRouter.forward_get(remote, "/read", %{"origin" => "owner"}, opts)

      method ->
        OriginRouter.forward_file_get(
          remote,
          "/file",
          %{},
          [],
          Keyword.put(opts, :method, if(method == :head, do: :head, else: :get))
        )
    end
  end

  defp scoped_spawn(fun) do
    callers = Shuttle.Env.callers()

    spawn(fn ->
      Shuttle.Env.adopt_callers(callers)
      fun.()
    end)
  end

  defp queued_worker(gate) do
    {:messages, messages} = Process.info(gate, :messages)

    Enum.find_value(messages, fn
      {:"$gen_call", _from, {:watch, _token, _owner, worker, _deadline}} -> worker
      _ -> nil
    end)
  end

  defp inbound_sockets(port) do
    # The listener uses the same local port but has no peer. CLOSED inbound
    # sockets retained by a running Bandit handler still have both addresses.
    Enum.count(:erlang.ports(), fn socket ->
      with {:ok, {{127, 0, 0, 1}, ^port}} <- :inet.sockname(socket),
           {:ok, _} <- :inet.peername(socket),
           do: true,
           else: (_ -> false)
    end)
  end

  defp eventually(fun, timeout \\ 1_000), do: poll(fun, now() + timeout)

  defp poll(fun, deadline) do
    if fun.() do
      :ok
    else
      if now() >= deadline do
        assert fun.()
      else
        Process.sleep(10)
        poll(fun, deadline)
      end
    end
  end

  defp now, do: System.monotonic_time(:millisecond)
end
