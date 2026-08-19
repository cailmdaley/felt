defmodule ShuttleWeb.BrowseControllerTest do
  @moduledoc """
  Wiring for `GET /api/v1/browse` — the directory walk behind the project
  pickers' "+ Add project…" affordance. Local branch against real temp
  directories; the path contract (absolute-only, 404 on missing) mirrors
  `/file`, whose tests this one is shaped after.
  """
  use ExUnit.Case
  import Plug.Conn
  import Phoenix.ConnTest

  @endpoint ShuttleWeb.Endpoint

  setup do
    root = tmp_dir()
    File.mkdir_p!(Path.join([root, "alpha", ".felt"]))
    File.mkdir_p!(Path.join(root, "beta"))
    File.mkdir_p!(Path.join(root, ".hidden"))
    File.write!(Path.join(root, "a-file.txt"), "not a directory")
    on_exit(fn -> File.rm_rf(root) end)
    {:ok, root: root}
  end

  test "lists subdirectories only, sorted, marking felt stores", %{root: root} do
    body = json_get("/api/v1/browse?path=#{URI.encode_www_form(root)}", 200)

    assert body["path"] == root
    assert body["parent"] == Path.dirname(root)

    assert body["entries"] == [
             %{"name" => "alpha", "path" => Path.join(root, "alpha"), "has_felt" => true},
             %{"name" => "beta", "path" => Path.join(root, "beta"), "has_felt" => false}
           ]
  end

  test "defaults to the user's home when no path is given" do
    body = json_get("/api/v1/browse", 200)
    assert body["path"] == Path.expand(System.user_home())
  end

  test "the filesystem root reports no parent" do
    body = json_get("/api/v1/browse?path=%2F", 200)
    assert body["path"] == "/"
    assert body["parent"] == nil
  end

  test "400 on a relative path" do
    body = json_get("/api/v1/browse?path=relative/sneaky", 400)
    assert body["error"] =~ "absolute"
  end

  test "404 on a missing directory" do
    body = json_get("/api/v1/browse?path=%2Fnope%2Fnot%2Fhere", 404)
    assert body["error"] =~ "not found"
  end

  test "404 when the path is a regular file", %{root: root} do
    file = Path.join(root, "a-file.txt")
    assert json_get("/api/v1/browse?path=#{URI.encode_www_form(file)}", 404)
  end

  defp json_get(url, expected_status) do
    conn = get(api_conn(), url)
    assert conn.status == expected_status
    Jason.decode!(conn.resp_body)
  end

  defp tmp_dir do
    path = Path.join(System.tmp_dir!(), "shuttle_browse_ctrl_#{System.unique_integer([:positive])}")
    File.mkdir_p!(path)
    # macOS hands out /var/folders/… , a symlink to /private/var/folders/… ;
    # the controller expands, so the test compares against the expanded form.
    Path.expand(path) |> File.cd!(fn -> File.cwd!() end)
  end

  defp api_conn do
    build_conn() |> put_req_header("accept", "application/json")
  end
end
