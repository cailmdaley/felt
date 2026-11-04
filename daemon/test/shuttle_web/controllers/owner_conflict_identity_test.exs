defmodule ShuttleWeb.OwnerConflictIdentityTest do
  use ExUnit.Case, async: true
  import Shuttle.Test.ApiConn
  import Phoenix.ConnTest
  alias Shuttle.Test.Env
  @endpoint ShuttleWeb.Endpoint
  @uid "01ARZ3NDEKTSV4RRFFQ69G5FAX"

  defmodule ScopedAPI do
    @behaviour Plug
    def init(owner), do: owner

    def call(conn, owner) do
      Shuttle.Env.adopt_callers([owner])
      ShuttleWeb.Endpoint.call(conn, ShuttleWeb.Endpoint.init([]))
    end
  end

  @tag :tmp_dir
  test "owner conflict markers refuse UID transfer and retain the real sender draft", %{
    tmp_dir: tmp
  } do
    sender = Path.join(tmp, "sender")
    owner = Path.join(tmp, "owner")
    project = Path.join(tmp, "project")
    File.mkdir_p!(project)
    src = Path.join(sender, ".felt/team/worker/worker.md")
    bad = Path.join(owner, ".felt/a/worker/worker.md")
    File.mkdir_p!(Path.dirname(src))
    File.mkdir_p!(Path.dirname(bad))

    source =
      "---\nid: #{@uid}\nname: Worker\nstatus: open\nshuttle:\n  kind: oneshot\n  host: test-host\n  agent: claude-opus\n  project_dir: #{project}\n---\nOriginal body\n"

    corrupt =
      "---\nid: #{@uid}\nname: Worker\n<<<<<<< HEAD\nstatus: open\n=======\nstatus: active\n>>>>>>> branch\n---\nOwner body\n"

    File.write!(src, source)
    File.write!(bad, corrupt)
    Env.put_env("SHUTTLE_STORES", owner)

    api =
      start_supervised!(
        {Bandit, plug: {ScopedAPI, self()}, port: 0, ip: {127, 0, 0, 1}, startup_log: false}
      )

    {:ok, {_, port}} = ThousandIsland.listener_info(api)
    remotes = Path.join(tmp, "remotes.json")

    File.write!(
      remotes,
      Jason.encode!(%{
        version: 1,
        defaults: %{discover: false},
        remotes: [%{name: "test-host", port: port}]
      })
    )

    before =
      post(api_conn(), "/api/v1/lifecycle", Jason.encode!(%{action: "resume", fiber: @uid}))

    {output, code} =
      Shuttle.Env.cmd("shuttle", ["-C", sender, "resume", "team/worker"],
        stderr_to_stdout: true,
        env: [
          {"SHUTTLE_HOST", "sender"},
          {"SHUTTLE_DAEMON_URL", "http://127.0.0.1:#{port}"},
          {"SHUTTLE_REMOTES_FILE", remotes},
          {"SHUTTLE_STORES", sender}
        ]
      )

    assert File.exists?(src), "lost sender draft: #{output}"
    assert code != 0, output
    assert before.status not in [200, 404]

    create =
      post(
        api_conn(),
        "/api/v1/fiber/create",
        Jason.encode!(%{
          id: "duplicate/worker",
          uid: @uid,
          name: "Worker",
          frontmatter: %{status: "open"}
        })
      )

    assert create.status == 400
    assert Path.wildcard(Path.join(owner, ".felt/**/*.md")) == [bad]
    assert File.read!(src) == source
    assert File.read!(bad) == corrupt
  end
end
