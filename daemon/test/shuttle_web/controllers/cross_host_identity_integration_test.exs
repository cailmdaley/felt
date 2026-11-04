defmodule ShuttleWeb.CrossHostIdentityIntegrationTest do
  use ExUnit.Case, async: true
  alias Shuttle.Test.Env

  defmodule ScopedAPI do
    @behaviour Plug
    def init(owner), do: owner

    def call(conn, owner) do
      Shuttle.Env.adopt_callers([owner])
      ShuttleWeb.Endpoint.call(conn, ShuttleWeb.Endpoint.init([]))
    end
  end

  @tag :tmp_dir
  test "a real sender transfers beside the owner's linked ancestor", %{tmp_dir: tmp} do
    sender = Path.join(tmp, "sender")
    owner = Path.join(tmp, "owner")
    project = Path.join(tmp, "project")
    id = "ai-futures/lightcone/hub/measure"
    uid = "01ARZ3NDEKTSV4RRFFQ69G5FAX"
    source = Path.join([sender, ".felt", id, "measure.md"])
    parent = Path.join(project, ".felt/hub/hub.md")
    File.mkdir_p!(Path.dirname(source))
    File.mkdir_p!(Path.dirname(parent))
    File.mkdir_p!(Path.join(owner, ".felt/ai-futures"))
    File.ln_s!(Path.join(project, ".felt"), Path.join(owner, ".felt/ai-futures/lightcone"))
    File.write!(parent, "---\nname: Hub\nstatus: open\n---\nParent\n")

    File.write!(
      source,
      "---\nid: #{uid}\nname: Measure\nstatus: open\nshuttle:\n  kind: oneshot\n  host: test-host\n  agent: claude-opus\n  project_dir: #{project}\n---\nOriginal body\n"
    )

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

    assert {output, 0} =
             Shuttle.Env.cmd("shuttle", ["-C", sender, "resume", id],
               stderr_to_stdout: true,
               env: [
                 {"SHUTTLE_HOST", "sender"},
                 {"SHUTTLE_DAEMON_URL", "http://127.0.0.1:#{port}"},
                 {"SHUTTLE_REMOTES_FILE", remotes},
                 {"SHUTTLE_STORES", sender}
               ]
             )

    assert output =~ "armed"
    refute File.exists?(source)
    {:ok, expected} = Shuttle.Realpath.resolve(Path.join(project, ".felt/hub/measure/measure.md"))

    assert {:ok, %{fiber_id: "hub/measure", path: ^expected, uid: ^uid}} =
             Shuttle.FeltStores.resolve_request(uid)

    assert File.read!(expected) =~ "Original body"
    assert File.read!(expected) =~ "status: active"
    refute File.exists?(Path.join(project, ".felt/ai-futures"))
  end

  @tag :tmp_dir
  test "a real sender transfers drafts into the real owner's polled namespace across both views",
       %{tmp_dir: tmp} do
    api =
      start_supervised!(
        {Bandit, plug: {ScopedAPI, self()}, port: 0, ip: {127, 0, 0, 1}, startup_log: false}
      )

    {:ok, {_, port}} = ThousandIsland.listener_info(api)

    for topology <- ["subtree-to-loom", "loom-to-project-view"] do
      base = Path.join(tmp, topology)
      sender = Path.join(base, "sender")
      owner = Path.join(base, "owner")
      project = Path.join(base, "owner-project")
      view = Path.join(base, "sender-project")
      id = "science/team/hub/draft"
      uid = "01ARZ3NDEKTSV4RRFFQ69G5FAX"
      source = Path.join([sender, ".felt", id, "draft.md"])
      File.mkdir_p!(Path.dirname(source))
      File.mkdir_p!(Path.join(owner, ".felt/science/team"))
      File.mkdir_p!(project)
      File.mkdir_p!(view)
      File.ln_s!(Path.join(sender, ".felt/science/team"), Path.join(view, ".felt"))

      stores =
        if topology == "loom-to-project-view" do
          File.ln_s!(Path.join(owner, ".felt/science/team"), Path.join(project, ".felt"))
          owner <> "," <> project
        else
          owner
        end

      Env.put_env("SHUTTLE_STORES", stores)

      File.write!(
        source,
        "---\nid: #{uid}\nname: Draft\nstatus: open\nshuttle:\n  kind: oneshot\n  host: test-host\n  agent: claude-opus\n  project_dir: #{project}\n---\nOriginal body\n"
      )

      remotes = Path.join(base, "remotes.json")

      File.write!(
        remotes,
        Jason.encode!(%{
          version: 1,
          defaults: %{discover: false},
          remotes: [%{name: "test-host", port: port}]
        })
      )

      {cwd, query} = if topology == "subtree-to-loom", do: {view, "hub/draft"}, else: {sender, id}

      assert {output, 0} =
               Shuttle.Env.cmd("shuttle", ["-C", cwd, "resume", query],
                 stderr_to_stdout: true,
                 env: [
                   {"SHUTTLE_HOST", "sender"},
                   {"SHUTTLE_DAEMON_URL", "http://127.0.0.1:#{port}"},
                   {"SHUTTLE_REMOTES_FILE", remotes},
                   {"SHUTTLE_STORES", sender}
                 ]
               )

      assert output =~ "armed"
      refute File.exists?(source)

      assert {:ok, %{fiber_id: ^id, uid: ^uid, path: path}} =
               Shuttle.FeltStores.resolve_request(uid)

      {:ok, expected} = Shuttle.Realpath.resolve(Path.join([owner, ".felt", id, "draft.md"]))
      assert path == expected
      assert File.read!(path) =~ "Original body"
      assert File.read!(path) =~ "status: active"
      assert Path.wildcard(Path.join([owner, ".felt", "**", "draft.md"])) == [expected]
      if topology == "subtree-to-loom", do: refute(File.exists?(Path.join(project, ".felt")))

      # Exercise the armed-thread create path too, with no echoing owner stub.
      parent = Path.join([sender, ".felt", "science/team/hub/hub.md"])

      File.write!(
        parent,
        "---\nid: 01ARZ3NDEKTSV4RRFFQ69G5FAW\nname: Hub\nstatus: active\nshuttle:\n  kind: oneshot\n  host: test-host\n  agent: claude-opus\n  project_dir: #{project}\n---\nHub\n"
      )

      parent_query = if topology == "subtree-to-loom", do: "hub", else: "science/team/hub"

      assert {created, 0} =
               Shuttle.Env.cmd(
                 "shuttle",
                 ["-C", cwd, "thread", parent_query, "Measure", "--json"],
                 stderr_to_stdout: true,
                 env: [
                   {"SHUTTLE_HOST", "sender"},
                   {"SHUTTLE_DAEMON_URL", "http://127.0.0.1:#{port}"},
                   {"SHUTTLE_REMOTES_FILE", remotes},
                   {"SHUTTLE_STORES", sender}
                 ]
               )

      assert %{"id" => "science/team/hub/measure", "uid" => child_uid} = Jason.decode!(created)
      assert Shuttle.ULID.valid?(child_uid)

      assert {:ok, %{fiber_id: "science/team/hub/measure", path: child_path}} =
               Shuttle.FeltStores.resolve_request(child_uid)

      {:ok, child_expected} =
        Shuttle.Realpath.resolve(Path.join([owner, ".felt/science/team/hub/measure/measure.md"]))

      assert child_path == child_expected
      assert File.read!(child_path) =~ "status: active"
      refute File.exists?(Path.join([sender, ".felt/science/team/hub/measure/measure.md"]))
    end
  end
end
