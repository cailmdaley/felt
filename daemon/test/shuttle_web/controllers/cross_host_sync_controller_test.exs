defmodule ShuttleWeb.CrossHostSyncControllerTest do
  use ExUnit.Case, async: true
  import Shuttle.Test.ApiConn
  import Phoenix.ConnTest
  @endpoint ShuttleWeb.Endpoint
  @moduletag :tmp_dir

  defmodule NoSyncRunner do
    def cmd("felt", args, opts) do
      if "sync" in args, do: Agent.update(Shuttle.Env.app(:sync_counter), &(&1 + 1))
      Shuttle.Runner.Default.cmd("felt", args, Keyword.put_new(opts, :stderr_to_stdout, true))
    end

    def cmd(executable, args, opts), do: Shuttle.Runner.Default.cmd(executable, args, opts)
  end

  setup %{tmp_dir: root} do
    owner = Path.join(root, "owner")
    File.mkdir_p!(Path.join(owner, ".felt"))
    File.write!(Path.join(owner, ".felt/.keep"), "")
    counter = start_supervised!({Agent, fn -> 0 end})
    Shuttle.Test.Env.put_env("SHUTTLE_STORES", owner)
    Shuttle.Test.Env.put_env("SHUTTLE_HOST", "test-host")
    Shuttle.Test.Env.put_env("SHUTTLE_DATA_DIR", Path.join(root, "shuttle-data"))
    Shuttle.Test.Env.put_env("SHUTTLE_SESSIONS_FILE", Path.join(root, "sessions.jsonl"))
    Shuttle.Test.Env.put_app_env(:app_workers_dir, Path.join(root, "app-workers"))
    Shuttle.Test.Env.put_app_env(:felt_runner, NoSyncRunner)
    Shuttle.Test.Env.put_app_env(:sync_counter, counter)
    {:ok, owner: owner, counter: counter}
  end

  test "missing fiber reads and lifecycle requests return host-qualified not-found without syncing",
       %{
         counter: counter,
         owner: owner
       } do
    conn = get(api_conn(), "/api/v1/fibers/absent")
    assert conn.status == 404
    assert Jason.decode!(conn.resp_body)["error"] =~ "fiber not found on test-host: absent"

    conn =
      post(
        api_conn(),
        "/api/v1/lifecycle",
        Jason.encode!(%{"action" => "resume", "fiber" => "absent"})
      )

    assert conn.status == 404
    assert conn.resp_body =~ "fiber not found on test-host: absent"

    {:ok, poller} =
      Shuttle.Test.PollerHelpers.start_poller!(
        runner: NoSyncRunner,
        felt_stores: [owner],
        own_host_id: "test-host",
        poll_interval_ms: 600_000
      )

    Shuttle.Test.PollerHelpers.await_boot_cycle!(poller)
    conn = post(api_conn(), "/api/v1/dispatch", Jason.encode!(%{"fiber_id" => "absent"}))
    assert conn.status == 404
    assert Jason.decode!(conn.resp_body)["error"] =~ "fiber not found on test-host: absent"
    assert Agent.get(counter, & &1) == 0
  end

  test "project directory validation runs in the owner environment", %{owner: owner} do
    Shuttle.Test.Env.put_env("WORK", owner)
    conn = post(api_conn(), "/api/v1/project-dir/resolve", Jason.encode!(%{"path" => "$WORK"}))
    assert conn.status == 200
    assert Jason.decode!(conn.resp_body)["path"] == owner

    conn =
      post(
        api_conn(),
        "/api/v1/project-dir/resolve",
        Jason.encode!(%{"path" => Path.join(owner, "absent")})
      )

    assert conn.status == 422
  end

  test "project directory validation forwards before touching the hub filesystem" do
    client = Shuttle.Test.StubPostClient

    Shuttle.Test.ForwardStub.stub_forward(
      "destination",
      "http://destination.invalid",
      {:ok, 200, ~s({"path":"/remote/project"})},
      client
    )

    conn =
      post(
        api_conn(),
        "/api/v1/project-dir/resolve",
        Jason.encode!(%{"origin" => "destination", "path" => "$WORK/project"})
      )

    assert conn.status == 200
    assert Jason.decode!(conn.resp_body) == %{"path" => "/remote/project"}

    assert %{url: "http://destination.invalid/api/v1/project-dir/resolve", body: body} =
             client.last()

    assert Jason.decode!(body) == %{"path" => "$WORK/project"}

    conn =
      post(
        api_conn(),
        "/api/v1/project-dir/resolve",
        Jason.encode!(%{"origin" => "unknown", "path" => "/tmp"})
      )

    assert conn.status == 400
    assert [_only_forward] = client.posts()
  end
end
