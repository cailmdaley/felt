defmodule ShuttleWeb.FiberControllerTest do
  use ExUnit.Case, async: true
  import Shuttle.Test.ApiConn
  import Phoenix.ConnTest
  import Plug.Conn

  @endpoint ShuttleWeb.Endpoint

  alias Shuttle.Test.{Env, StubPostClient}

  setup do
    tmp =
      Path.join(
        System.tmp_dir!(),
        "shuttle-fiber-controller-#{System.unique_integer([:positive])}"
      )

    File.mkdir_p!(tmp)

    Env.put_env("SHUTTLE_STORES", tmp)
    Env.put_env("SHUTTLE_STORES_FILE", Path.join(tmp, "felt_stores.json"))
    # Pin the daemon's identity for this test via the env var — the
    # Application config path is gone. Test assertions read `test-host`
    # back from the auto-stamped shuttle.host field.
    Env.put_env("SHUTTLE_HOST", "test-host")

    on_exit(fn -> File.rm_rf(tmp) end)

    {:ok, tmp: tmp}
  end

  test "namespace identity agrees with felt across global and subtree-rooted stores", %{tmp: tmp} do
    fixture =
      Path.join([__DIR__, "..", "..", "fixtures", "fiber_identity", "cases.json"])
      |> File.read!()
      |> Jason.decode!()

    loom = Path.join(tmp, "loom")
    project = Path.join(tmp, "project")
    File.mkdir_p!(project)

    for fiber <- fixture["fibers"] do
      path = Path.join([loom, ".felt", fiber["id"], Path.basename(fiber["id"]) <> ".md"])
      File.mkdir_p!(Path.dirname(path))
      File.write!(path, "---\nid: #{fiber["uid"]}\nname: Fixture\nstatus: open\n---\n")
    end

    File.ln_s!(Path.join([loom, ".felt", fixture["prefix"]]), Path.join(project, ".felt"))

    for store <- [loom, project] do
      Env.put_env("SHUTTLE_STORES", store)

      for lookup <- fixture["lookups"] do
        case lookup["id"] do
          nil ->
            assert {:error, :not_found} = Shuttle.FeltStores.resolve_fiber(lookup["query"])

          id ->
            assert {:ok, %{fiber_id: ^id}} = Shuttle.FeltStores.resolve_fiber(lookup["query"])
        end
      end

      for id <- fixture["creates"] do
        conn =
          post(
            api_conn(),
            "/api/v1/fiber/create",
            Jason.encode!(%{
              id: id,
              name: "Thread",
              frontmatter: %{status: "open", shuttle: %{kind: "oneshot", project_dir: project}}
            })
          )

        assert %{
                 "id" => ^id,
                 "uid" => uid,
                 "path" => path,
                 "host" => "test-host",
                 "status" => "open"
               } = json_response(conn, 200)

        assert_felt_path(path, loom, String.split(id, "/") ++ [Path.basename(id) <> ".md"])

        assert {:ok, %{"id" => ^uid}} =
                 path |> File.read!() |> frontmatter() |> YamlElixir.read_from_string()

        File.rm_rf!(Path.dirname(path))
      end
    end
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

  test "POST /api/v1/fiber/create round-trips due and outcome", %{tmp: tmp} do
    # Both keys are on @felt_native_keys, so the non-native splice skips them as
    # "felt's to write". They must therefore reach `felt add`'s argv — they used
    # to reach neither owner and vanish, so a one-shot create of a dated fiber
    # silently lost its date.
    conn =
      api_conn()
      |> post(
        "/api/v1/fiber/create",
        Jason.encode!(%{
          id: "tests/dated",
          name: "Dated fiber",
          frontmatter: %{
            status: "open",
            due: "2026-11-30",
            outcome: "The thing concluded.",
            tags: ["constitution"],
            shuttle: %{enabled: true, kind: "oneshot", project_dir: tmp}
          }
        })
      )

    assert conn.status == 200
    assert %{"path" => path} = Jason.decode!(conn.resp_body)

    assert {:ok, parsed} =
             path |> File.read!() |> frontmatter() |> YamlElixir.read_from_string()

    assert parsed["outcome"] == "The thing concluded."
    assert parsed["status"] == "open"

    # felt normalizes a bare date to a full instant on the way in, the same
    # shape the kanban projection serves.
    assert to_string(parsed["due"]) =~ "2026-11-30"

    # Spliced exactly once — the native keys are felt's, not the splice's.
    assert length(String.split(File.read!(path), "outcome:")) == 2
    assert length(String.split(File.read!(path), "due:")) == 2
  end

  test "POST /api/v1/fiber/create preserves source identity and document metadata", %{tmp: tmp} do
    uid = "01JARZ3NDEKTSV4RRFFQ69G5FA"

    conn =
      api_conn()
      |> post(
        "/api/v1/fiber/create",
        Jason.encode!(%{
          id: "tests/transferred",
          uid: uid,
          name: "Transferred fiber",
          body: "the source body",
          frontmatter: %{
            "status" => "active",
            "description" => "A source description",
            "created-at" => "2026-10-29T12:00:00Z",
            "updated-at" => "2026-10-30T12:00:00Z",
            "shuttle" => %{kind: "oneshot", project_dir: tmp}
          }
        })
      )

    assert conn.status == 200

    assert %{"id" => "tests/transferred", "uid" => ^uid, "path" => path} =
             Jason.decode!(conn.resp_body)

    assert {:ok, parsed} = path |> File.read!() |> frontmatter() |> YamlElixir.read_from_string()
    assert parsed["id"] == uid
    assert parsed["status"] == "active"
    assert parsed["description"] == "A source description"
    assert parsed["shuttle"]["host"] == "test-host"
    assert to_string(parsed["created-at"]) =~ "2026-10-29T12:00:00Z"
    assert to_string(parsed["updated-at"]) =~ "2026-10-30T12:00:00Z"

    # YAML parsers here keep the last duplicate; felt refuses the document.
    keys =
      path
      |> File.read!()
      |> frontmatter()
      |> String.split("\n")
      |> Enum.flat_map(fn line ->
        case Regex.run(~r/^([A-Za-z_-]+):/, line) do
          [_, key] -> [key]
          _ -> []
        end
      end)

    assert keys == Enum.uniq(keys), "duplicate frontmatter keys: #{inspect(keys)}"
    assert {_json, 0} = System.cmd("felt", ["-C", tmp, "show", "tests/transferred", "-j"])
  end

  test "POST /api/v1/fiber/create writes under shuttle.project_dir when it differs from daemon root",
       %{
         tmp: tmp
       } do
    daemon_root = Path.join(tmp, "daemon-root")
    project_dir = Path.join(tmp, "project-dir")
    File.mkdir_p!(daemon_root)
    File.mkdir_p!(project_dir)
    Env.put_env("SHUTTLE_STORES", daemon_root)

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

    refute File.exists?(
             Path.join([daemon_root, ".felt", "tests", "project-local", "project-local.md"])
           )
  end

  test "create announces the physical store, not the first store with the same slug", %{tmp: tmp} do
    first = Path.join(tmp, "first")
    owner = Path.join(tmp, "owner")
    project = Path.join(tmp, "project")
    Enum.each([first, owner, project], &File.mkdir_p!/1)
    assert {_, 0} = System.cmd("felt", ["init"], cd: first)
    assert {_, 0} = System.cmd("felt", ["init"], cd: owner)
    assert {_, 0} = System.cmd("felt", ["-C", first, "add", "duplicate", "Other"])
    File.ln_s!(Path.join(owner, ".felt"), Path.join(project, ".felt"))
    Env.put_env("SHUTTLE_STORES", first <> "," <> owner)

    test = self()

    poller =
      spawn(fn ->
        receive do
          {:"$gen_call", from, message} ->
            send(test, {:announcement, message})
            GenServer.reply(from, :ok)
        end
      end)

    Env.put_server(Shuttle.Poller, poller)

    conn =
      api_conn()
      |> post(
        "/api/v1/fiber/create",
        Jason.encode!(%{
          id: "duplicate",
          name: "New",
          frontmatter: %{
            status: "open",
            shuttle: %{kind: "oneshot", project_dir: project}
          }
        })
      )

    assert conn.status == 200
    assert %{"uid" => uid, "path" => path} = Jason.decode!(conn.resp_body)
    assert String.starts_with?(path, Shuttle.FeltStores.store_felt_realpath(owner) <> "/")
    assert_receive {:announcement, {:refresh_created_document, ^owner, ^uid}}
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
    StubPostClient.start!()

    StubPostClient.set_response(
      {:ok, 200, Jason.encode!(%{"id" => "tests/remote-stash", "path" => "/candide/.felt/…"})}
    )

    Env.put_app_env(:remotes, [%{name: "candide", url: "http://localhost:4001"}])
    Env.put_app_env(:write_forward_client, StubPostClient)

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

  test "POST /api/v1/fiber/create refuses an unknown origin without a local write", %{
    tmp: tmp
  } do
    # A configured fleet must not substitute this host for a different origin.
    StubPostClient.start!()
    Env.put_app_env(:remotes, [%{name: "candide", url: "http://localhost:4001"}])
    Env.put_app_env(:write_forward_client, StubPostClient)

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

    assert conn.status == 400
    assert Jason.decode!(conn.resp_body)["error"] =~ ~s(unknown origin "ghost")
    refute File.exists?(Path.join([tmp, ".felt", "tests", "ghost-origin", "ghost-origin.md"]))
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
end
