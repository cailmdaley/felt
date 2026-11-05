defmodule ShuttleWeb.OwnerDownTest do
  use ExUnit.Case, async: true
  import Shuttle.Test.PollerHelpers
  alias Shuttle.Test.Env
  alias Shuttle.{Poller, Remote, RemoteFiberRegistry}
  @uid "01ARZ3NDEKTSV4RRFFQ69G5FAX"

  defmodule ScopedAPI do
    @behaviour Plug
    def init(owner), do: owner

    def call(conn, owner) do
      Shuttle.Env.adopt_callers([owner])
      reply = ShuttleWeb.Endpoint.call(conn, ShuttleWeb.Endpoint.init([]))

      if conn.method == "POST" && conn.request_path == "/api/v1/lifecycle",
        do: send(owner, {:viewer_lifecycle, reply.status})

      reply
    end
  end

  defmodule OwnerAPI do
    @behaviour Plug
    def init(opts), do: opts

    def call(conn, opts) do
      if conn.method == "POST" do
        send(opts[:test], {:owner_post, conn.request_path})
        {:ok, body, conn} = Plug.Conn.read_body(conn)

        if conn.request_path == "/api/v1/felt-edit" && Map.has_key?(Jason.decode!(body), "routed") do
          Plug.Conn.send_resp(conn, 400, ~s({"error":"unsupported edit fields: routed"}))
        else
          Plug.Conn.send_resp(conn, 200, ~s({"invoked":true}))
        end
      else
        Plug.Conn.send_resp(conn, 200, Jason.encode!(%{host: "worker", fibers: [opts[:row]]}))
      end
    end
  end

  defmodule HopAPI do
    @behaviour Plug
    def init(opts), do: opts

    def call(conn, opts) do
      hop = Agent.get_and_update(opts[:counter], &{&1 + 1, &1 + 1})

      if hop > 3 do
        Plug.Conn.send_resp(conn, 508, "probe stopped a forwarding loop")
      else
        Shuttle.Env.adopt_callers([opts[:test]])
        reply = ShuttleWeb.Endpoint.call(conn, ShuttleWeb.Endpoint.init([]))

        send(
          opts[:test],
          {:hop, reply.body_params, Plug.Conn.get_req_header(conn, "x-shuttle-routed")}
        )

        reply
      end
    end
  end

  defmodule WarmFeed do
    def get(_url, _timeout) do
      {:ok,
       Jason.encode!(%{
         host: "worker",
         fibers: [
           %{
             fiber: %{
               id: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
               status: "open",
               shuttle: %{host: "worker", kind: "oneshot"}
             }
           }
         ]
       })}
    end
  end

  defmodule DocumentRunner do
    @behaviour Shuttle.Runner
    def cmd("tmux", _, _), do: {"no private test workers", 1}
    def cmd("ps", _, _), do: {"", 0}
    def cmd(command, args, opts), do: Shuttle.Runner.Default.cmd(command, args, opts)
  end

  defmodule VanishingTransitionRunner do
    @behaviour Shuttle.Runner
    def cmd("shuttle", ["patch-document"] = args, opts) do
      File.rm!(Jason.decode!(opts[:input])["path"])
      DocumentRunner.cmd("shuttle", args, opts)
    end

    def cmd(command, args, opts), do: DocumentRunner.cmd(command, args, opts)
  end

  defmodule RacingExitRunner do
    @behaviour Shuttle.Runner
    def cmd("shuttle", ["patch-document"] = args, opts) do
      path = Jason.decode!(opts[:input])["path"]
      raw = File.read!(path)

      case Shuttle.Env.app(:owner_down_edit_race) do
        :arm ->
          File.write!(path, String.replace(raw, "status: open", "status: active"))

        :owner ->
          File.write!(path, String.replace(raw, "host: worker", "host: replacement"))

        :vanish ->
          other = Path.join(Path.dirname(Path.dirname(path)), "elsewhere/task/task.md")
          File.mkdir_p!(Path.dirname(other))
          File.rename!(path, other)
      end

      DocumentRunner.cmd("shuttle", args, opts)
    end

    def cmd(command, args, opts), do: DocumentRunner.cmd(command, args, opts)
  end

  defp fixture(tmp, id \\ "task") do
    store = Path.join(tmp, "loom")
    path = Path.join(store, ".felt/#{id}/#{Path.basename(id)}.md")
    File.mkdir_p!(Path.dirname(path))

    File.write!(
      path,
      "---\nid: #{@uid}\nname: Task\nstatus: open\nupdated-at: 2020-01-01T00:00:00Z\nshuttle:\n  kind: oneshot\n  host: worker\n---\nBody\n"
    )

    for key <-
          ~w(SHUTTLE_FIBER_PATH SHUTTLE_TERMINAL_SESSION TMUX TMUX_PANE REX_SESSION REX_BLOCK REX_SERVER SHUTTLE_REX_SERVER PI_SESSION_ID CODEX_THREAD_ID CLAUDE_CODE_SESSION_ID CLAUDE_SESSION_ID AI_AGENT),
        do: Env.delete_env(key)

    Env.put_env("HOME", tmp)
    host_config = Path.join(tmp, "host.json")
    File.write!(host_config, ~s({"terminal":"tmux"}))
    Env.put_env("SHUTTLE_HOST_CONFIG_FILE", host_config)
    Env.put_app_env(:terminal_backend, Shuttle.Terminal.Tmux)
    Env.put_env("SHUTTLE_HOST", "test-host")
    stores_file = Path.join(tmp, "stores.json")
    File.write!(stores_file, Jason.encode!(%{felt_stores: [store]}))
    Env.delete_env("SHUTTLE_STORES")
    Env.put_env("SHUTTLE_STORES_FILE", stores_file)
    Env.put_app_env(:felt_runner, DocumentRunner)
    remotes = Path.join(tmp, "remotes.json")
    File.write!(remotes, ~s({"version":1,"defaults":{"discover":false},"remotes":[]}))
    Env.put_env("SHUTTLE_REMOTES_FILE", remotes)
    {store, path}
  end

  defp stale_owner do
    remote = %Remote{name: "worker", url: "http://127.0.0.1:1"}
    Env.put_app_env(:remotes, [remote])

    Env.start_scoped!(
      {RemoteFiberRegistry, name: nil, remotes: [remote], auto_poll: false, store_dir: nil}
    )
  end

  defp owner(row, port \\ 0) do
    api =
      start_supervised!(
        Supervisor.child_spec(
          {Bandit,
           plug: {OwnerAPI, [row: row, test: self()]},
           port: port,
           ip: {127, 0, 0, 1},
           startup_log: false},
          id: :owner
        )
      )

    {:ok, {_, port}} = ThousandIsland.listener_info(api)
    {api, port}
  end

  defp request(base, endpoint, payload) do
    :httpc.request(
      :post,
      {String.to_charlist(base <> endpoint), [], ~c"application/json", Jason.encode!(payload)},
      [],
      body_format: :binary
    )
  end

  @tag :tmp_dir
  test "a fresh owner accepting and stalling TLS cannot authorize a mirror exit", %{tmp_dir: tmp} do
    {store, path} = fixture(Path.expand(tmp))
    {:ok, listener} = :gen_tcp.listen(0, [:binary, active: false, ip: {127, 0, 0, 1}])
    on_exit(fn -> :gen_tcp.close(listener) end)
    {:ok, port} = :inet.port(listener)
    test = self()

    start_supervised!(
      {Task,
       fn ->
         {:ok, socket} = :gen_tcp.accept(listener, 15_000)
         send(test, :tls_accepted)

         receive do
           :finish -> :ok
         after
           15_000 -> :ok
         end

         :gen_tcp.close(socket)
       end}
    )

    remote = %Remote{name: "worker", url: "https://127.0.0.1:#{port}"}
    Env.put_app_env(:remotes, [remote])

    File.write!(
      Path.join(Path.expand(tmp), "remotes.json"),
      Jason.encode!(%{
        version: 1,
        defaults: %{discover: false},
        remotes: [%{name: "worker", url: remote.url}]
      })
    )

    {:ok, poller} =
      start_poller!(felt_stores: [store], runner: DocumentRunner, poll_interval_ms: 3_600_000)

    await_boot_cycle!(poller)

    Env.start_scoped!(
      {RemoteFiberRegistry,
       name: nil, remotes: [remote], client: WarmFeed, auto_poll: false, store_dir: nil}
    )

    :ok = RemoteFiberRegistry.refresh_now()
    refute RemoteFiberRegistry.feeds()["worker"].stale
    before = File.read!(path)

    conn =
      ShuttleWeb.LifecycleController.create(Plug.Test.conn(:post, "/"), %{
        "fiber" => @uid,
        "origin" => "worker",
        "action" => "rest"
      })

    assert_receive :tls_accepted
    assert conn.status == 502, conn.resp_body
    assert File.read!(path) == before
  end

  @tag :tmp_dir
  @tag timeout: 120_000
  test "real CLI rest projects over a cached stale owner row, never a healthy row", %{
    tmp_dir: tmp
  } do
    tmp = Path.expand(tmp)
    slug = "work/events/2611-ade"
    {store, path} = fixture(tmp, slug)
    draft_document = File.read!(path)

    row = %{
      "felt_store" => "/owner",
      "path" => "#{slug}/2611-ade.md",
      "fiber" => %{
        "id" => @uid,
        "uid" => @uid,
        "slug" => slug,
        "name" => "Task",
        "status" => "open",
        "updated_at" => "2020-01-01T00:00:00Z",
        "shuttle" => %{"kind" => "oneshot", "host" => "worker"}
      }
    }

    {_, port} = owner(row)
    remote = %Remote{name: "worker", url: "http://127.0.0.1:#{port}"}
    remotes = Path.join(tmp, "remotes.json")

    File.write!(
      remotes,
      Jason.encode!(%{
        version: 1,
        defaults: %{discover: false},
        remotes: [%{name: "worker", port: port}]
      })
    )

    Env.put_env("SHUTTLE_REMOTES_FILE", remotes)
    Env.put_app_env(:remotes, [remote])

    {:ok, poller} =
      start_poller!(felt_stores: [store], runner: DocumentRunner, poll_interval_ms: 3_600_000)

    await_boot_cycle!(poller)
    clock = start_supervised!({Agent, fn -> DateTime.utc_now() end})

    Env.start_scoped!(
      {RemoteFiberRegistry,
       name: nil,
       remotes: [remote],
       auto_poll: false,
       store_dir: nil,
       request_timeout_ms: 1000,
       clock: fn -> Agent.get(clock, & &1) end}
    )

    :ok = RemoteFiberRegistry.refresh_now()
    assert [%{"fiber" => %{"status" => "open"}}] = RemoteFiberRegistry.feeds()["worker"].fibers
    refute RemoteFiberRegistry.feeds()["worker"].stale
    stop_supervised!(:owner)
    Agent.update(clock, &DateTime.add(&1, 300_000, :millisecond))
    :ok = RemoteFiberRegistry.refresh_now()
    assert RemoteFiberRegistry.feeds()["worker"].stale
    assert File.dir?(Path.join(store, ".felt"))
    assert [^store] = Shuttle.FeltStores.configured_stores()
    assert {_, 0} = DocumentRunner.cmd("felt", ["-C", store, "show", @uid, "-j", "--exact"], [])
    assert {:ok, %{uid: @uid}} = Shuttle.FeltStores.resolve_request(@uid, slug)
    assert Shuttle.OwnerExit.local_copy(@uid, "worker", slug)

    api =
      start_supervised!(
        Supervisor.child_spec(
          {Bandit, plug: {ScopedAPI, self()}, port: 0, ip: {127, 0, 0, 1}, startup_log: false},
          id: :viewer
        )
      )

    {:ok, {_, viewer_port}} = ThousandIsland.listener_info(api)
    base = "http://127.0.0.1:#{viewer_port}"
    Env.put_env("SHUTTLE_DAEMON_URL", base)

    env = [
      {"SHUTTLE_HOST", "sender"},
      {"SHUTTLE_DAEMON_URL", base},
      {"SHUTTLE_REMOTES_FILE", remotes},
      {"SHUTTLE_STORES", store}
    ]

    {output, 0} =
      Shuttle.Env.cmd("shuttle", ["-C", store, "rest", @uid], stderr_to_stdout: true, env: env)

    assert_receive {:viewer_lifecycle, 200}
    assert output =~ "Git"
    assert output =~ "no execution request"
    assert File.read!(path) =~ "horizon: stashed"

    {:ok, {{_, 200, _}, _, body}} =
      :httpc.request(:get, {String.to_charlist(base <> "/api/v1/fibers/composite"), []}, [],
        body_format: :binary
      )

    assert [
             %{
               "origin" => "worker",
               "felt_store" => "/owner",
               "fiber" => %{"horizon" => "stashed"}
             }
           ] = Jason.decode!(body)["fibers"]

    # Configuration requires its owner even when a safe exit copy exists.
    before_config = File.read!(path)

    {output, code} =
      Shuttle.Env.cmd("shuttle", ["-C", store, "set-agent", @uid, "claude-sonnet"],
        stderr_to_stdout: true,
        env: env
      )

    assert code != 0
    assert output =~ "no action request was sent"
    assert File.read!(path) == before_config

    {:ok, {{_, 200, _}, _, _}} =
      request(base, "/api/v1/lifecycle", %{
        action: "close",
        fiber: @uid,
        origin: "worker",
        tempered: false
      })

    assert File.read!(path) =~ "tempered: false"

    # The exact same owner row wins again as soon as its feed is healthy.
    owner(row, port)
    :ok = RemoteFiberRegistry.refresh_now()
    refute RemoteFiberRegistry.feeds()["worker"].stale

    {:ok, {{_, 200, _}, _, body}} =
      :httpc.request(:get, {String.to_charlist(base <> "/api/v1/fibers/composite"), []}, [],
        body_format: :binary
      )

    assert [%{"fiber" => fiber, "exit_copy_pending" => true}] = Jason.decode!(body)["fibers"]
    assert fiber["status"] == "open"
    refute Map.has_key?(fiber, "horizon")
    before_retry = File.read!(path)

    {:ok, {{_, 200, _}, _, retry}} =
      request(base, "/api/v1/lifecycle", %{action: "rest", fiber: @uid, origin: "worker"})

    assert retry =~ "invoked"
    assert File.read!(path) == before_retry
    assert_receive {:owner_post, "/api/v1/lifecycle"}

    # Stale cache is not proof that an owner cannot receive a mutation.
    Agent.update(clock, &DateTime.add(&1, 300_000, :millisecond))
    assert RemoteFiberRegistry.feeds()["worker"].stale

    for {endpoint, payload} <- [
          {"/api/v1/lifecycle", %{action: "rest", fiber: @uid, origin: "worker"}},
          {"/api/v1/felt-edit", %{fiber_id: @uid, origin: "worker", set: %{cold: true}}},
          {"/api/v1/transition", %{fiber_id: @uid, origin: "worker", target: "composted"}}
        ] do
      Agent.update(clock, &DateTime.add(&1, 300_000, :millisecond))
      {:ok, {{_, 200, _}, _, _}} = request(base, endpoint, payload)
      assert_receive {:owner_post, ^endpoint}
    end

    {:ok, {{_, 200, _}, _, inferred}} =
      request(base, "/api/v1/transition", %{fiber_id: @uid, target: "composted"})

    assert Jason.decode!(inferred)["origin"] == "worker"
    assert_receive {:owner_post, "/api/v1/transition"}
    refute File.read!(path) =~ "cold: true"

    stop_supervised!(:owner)
    Agent.update(clock, &DateTime.add(&1, 300_000, :millisecond))
    File.write!(path, String.replace(File.read!(path), "status: closed", "status: active"))
    Poller.refresh_document(@uid)
    started = System.monotonic_time(:millisecond)

    {output, code} =
      Shuttle.Env.cmd("shuttle", ["-C", store, "rest", @uid], stderr_to_stdout: true, env: env)

    assert System.monotonic_time(:millisecond) - started < 10_000
    assert code != 0
    assert output =~ "no action request was sent"
    assert output =~ "nothing was applied"
    refute output =~ "may have been applied"
    assert File.read!(path) =~ "status: active"

    Env.put_app_env(:remotes, [])

    {:ok, {{_, 200, _}, _, body}} =
      :httpc.request(
        :get,
        {String.to_charlist(base <> "/api/v1/fibers/" <> @uid <> "?body=true&origin=worker"), []},
        [],
        body_format: :binary
      )

    assert %{"origin" => "worker", "stale" => true, "source" => "local_archive"} =
             Jason.decode!(body)

    assert get_in(Jason.decode!(body), ["fibers", Access.at(0), "fiber", "body"]) =~ "Body"

    if System.get_env("SHUTTLE_OWNER_DOWN_BROWSER") == "1" do
      Env.put_app_env(:remotes, [remote])
      Env.put_env("SHUTTLE_UI_DIST", Path.expand("../../../../ui/dist", __DIR__))
      File.write!(path, draft_document)
      Poller.refresh_document(@uid)

      {output, status} =
        Shuttle.Env.cmd("node", ["e2e/offlineExitsReal.mjs", base, @uid, slug],
          cd: Path.expand("../../../../ui", __DIR__),
          stderr_to_stdout: true
        )

      assert status == 0, output
      IO.puts(output)
      assert File.read!(path) =~ "horizon: stashed"
    end

    {:ok, {{_, 400, _}, _, _}} =
      :httpc.request(
        :get,
        {String.to_charlist(base <> "/api/v1/fibers/" <> @uid <> "?body=true&origin=not-worker"),
         []},
        [],
        body_format: :binary
      )
  end

  @tag :tmp_dir
  test "mirror exits refuse a new arm, owner or vanished UID-less address", %{
    tmp_dir: tmp
  } do
    tmp = Path.expand(tmp)
    stale_owner()

    for race <- [:arm, :owner, :vanish] do
      {store, path} = fixture(Path.join(tmp, to_string(race)))
      raw = File.read!(path) |> String.replace(~r/^id:.*\n/m, "")
      File.write!(path, raw)
      Env.put_app_env(:remotes, [%Remote{name: "worker", url: "http://127.0.0.1:1"}])

      File.write!(
        Path.join(Path.dirname(store), "remotes.json"),
        ~s({"version":1,"defaults":{"discover":false},"remotes":[{"name":"worker","port":1}]})
      )

      Env.put_app_env(:felt_runner, RacingExitRunner)

      {:ok, poller} =
        start_poller!(felt_stores: [store], runner: RacingExitRunner, poll_interval_ms: 3_600_000)

      await_boot_cycle!(poller)
      Env.put_app_env(:owner_down_edit_race, race)

      conn =
        ShuttleWeb.LifecycleController.create(Plug.Test.conn(:post, "/"), %{
          "fiber" => "task",
          "origin" => "worker",
          "action" => "rest"
        })

      assert conn.status == 422, conn.resp_body

      target =
        if race == :vanish, do: Path.join(store, ".felt/elsewhere/task/task.md"), else: path

      after_edit = File.read!(target)
      refute after_edit =~ "shuttle-exit-at:"
      refute after_edit =~ "horizon: stashed"

      case race do
        :arm -> assert after_edit =~ "status: active"
        :owner -> assert after_edit =~ "host: replacement"
        :vanish -> assert after_edit == raw
      end
    end
  end

  @tag :tmp_dir
  test "forwarded lifecycle, transition and felt-edit requests stop at an owner mismatch", %{
    tmp_dir: tmp
  } do
    {_, path} = fixture(Path.expand(tmp))
    before = File.read!(path)
    counter = start_supervised!({Agent, fn -> 0 end})

    api =
      start_supervised!(
        {Bandit,
         plug: {HopAPI, [test: self(), counter: counter]},
         port: 0,
         ip: {127, 0, 0, 1},
         startup_log: false}
      )

    {:ok, {_, port}} = ThousandIsland.listener_info(api)
    base = "http://127.0.0.1:#{port}"
    Env.put_app_env(:remotes, [%Remote{name: "worker", url: base}])

    for {endpoint, params} <- [
          {"/api/v1/lifecycle",
           %{"fiber" => @uid, "action" => "set-outcome", "outcome" => "No loop"}},
          {"/api/v1/transition", %{"fiber_id" => @uid, "target" => "composted"}},
          {"/api/v1/felt-edit", %{"fiber_id" => @uid, "set" => %{"cold" => true}}}
        ] do
      Agent.update(counter, fn _ -> 0 end)
      # Enter the viewer locally; only the forwarded request crosses this HTTP listener.
      conn =
        Shuttle.Test.ApiConn.local_conn(
          :post,
          endpoint,
          Jason.encode!(Map.put(params, "origin", "worker"))
        )
        |> Plug.Conn.put_req_header("content-type", "application/json")
        |> ShuttleWeb.Endpoint.call(ShuttleWeb.Endpoint.init([]))

      assert conn.status == 422, conn.resp_body
      assert Agent.get(counter, & &1) == 1
      assert_receive {:hop, payload, ["1"]}
      refute Map.has_key?(payload, "routed")
      refute_receive {:hop, _, _}, 30
      assert File.read!(path) == before
    end
  end

  @tag :tmp_dir
  test "terminal forwarding strips the host selector on a misnamed remote", %{tmp_dir: tmp} do
    fixture(Path.expand(tmp))
    counter = start_supervised!({Agent, fn -> 0 end})

    api =
      start_supervised!(
        {Bandit,
         plug: {HopAPI, [test: self(), counter: counter]},
         port: 0,
         ip: {127, 0, 0, 1},
         startup_log: false}
      )

    {:ok, {_, port}} = ThousandIsland.listener_info(api)
    Env.put_app_env(:remotes, [%Remote{name: "worker", url: "http://127.0.0.1:#{port}"}])

    conn =
      ShuttleWeb.TerminalController.create(Plug.Test.conn(:post, "/"), %{
        "fiber" => @uid,
        "shuttle_host" => "worker"
      })

    assert conn.status == 404, conn.resp_body
    assert Agent.get(counter, & &1) == 1
    assert_receive {:hop, payload, ["1"]}
    refute Map.has_key?(payload, "shuttle_host")
  end

  for action <- ~w(rest pause close) do
    @tag :tmp_dir
    test "an unknown owner cannot authorize #{action} on an active standing copy", %{
      tmp_dir: tmp
    } do
      {store, path} = fixture(Path.expand(tmp))

      File.write!(
        path,
        "---\nid: #{@uid}\nname: Task\nstatus: active\nshuttle:\n  kind: standing\n  host: worker\n  schedule:\n    expr: '0 9 * * *'\n  runtime:\n    dispatched_at: '2026-11-04T10:00:00Z'\n    run_id: '20261104T100000+0000'\n---\nBody\n"
      )

      Env.put_app_env(:remotes, [])
      before = File.read!(path)

      {:ok, poller} =
        start_poller!(felt_stores: [store], runner: DocumentRunner, poll_interval_ms: 3_600_000)

      await_boot_cycle!(poller)

      conn =
        ShuttleWeb.LifecycleController.create(Plug.Test.conn(:post, "/"), %{
          "fiber" => @uid,
          "origin" => "worker",
          "action" => unquote(action)
        })

      assert conn.status == 400, conn.resp_body
      assert File.read!(path) == before
    end
  end

  @tag :tmp_dir
  test "unknown discovery and scheduled standing work cannot authorize mirror exits", %{
    tmp_dir: tmp
  } do
    {_, path} = fixture(Path.expand(tmp))
    File.write!(path, String.replace(File.read!(path), "status: open", "status: active"))
    Env.put_app_env(:remotes, nil)
    File.write!(Path.join(Path.expand(tmp), "remotes.json"), ~s({"version":1,"remotes":[]}))
    before = File.read!(path)
    refute Shuttle.OwnerExit.local_copy(@uid, "worker")

    conn =
      ShuttleWeb.LifecycleController.create(Plug.Test.conn(:post, "/"), %{
        "fiber" => @uid,
        "origin" => "worker",
        "action" => "rest"
      })

    assert conn.status == 400
    assert File.read!(path) == before

    File.write!(
      path,
      String.replace(before, "status: active", "status: closed")
      |> String.replace("kind: oneshot", "kind: standing\n  schedule:\n    expr: '0 9 * * *'")
    )

    Env.put_app_env(:remotes, [%Remote{name: "worker", url: "http://127.0.0.1:1"}])
    before = File.read!(path)

    for params <- [%{"action" => "rest"}, %{"action" => "close", "tempered" => false}] do
      conn =
        ShuttleWeb.LifecycleController.create(
          Plug.Test.conn(:post, "/"),
          Map.merge(params, %{"fiber" => @uid, "origin" => "worker"})
        )

      assert conn.status == 502
      assert File.read!(path) == before
      refute Shuttle.OwnerExit.local_copy(@uid, "worker")
    end
  end

  @tag :tmp_dir
  test "exit copies and transition replies preserve the Git/no-execution contract", %{
    tmp_dir: tmp
  } do
    {store, path} = fixture(Path.expand(tmp))
    Env.put_app_env(:remotes, [%Remote{name: "worker", url: "http://127.0.0.1:1"}])

    File.write!(
      Path.join(Path.expand(tmp), "remotes.json"),
      ~s({"version":1,"defaults":{"discover":false},"remotes":[{"name":"worker","port":1}]})
    )

    {:ok, poller} =
      start_poller!(felt_stores: [store], runner: DocumentRunner, poll_interval_ms: 3_600_000)

    await_boot_cycle!(poller)
    stale_owner()
    assert Shuttle.OwnerExit.local_copy(@uid, "worker")

    conn =
      Shuttle.Test.ApiConn.local_conn(
        :post,
        "/api/v1/transition",
        Jason.encode!(%{fiber_id: @uid, origin: "worker", target: "composted"})
      )
      |> Plug.Conn.put_req_header("content-type", "application/json")
      |> ShuttleWeb.Endpoint.call(ShuttleWeb.Endpoint.init([]))

    assert conn.status == 200, conn.resp_body

    assert %{"saved_locally" => true, "execution_requested" => false, "message" => output} =
             Jason.decode!(conn.resp_body)

    assert output =~ "Git"
    assert output =~ "no execution request was sent"
    refute output =~ "explicit local"
    assert File.read!(path) =~ "shuttle-exit-at:"
  end

  @tag :tmp_dir
  test "a mirror exit changes no runtime bytes and keeps its intent outside shuttle", %{
    tmp_dir: tmp
  } do
    {store, path} = fixture(Path.expand(tmp))

    source =
      "---\nid: #{@uid}\nname: 'Task'\nstatus: 'open'\nhorizon: near\nshuttle:\n  kind: oneshot\n  host: worker\n  agent: 'sol'\n  runtime:\n    # durable owner evidence\n    dispatched_at: '2026-11-04T10:00:00Z'\n    handed_off_at: '2026-11-04T11:00:00Z'\n    thread_exit_verb: rearmed\n    quiet_closed_at: '2026-11-04T11:00:00Z'\n---\n\nBody with  spaces.\n"

    File.write!(path, source)
    stale_owner()

    {:ok, poller} =
      start_poller!(felt_stores: [store], runner: DocumentRunner, poll_interval_ms: 3_600_000)

    await_boot_cycle!(poller)

    conn =
      ShuttleWeb.LifecycleController.create(Plug.Test.conn(:post, "/"), %{
        "fiber" => @uid,
        "origin" => "worker",
        "action" => "rest"
      })

    assert conn.status == 200, conn.resp_body
    after_exit = File.read!(path)
    owner_bytes = fn text -> text |> String.split("shuttle:\n", parts: 2) |> List.last() end
    assert owner_bytes.(after_exit) == owner_bytes.(source)
    assert after_exit =~ "shuttle-exit-at:"
    assert after_exit =~ "status: 'open'"
  end

  @tag :tmp_dir
  test "a vanished UID-less transition cannot target a same-leaf document", %{tmp_dir: tmp} do
    tmp = Path.expand(tmp)
    {store, path} = fixture(tmp)
    body = File.read!(path) |> String.replace("id: #{@uid}\n", "")
    File.write!(path, body)
    other = Path.join([store, ".felt", "elsewhere", "task", "task.md"])
    File.mkdir_p!(Path.dirname(other))
    File.write!(other, body)
    stale_owner()

    {:ok, poller} =
      start_poller!(
        felt_stores: [store],
        runner: VanishingTransitionRunner,
        poll_interval_ms: 3_600_000
      )

    await_boot_cycle!(poller)

    conn =
      Shuttle.Test.ApiConn.local_conn(
        :post,
        "/api/v1/transition",
        Jason.encode!(%{fiber_id: "task", origin: "worker", target: "composted"})
      )
      |> Plug.Conn.put_req_header("content-type", "application/json")
      |> ShuttleWeb.Endpoint.call(ShuttleWeb.Endpoint.init([]))

    assert conn.status == 422, conn.resp_body
    refute File.exists?(path)
    assert File.read!(other) == body
  end
end
