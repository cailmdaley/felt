defmodule ShuttleWeb.FeltStoresControllerTest do
  use ExUnit.Case
  import Plug.Conn
  import Phoenix.ConnTest

  @endpoint ShuttleWeb.Endpoint

  setup do
    original = System.get_env("FELT_STORES_FILE")

    path =
      Path.join(
        System.tmp_dir!(),
        "shuttle-felt-stores-controller-#{System.unique_integer([:positive])}.json"
      )

    System.put_env("FELT_STORES_FILE", path)

    on_exit(fn ->
      File.rm(path)

      case original do
        nil -> System.delete_env("FELT_STORES_FILE")
        value -> System.put_env("FELT_STORES_FILE", value)
      end
    end)

    :ok
  end

  defp api_conn do
    build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
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
