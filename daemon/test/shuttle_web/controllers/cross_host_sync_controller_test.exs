defmodule ShuttleWeb.CrossHostSyncControllerTest do
  use ExUnit.Case, async: true
  import Shuttle.Test.ApiConn
  import Phoenix.ConnTest
  @endpoint ShuttleWeb.Endpoint
  @moduletag :tmp_dir

  defmodule CountingRunner do
    def cmd("felt", ["-C", _store, "sync"] = args, opts) do
      Agent.update(Shuttle.Env.app(:sync_counter), &(&1 + 1))
      Shuttle.Runner.Default.cmd("felt", args, opts)
    end

    def cmd(executable, args, opts) when executable in ["felt", "shuttle"],
      do: Shuttle.Runner.Default.cmd(executable, args, opts)

    def cmd("tmux", _args, _opts), do: {"no server running on /tmp/test-tmux", 1}
    def cmd("ps", _args, _opts), do: {"", 0}
    def cmd(_executable, _args, _opts), do: {"", 1}
  end

  setup %{tmp_dir: root} do
    origin = Path.join(root, "origin.git")
    writer = Path.join(root, "writer")
    owner = Path.join(root, "owner")
    git!(root, ["init", "--bare", origin])
    git!(root, ["clone", origin, writer])
    File.mkdir_p!(Path.join(writer, ".felt"))
    File.write!(Path.join(writer, ".felt/.keep"), "")
    git!(writer, ["add", "."])
    git!(writer, ["commit", "-m", "Initialize store"])
    git!(writer, ["push", "-u", "origin", "HEAD"])
    git!(root, ["clone", origin, owner])
    # The fiber is published only after the owner's clone, reproducing store lag.
    File.mkdir_p!(Path.join(writer, ".felt/work/task"))

    File.write!(Path.join(writer, ".felt/work/task/task.md"), """
    ---
    id: 01J00000000000000000000000
    name: Remote work
    status: open
    shuttle:
      kind: oneshot
      host: worker
      agent: claude-opus
      project_dir: #{owner}
    ---

    Work from the owning host.
    """)

    git!(writer, ["add", "."])
    git!(writer, ["commit", "-m", "Publish remote thread"])
    git!(writer, ["push"])
    counter = start_supervised!({Agent, fn -> 0 end})
    Shuttle.Test.Env.put_env("SHUTTLE_STORES", owner)
    Shuttle.Test.Env.put_env("SHUTTLE_HOST", "worker")
    Shuttle.Test.Env.put_app_env(:felt_runner, CountingRunner)
    Shuttle.Test.Env.put_app_env(:sync_counter, counter)
    {:ok, owner: owner, counter: counter}
  end

  for action <- ["resume", "reopen", "set-outcome"] do
    test "#{action} pulls an absent published fiber before writing", %{
      owner: owner,
      counter: counter
    } do
      action = unquote(action)
      params = %{"action" => action, "fiber" => "work/task", "outcome" => "Done"}
      conn = post(api_conn(), "/api/v1/lifecycle", Jason.encode!(params))
      assert conn.status == 200, conn.resp_body
      content = File.read!(Path.join(owner, ".felt/work/task/task.md"))

      if action == "set-outcome",
        do: assert(content =~ "outcome: Done"),
        else: assert(content =~ "status: active")

      assert Agent.get(counter, & &1) == 1
    end
  end

  test "show pulls once and missing requests share the cooldown", %{counter: counter} do
    conn = get(api_conn(), "/api/v1/fibers/work/task?body=true")
    assert conn.status == 200, conn.resp_body

    assert [%{"fiber" => %{"name" => "Remote work", "body" => body}}] =
             Jason.decode!(conn.resp_body)["fibers"]

    assert body =~ "Work from the owning host."

    for id <- ["absent-one", "absent-two"] do
      conn = get(api_conn(), "/api/v1/fibers/#{id}")
      assert conn.status == 404, conn.resp_body
      assert Jason.decode!(conn.resp_body)["error"] =~ "fiber not found on test-host after sync"
    end

    assert Agent.get(counter, & &1) == 1
  end

  test "missing lifecycle requests return a clear 404 after one pull", %{counter: counter} do
    for action <- ["resume", "reopen", "close"] do
      conn =
        post(
          api_conn(),
          "/api/v1/lifecycle",
          Jason.encode!(%{"action" => action, "fiber" => "absent"})
        )

      assert conn.status == 404, conn.resp_body
      assert conn.resp_body =~ "fiber not found on test-host after sync"
    end

    assert Agent.get(counter, & &1) == 1
  end

  test "dispatch pulls on a miss inside the real Poller and reports absent fibers", %{
    owner: owner,
    counter: counter
  } do
    {:ok, poller} =
      Shuttle.Test.PollerHelpers.start_poller!(
        runner: CountingRunner,
        felt_stores: [owner],
        own_host_id: "test-host",
        poll_interval_ms: 600_000
      )

    Shuttle.Test.PollerHelpers.await_boot_cycle!(poller)
    conn = post(api_conn(), "/api/v1/dispatch", Jason.encode!(%{"fiber_id" => "work/task"}))
    assert conn.status == 422, conn.resp_body
    assert File.exists?(Path.join(owner, ".felt/work/task/task.md"))
    conn = post(api_conn(), "/api/v1/dispatch", Jason.encode!(%{"fiber_id" => "absent"}))
    assert conn.status == 404, conn.resp_body
    assert Jason.decode!(conn.resp_body)["error"] =~ "fiber not found on test-host after sync"
    assert Agent.get(counter, & &1) == 1
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

  defp git!(cwd, args) do
    {output, status} =
      System.cmd("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid" | args],
        cd: cwd,
        stderr_to_stdout: true
      )

    assert status == 0, output
    output
  end
end
