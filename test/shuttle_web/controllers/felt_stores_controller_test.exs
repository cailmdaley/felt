defmodule ShuttleWeb.FeltStoresControllerTest do
  use ExUnit.Case
  import Plug.Conn
  import Phoenix.ConnTest

  @endpoint ShuttleWeb.Endpoint

  setup do
    original = System.get_env("FELT_STORES_FILE")
    original_remotes = Application.get_env(:shuttle, :remotes)

    # FELT_STORES env WINS over the registry file (FeltStores resolution
    # order), so an operator shell exporting it leaks into every assertion
    # here. Clear it for the test; restore after.
    original_env_stores = System.get_env("FELT_STORES")
    System.delete_env("FELT_STORES")

    path =
      Path.join(
        System.tmp_dir!(),
        "shuttle-felt-stores-controller-#{System.unique_integer([:positive])}.json"
      )

    System.put_env("FELT_STORES_FILE", path)
    Application.put_env(:shuttle, :remotes, [])

    on_exit(fn ->
      File.rm(path)

      case original do
        nil -> System.delete_env("FELT_STORES_FILE")
        value -> System.put_env("FELT_STORES_FILE", value)
      end

      case original_remotes do
        nil -> Application.delete_env(:shuttle, :remotes)
        value -> Application.put_env(:shuttle, :remotes, value)
      end

      case original_env_stores do
        nil -> System.delete_env("FELT_STORES")
        value -> System.put_env("FELT_STORES", value)
      end
    end)

    :ok
  end

  defp api_conn do
    build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
  end

  test "shows the configured base stores as the local origin" do
    path = Path.expand(System.get_env("FELT_STORES_FILE"))
    File.mkdir_p!(Path.dirname(path))

    File.write!(
      path,
      Jason.encode!(%{"version" => 1, "felt_stores" => ["~/loom", "/tmp/project"]})
    )

    conn = get(api_conn(), "/api/v1/felt-stores")

    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)
    host = body["host"]
    assert is_binary(host)

    assert get_in(body, ["origins", host, "kind"]) == "local"

    assert get_in(body, ["origins", host, "felt_stores"]) == [
             Path.expand("~/loom"),
             "/tmp/project"
           ]
  end

  test "surfaces the curated picker-project list on the local origin" do
    prev_projects_file = System.get_env("FELT_PROJECTS_FILE")

    projects_path =
      Path.join(
        System.tmp_dir!(),
        "shuttle-projects-controller-#{System.unique_integer([:positive])}.json"
      )

    System.put_env("FELT_PROJECTS_FILE", projects_path)
    File.mkdir_p!(Path.dirname(projects_path))

    File.write!(
      projects_path,
      Jason.encode!(%{"version" => 1, "projects" => ["~/loom", "/tmp/talks"]})
    )

    on_exit(fn ->
      File.rm(projects_path)

      case prev_projects_file do
        nil -> System.delete_env("FELT_PROJECTS_FILE")
        value -> System.put_env("FELT_PROJECTS_FILE", value)
      end
    end)

    conn = get(api_conn(), "/api/v1/felt-stores")
    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)
    host = body["host"]

    # Picker-project list is its own field, distinct from the poll-store list.
    assert get_in(body, ["origins", host, "projects"]) == [Path.expand("~/loom"), "/tmp/talks"]
  end

  test "persists normalized felt stores" do
    conn =
      post(
        api_conn(),
        "/api/v1/felt-stores",
        Jason.encode!(%{"felt_stores" => ["~/loom", "/tmp/project", "~/loom", "  "]})
      )

    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)
    assert body["ok"] == true
    assert body["felt_stores"] == [Path.expand("~/loom"), "/tmp/project"]

    {:ok, persisted} = File.read(Path.expand(System.get_env("FELT_STORES_FILE")))
    decoded = Jason.decode!(persisted)
    assert decoded["felt_stores"] == [Path.expand("~/loom"), "/tmp/project"]
    assert decoded["version"] == 1
  end

  test "empty list clears the persisted file" do
    path = Path.expand(System.get_env("FELT_STORES_FILE"))
    File.mkdir_p!(Path.dirname(path))
    File.write!(path, Jason.encode!(%{"version" => 1, "felt_stores" => ["/tmp/stale"]}))

    conn = post(api_conn(), "/api/v1/felt-stores", Jason.encode!(%{"felt_stores" => []}))

    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)
    assert body["felt_stores"] == []
    refute File.exists?(path)
  end

  test "rejects malformed payloads" do
    conn = post(api_conn(), "/api/v1/felt-stores", Jason.encode!(%{"felt_stores" => "~/loom"}))

    assert conn.status == 400
    assert Jason.decode!(conn.resp_body)["error"] =~ "felt_stores"
  end
end
