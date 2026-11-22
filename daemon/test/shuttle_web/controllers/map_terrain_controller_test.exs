defmodule ShuttleWeb.MapTerrainControllerTest do
  use ExUnit.Case, async: true
  import Phoenix.ConnTest
  import Shuttle.Test.ApiConn

  alias Shuttle.MapTerrain
  alias Shuttle.Test.{Env, FiberUid}

  @endpoint ShuttleWeb.Endpoint
  @moduletag :tmp_dir

  defmodule StubRunner do
    @behaviour Shuttle.Runner

    def cmd("shuttle", _args, _opts) do
      if counter = Shuttle.Env.app(:map_controller_counter) do
        Agent.update(counter, &(&1 + 1))
      end

      case Shuttle.Env.app(:map_controller_response) do
        {out, status} -> {out, status}
        _ -> {Jason.encode!(Shuttle.Env.app(:map_controller_rows, [])), 0}
      end
    end
  end

  setup %{tmp_dir: dir} do
    store = Path.join(dir, "store")
    felt = Path.join(store, ".felt")
    File.mkdir_p!(felt)

    for n <- 1..5 do
      path = Path.join([felt, "atlas/n#{n}", "n#{n}.md"])
      File.mkdir_p!(Path.dirname(path))
      File.write!(path, "---\nname: Node #{n}\n---\nhello")
    end

    rows =
      Enum.map(1..5, fn n ->
        base = %{
          "id" => "atlas/n#{n}",
          "uid" => FiberUid.for("atlas/n#{n}"),
          "name" => "Node #{n}",
          "status" => "open",
          "created_at" => "2026-11-15T12:00:00Z",
          "modified_at" => "2026-11-20T12:00:00Z",
          "tags" => []
        }

        if n == 1 do
          Map.put(base, "shuttle", %{"host" => "test-host", "kind" => "oneshot"})
        else
          base
        end
      end)

    counter = start_supervised!({Agent, fn -> 0 end})
    Env.put_env("SHUTTLE_STORES", store)
    Env.put_env("SHUTTLE_MAP_CONFIG", Path.join(dir, "nonexistent-map.json"))
    Env.put_app_env(:felt_runner, StubRunner)
    Env.put_app_env(:map_controller_counter, counter)
    Env.put_app_env(:map_controller_rows, rows)
    Env.put_app_env(:own_host_id, "test-host")
    MapTerrain.clear_cache()

    on_exit(fn -> MapTerrain.clear_cache() end)
    {:ok, counter: counter}
  end

  test "GET /api/v1/map/terrain returns terrain JSON shape and serves cached entries without ?refresh=1 bypass",
       %{counter: counter} do
    conn = get(api_conn(), "/api/v1/map/terrain")
    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)

    assert is_binary(body["generatedAt"])
    assert is_map(body["origins"])
    assert body["mapConfig"] == %{"seas" => %{}, "pins" => %{}}
    assert [%{"id" => "atlas", "total" => 5, "cities" => 1, "kind" => "project"}] = body["continents"]
    assert is_list(body["areas"])
    assert is_list(body["areaLinks"])
    assert is_list(body["domainLinks"])
    assert [%{"id" => "atlas/n1", "continent" => "atlas", "origin" => "test-host"}] = body["cities"]
    assert Agent.get(counter, & &1) == 1

    # Second call (even with ?refresh=1) hits the ETS cache.
    conn2 = get(api_conn(), "/api/v1/map/terrain?refresh=1")
    assert conn2.status == 200
    assert Agent.get(counter, & &1) == 1
  end

  test "GET /api/v1/map/terrain returns 503 when every configured store fails" do
    Env.put_app_env(:map_controller_response, {"store unavailable", 1})

    conn = get(api_conn(), "/api/v1/map/terrain")
    assert conn.status == 503
    assert %{"error" => "map_terrain_failed", "reason" => reason} = Jason.decode!(conn.resp_body)
    assert reason =~ "store unavailable"
  end
end
