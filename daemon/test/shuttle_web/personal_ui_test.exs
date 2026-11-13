defmodule ShuttleWeb.PersonalUITest do
  use ExUnit.Case, async: true
  import Plug.Conn
  import Phoenix.ConnTest
  import Shuttle.Test.ApiConn

  @endpoint ShuttleWeb.Endpoint
  @moduletag :tmp_dir

  setup %{tmp_dir: home} do
    Shuttle.Test.Env.put_env("HOME", home)
    ui = Path.join(home, ".config/shuttle/ui/example")
    File.mkdir_p!(Path.join(ui, "assets"))
    File.write!(Path.join(ui, "index.html"), "<h1>Personal UI</h1>")
    File.write!(Path.join(ui, "assets/app.js"), "console.log('hello')")
    File.write!(Path.join(home, ".config/shuttle/host.json"), "secret")
    %{ui: ui}
  end

  test "serves the index and reads changes on each request", %{ui: ui} do
    conn = get(local_conn(), "/ui/example/")
    assert conn.status == 200
    assert conn.resp_body == "<h1>Personal UI</h1>"
    assert [type] = get_resp_header(conn, "content-type")
    assert type =~ "text/html"
    File.write!(Path.join(ui, "index.html"), "changed")
    assert get(local_conn(), "/ui/example/").resp_body == "changed"
  end

  test "redirects to a trailing slash, preserving the query" do
    conn = get(local_conn(), "/ui/example?view=one")
    assert conn.status == 302
    assert get_resp_header(conn, "location") == ["/ui/example/?view=one"]
  end

  test "serves nested assets with their content type" do
    conn = get(local_conn(), "/ui/example/assets/app.js")
    assert conn.status == 200
    assert conn.resp_body == "console.log('hello')"
    assert [type] = get_resp_header(conn, "content-type")
    assert type =~ "javascript"
  end

  test "missing UIs and files return 404" do
    assert get(local_conn(), "/ui/missing/").status == 404
    assert get(local_conn(), "/ui/example/missing.js").status == 404
  end

  test "traversal cannot read config files" do
    for path <- ["/ui/x/../../host.json", "/ui/x/%2e%2e/%2e%2e/host.json"] do
      assert_raise Plug.Static.InvalidPathError, fn -> get(local_conn(), path) end
    end
  end
end
