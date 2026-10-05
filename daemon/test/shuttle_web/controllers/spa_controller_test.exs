defmodule ShuttleWeb.SpaControllerTest do
  @moduledoc """
  `GET /` serves the built UI's `index.html`. Asset resolution prefers an
  environment override, then the bundled release UI, then the source checkout.
  These tests verify the exact default path and the endpoint's response.
  """
  use ExUnit.Case
  import Shuttle.Test.ApiConn
  import Plug.Conn
  import Phoenix.ConnTest

  @endpoint ShuttleWeb.Endpoint

  test "Assets.dist/0 resolves the bundled UI or the repository's sibling UI" do
    previous = System.get_env("SHUTTLE_UI_DIST")
    on_exit(fn -> Shuttle.Test.EnvHelpers.restore_env("SHUTTLE_UI_DIST", previous) end)
    System.delete_env("SHUTTLE_UI_DIST")

    bundled_dist = Application.app_dir(:shuttle, "priv/ui/dist")
    checkout_dist = Path.expand("../../../../ui/dist", __DIR__)

    expected = if File.dir?(bundled_dist), do: bundled_dist, else: checkout_dist
    assert ShuttleWeb.Assets.dist() == expected
  end

  test "GET /phone redirects to the board root" do
    conn = get(local_conn(), "/phone")

    assert conn.status == 302
    assert get_resp_header(conn, "location") == ["/"]
  end

  test "GET / serves index.html when built, else 404s with a build hint" do
    conn = get(local_conn(), "/")
    index = Path.join(ShuttleWeb.Assets.dist(), "index.html")

    if File.regular?(index) do
      assert conn.status == 200
      assert get_resp_header(conn, "content-type") |> List.first() =~ "text/html"
      assert conn.resp_body =~ "<"
    else
      assert conn.status == 404
      assert conn.resp_body =~ "npm run build"
    end
  end

  describe "the bundle's static files" do
    setup do
      dist = Path.join(System.tmp_dir!(), "shuttle-static-#{System.unique_integer([:positive])}")
      File.mkdir_p!(Path.join(dist, "assets"))
      File.mkdir_p!(Path.join(dist, "fonts"))
      File.write!(Path.join(dist, "assets/index-AbCd1234.js"), "plain")
      File.write!(Path.join(dist, "assets/index-AbCd1234.js.gz"), "gzipped")
      File.write!(Path.join(dist, "assets/index-AbCd1234.js.br"), "brotli")
      File.write!(Path.join(dist, "fonts/initials.otf"), "font")
      File.write!(Path.join(dist, "fonts/initials.otf.gz"), "gzipped font")

      previous = System.get_env("SHUTTLE_UI_DIST")
      System.put_env("SHUTTLE_UI_DIST", dist)

      on_exit(fn ->
        Shuttle.Test.EnvHelpers.restore_env("SHUTTLE_UI_DIST", previous)
        File.rm_rf(dist)
      end)
    end

    test "a hashed asset is served precompressed and cached for good" do
      conn =
        local_conn()
        |> put_req_header("accept-encoding", "gzip, deflate, br")
        |> get("/assets/index-AbCd1234.js")

      assert conn.status == 200
      assert conn.resp_body == "brotli"
      assert get_resp_header(conn, "content-encoding") == ["br"]
      assert get_resp_header(conn, "cache-control") == ["public, max-age=31536000, immutable"]

      gzip =
        local_conn()
        |> put_req_header("accept-encoding", "gzip")
        |> get("/assets/index-AbCd1234.js")

      assert gzip.resp_body == "gzipped"
      assert get_resp_header(gzip, "content-encoding") == ["gzip"]

      assert get(local_conn(), "/assets/index-AbCd1234.js").resp_body == "plain"
    end

    test "an unhashed file is served precompressed and revalidated" do
      conn =
        local_conn() |> put_req_header("accept-encoding", "gzip") |> get("/fonts/initials.otf")

      assert conn.status == 200
      assert conn.resp_body == "gzipped font"
      assert get_resp_header(conn, "cache-control") == ["public"]
    end
  end
end
