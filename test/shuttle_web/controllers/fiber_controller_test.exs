defmodule ShuttleWeb.FiberControllerTest do
  use ExUnit.Case
  import Phoenix.ConnTest
  import Plug.Conn

  @endpoint ShuttleWeb.Endpoint

  # POST transport stub for the cross-host create forward test. Records the last
  # (url, body) it was asked to POST and replays a scripted response, so the
  # forward leg is exercised without a real tunnel.
  defmodule StubPostClient do
    use Agent

    def start_link(_ \\ []),
      do: Agent.start_link(fn -> %{response: nil, last: nil} end, name: __MODULE__)

    def set_response(response), do: Agent.update(__MODULE__, &Map.put(&1, :response, response))
    def last, do: Agent.get(__MODULE__, & &1.last)

    def post(url, body, _content_type, _timeout_ms) do
      Agent.update(__MODULE__, &Map.put(&1, :last, %{url: url, body: body}))
      Agent.get(__MODULE__, & &1.response)
    end
  end

  setup do
    tmp =
      Path.join(
        System.tmp_dir!(),
        "shuttle-fiber-controller-#{System.unique_integer([:positive])}"
      )

    File.mkdir_p!(tmp)

    old_loom_home = System.get_env("LOOM_HOME")
    old_loom_homes = System.get_env("LOOM_HOMES")
    old_felt_stores_file = System.get_env("SHUTTLE_FELT_STORES_FILE")
    old_shuttle_host = System.get_env("SHUTTLE_HOST")

    System.put_env("LOOM_HOME", tmp)
    System.delete_env("LOOM_HOMES")
    System.put_env("SHUTTLE_FELT_STORES_FILE", Path.join(tmp, "felt_stores.json"))
    # Pin the daemon's identity for this test via the env var — the
    # Application config path is gone. Test assertions read `test-host`
    # back from the auto-stamped shuttle.host field.
    System.put_env("SHUTTLE_HOST", "test-host")

    on_exit(fn ->
      restore_env("LOOM_HOME", old_loom_home)
      restore_env("LOOM_HOMES", old_loom_homes)
      restore_env("SHUTTLE_FELT_STORES_FILE", old_felt_stores_file)
      restore_env("SHUTTLE_HOST", old_shuttle_host)

      File.rm_rf(tmp)
    end)

    {:ok, tmp: tmp}
  end

  test "POST /api/v1/fiber/create writes a daemon-local fiber with host default", %{tmp: tmp} do
    conn =
      api_conn()
      |> post(
        "/api/v1/fiber/create",
        Jason.encode!(%{
          id: "tests/create-me",
          name: "Create me",
          body: "hello\n",
          frontmatter: %{
            tags: ["constitution"],
            shuttle: %{
              enabled: true,
              kind: "oneshot",
              project_dir: tmp
            }
          }
        })
      )

    assert %{"id" => "tests/create-me", "path" => path} = Jason.decode!(conn.resp_body)
    assert conn.status == 200
    # felt owns placement and returns its carried (symlink-canonicalized) path.
    assert_felt_path(path, tmp, ["tests", "create-me", "create-me.md"])

    assert {:ok, %{"id" => uid} = parsed} =
             path
             |> File.read!()
             |> frontmatter()
             |> YamlElixir.read_from_string()

    # felt mints an intrinsic ULID on `add`, so POST-created fibers are born
    # with a real identity instead of a uid-less raw write.
    assert is_binary(uid) and String.match?(uid, ~r/^[0-9A-HJKMNP-TV-Z]{26}$/)

    assert %{
             "name" => "Create me",
             "status" => "active",
             "shuttle" => %{"host" => "test-host", "project_dir" => ^tmp}
           } = parsed
  end

  test "POST /api/v1/fiber/create writes under shuttle.project_dir when it differs from daemon root", %{
    tmp: tmp
  } do
    daemon_root = Path.join(tmp, "daemon-root")
    project_dir = Path.join(tmp, "project-dir")
    File.mkdir_p!(daemon_root)
    File.mkdir_p!(project_dir)
    System.put_env("LOOM_HOME", daemon_root)

    conn =
      api_conn()
      |> post(
        "/api/v1/fiber/create",
        Jason.encode!(%{
          id: "tests/project-local",
          name: "Project local",
          body: "hello\n",
          frontmatter: %{
            status: "open",
            shuttle: %{
              enabled: false,
              kind: "oneshot",
              project_dir: project_dir
            }
          }
        })
      )

    assert %{"id" => "tests/project-local", "path" => path} = Jason.decode!(conn.resp_body)
    assert conn.status == 200

    assert_felt_path(path, project_dir, ["tests", "project-local", "project-local.md"])

    refute File.exists?(Path.join([daemon_root, ".felt", "tests", "project-local", "project-local.md"]))
  end

  test "POST /api/v1/fiber/create rejects armed fibers without project_dir" do
    # The controller defaults status to active (armed); an armed shuttle block
    # (slice 5: status is the gate, no enabled flag) requires a project_dir.
    conn =
      api_conn()
      |> post(
        "/api/v1/fiber/create",
        Jason.encode!(%{
          id: "tests/missing-project",
          name: "Missing project",
          frontmatter: %{shuttle: %{kind: "oneshot"}}
        })
      )

    assert conn.status == 400

    assert %{"error" => "shuttle.project_dir is required when status: active"} =
             Jason.decode!(conn.resp_body)
  end

  test "POST /api/v1/fiber/create forwards a remote-origin create to the owning daemon", %{
    tmp: tmp
  } do
    start_supervised!(StubPostClient)

    StubPostClient.set_response(
      {:ok, 200, Jason.encode!(%{"id" => "tests/remote-stash", "path" => "/candide/.felt/…"})}
    )

    previous_remotes = Application.get_env(:shuttle, :remotes)
    previous_client = Application.get_env(:shuttle, :write_forward_client)
    Application.put_env(:shuttle, :remotes, [%{name: "candide", url: "http://localhost:4001"}])
    Application.put_env(:shuttle, :write_forward_client, StubPostClient)

    on_exit(fn ->
      restore_app_env(:remotes, previous_remotes)
      restore_app_env(:write_forward_client, previous_client)
    end)

    conn =
      api_conn()
      |> post(
        "/api/v1/fiber/create",
        Jason.encode!(%{
          id: "tests/remote-stash",
          name: "Remote stash",
          body: "hi\n",
          origin: "candide",
          frontmatter: %{status: "open", shuttle: %{kind: "oneshot", project_dir: tmp}}
        })
      )

    # The remote owner's verbatim response is relayed; nothing is written locally.
    assert conn.status == 200
    assert %{"id" => "tests/remote-stash"} = Jason.decode!(conn.resp_body)
    refute File.exists?(Path.join([tmp, ".felt", "tests", "remote-stash", "remote-stash.md"]))

    # Forwarded to the owning remote's identical create, origin stripped so the
    # owner writes it as local and auto-stamps its own host.
    last = StubPostClient.last()
    assert last.url == "http://localhost:4001/api/v1/fiber/create"
    forwarded = Jason.decode!(last.body)
    refute Map.has_key?(forwarded, "origin")
    assert forwarded["id"] == "tests/remote-stash"
    assert forwarded["frontmatter"]["shuttle"]["project_dir"] == tmp
  end

  test "POST /api/v1/fiber/create with an unknown origin falls through to a local write", %{
    tmp: tmp
  } do
    # An origin matching no configured remote degrades to :local, where the
    # endpoint's own resolution arbitrates — never a silent wrong-host write.
    # A remote IS configured here, so the test proves the fall-through
    # discriminates: "ghost" doesn't match "candide", so it stays local and the
    # forward plane is never touched.
    start_supervised!(StubPostClient)
    previous_remotes = Application.get_env(:shuttle, :remotes)
    previous_client = Application.get_env(:shuttle, :write_forward_client)
    Application.put_env(:shuttle, :remotes, [%{name: "candide", url: "http://localhost:4001"}])
    Application.put_env(:shuttle, :write_forward_client, StubPostClient)

    on_exit(fn ->
      restore_app_env(:remotes, previous_remotes)
      restore_app_env(:write_forward_client, previous_client)
    end)

    conn =
      api_conn()
      |> post(
        "/api/v1/fiber/create",
        Jason.encode!(%{
          id: "tests/ghost-origin",
          name: "Ghost origin",
          origin: "ghost",
          frontmatter: %{status: "open", shuttle: %{kind: "oneshot", project_dir: tmp}}
        })
      )

    assert conn.status == 200
    assert %{"id" => "tests/ghost-origin"} = Jason.decode!(conn.resp_body)
    assert File.exists?(Path.join([tmp, ".felt", "tests", "ghost-origin", "ghost-origin.md"]))
    # Wrote locally, never forwarded — the unknown origin did not reach the tunnel.
    assert StubPostClient.last() == nil
  end

  test "POST /api/v1/fiber/create rejects cross-host blocks", %{tmp: tmp} do
    conn =
      api_conn()
      |> post(
        "/api/v1/fiber/create",
        Jason.encode!(%{
          id: "tests/wrong-host",
          name: "Wrong host",
          frontmatter: %{
            shuttle: %{enabled: true, kind: "oneshot", host: "candide", project_dir: tmp}
          }
        })
      )

    assert conn.status == 400
    assert %{"error" => error} = Jason.decode!(conn.resp_body)
    assert error =~ "does not match this daemon host"
  end

  defp api_conn do
    build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
  end

  defp frontmatter(content) do
    [_, frontmatter | _] = String.split(content, "---\n", parts: 3)
    frontmatter
  end

  # felt carries the symlink-canonicalized absolute path (on macOS the tmp root
  # resolves /var/... -> /private/var/...). The store-relative tail is stable, so
  # assert on that plus on-disk existence rather than the symlink-prefixed root.
  defp assert_felt_path(path, root, segments) do
    tail = Path.join([".felt"] ++ segments)
    assert String.ends_with?(path, tail), "#{path} does not end with #{tail}"
    assert File.exists?(path)
    # The carried path resolves back to the expected store-relative location.
    assert File.exists?(Path.join([root, ".felt"] ++ segments))
  end

  defp restore_env(key, nil), do: System.delete_env(key)
  defp restore_env(key, value), do: System.put_env(key, value)

  defp restore_app_env(key, nil), do: Application.delete_env(:shuttle, key)
  defp restore_app_env(key, value), do: Application.put_env(:shuttle, key, value)
end
