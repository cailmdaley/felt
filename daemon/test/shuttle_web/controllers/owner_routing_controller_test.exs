defmodule ShuttleWeb.OwnerRoutingControllerTest do
  use ExUnit.Case, async: true
  import Shuttle.Test.ApiConn
  import Phoenix.ConnTest
  @endpoint ShuttleWeb.Endpoint
  @moduletag :tmp_dir

  defmodule NoLocalIO do
    def cmd(executable, args, _opts) do
      send(Shuttle.Env.app(:local_io_owner), {:local_io, executable, args})
      {"local I/O must not run for an unknown origin", 1}
    end
  end

  setup %{tmp_dir: store} do
    fiber_path = Path.join(store, ".felt/task/task.md")
    File.mkdir_p!(Path.dirname(fiber_path))

    document =
      "---\nname: Local mirror\nstatus: open\nshuttle:\n  kind: oneshot\n  host: test-host\n  project_dir: #{store}\n---\n"

    File.write!(fiber_path, document)
    asset = Path.join(store, "private.txt")
    File.write!(asset, "local contents must not be served as a different host")
    Shuttle.Test.Env.put_env("SHUTTLE_STORES", store)
    Shuttle.Test.Env.put_app_env(:remotes, [])
    Shuttle.Test.Env.put_app_env(:felt_runner, NoLocalIO)
    Shuttle.Test.Env.put_app_env(:local_io_owner, self())
    {:ok, fiber_path: fiber_path, document: document, asset: asset}
  end

  # Each route uses OriginRouter.route/1. Even a present local mirror/file
  # cannot authorize substituting this host for an explicit missing owner.
  for {path, fields} <- [
        {"lifecycle", %{"fiber" => "task", "action" => "resume"}},
        {"dispatch", %{"fiber_id" => "task", "force" => true}},
        {"transition", %{"fiber_id" => "task", "target" => "in_flight"}},
        {"kill", %{"fiber_id" => "task"}},
        {"claim", %{"fiber_id" => "task", "tmux_session" => "test-worker"}},
        {"deliver", %{"fiber_id" => "task", "text" => "remote message"}},
        {"attachments", %{"fiber_id" => "task", "files" => []}},
        {"felt-edit", %{"fiber_id" => "task", "set" => ["status=active"]}},
        {"felt-nest", %{"fiber_id" => "task", "parent_id" => "other"}},
        {"fiber/create", %{"id" => "new-task", "name" => "Remote task"}}
      ] do
    test "POST /#{path} rejects an unknown owner before local I/O", context do
      fields = Map.put(unquote(Macro.escape(fields)), "origin", "missing-owner")
      conn = post(api_conn(), "/api/v1/" <> unquote(path), Jason.encode!(fields))
      assert conn.status == 400, conn.resp_body

      assert Jason.decode!(conn.resp_body)["error"] =~
               ~s(unknown origin "missing-owner": not in this daemon's fleet)

      assert File.read!(context.fiber_path) == context.document
      refute_receive {:local_io, _, _}
    end
  end

  test "file asset routing refuses an unknown owner even when the absolute path exists", %{
    asset: asset
  } do
    conn = get(api_conn(), "/api/v1/file-assets/missing-owner" <> URI.encode(asset))
    assert conn.status == 400, conn.resp_body
    assert Jason.decode!(conn.resp_body)["error"] =~ ~s(unknown origin "missing-owner")
    refute conn.resp_body =~ "local contents must not be served"
  end

  for path <- ["fibers/task", "sent-files", "file", "file-info"] do
    test "GET /#{path} rejects an unknown owner without serving this host's bytes", %{
      asset: asset
    } do
      query =
        URI.encode_query(%{
          "origin" => "missing-owner",
          "path" => asset,
          "uid" => "01J00000000000000000000000",
          "body" => "true"
        })

      conn = get(api_conn(), "/api/v1/" <> unquote(path) <> "?" <> query)
      assert conn.status == 400, conn.resp_body

      assert Jason.decode!(conn.resp_body)["error"] =~
               ~s(unknown origin "missing-owner": not in this daemon's fleet)

      refute conn.resp_body =~ "local contents must not be served"
      refute_receive {:local_io, _, _}
    end
  end
end
