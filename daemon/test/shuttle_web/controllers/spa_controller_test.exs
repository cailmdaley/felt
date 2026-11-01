defmodule ShuttleWeb.SpaControllerTest do
  @moduledoc """
  `GET /` serves the built UI's `index.html`. Asset resolution prefers an
  environment override, then the bundled release UI, then the source checkout.
  These tests verify the exact default path and the endpoint's response.
  """
  use ExUnit.Case, async: true
  import Shuttle.Test.ApiConn
  import Plug.Conn
  import Phoenix.ConnTest

  @endpoint ShuttleWeb.Endpoint

  test "Assets.dist/0 resolves the bundled UI or the repository's sibling UI" do
    Shuttle.Test.Env.delete_env("SHUTTLE_UI_DIST")

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

      Shuttle.Test.Env.put_env("SHUTTLE_UI_DIST", dist)
      on_exit(fn -> File.rm_rf(dist) end)
      %{dist: dist}
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

    test "static delivery runs before-send callbacks exactly once in the request owner" do
      parent = self()

      conn =
        local_conn()
        |> register_before_send(fn conn ->
          send(parent, {:static_send, self()})
          conn
        end)
        |> get("/assets/index-AbCd1234.js")

      assert conn.status == 200
      assert_receive {:static_send, ^parent}
      refute_received {:static_send, _}
    end

    test "static HEAD, validators and ranges retain negotiated representation semantics" do
      head =
        local_conn()
        |> put_req_header("accept-encoding", "br")
        |> head("/assets/index-AbCd1234.js")

      assert head.status == 200
      assert head.resp_body == ""
      assert get_resp_header(head, "content-length") == ["6"]
      assert get_resp_header(head, "content-encoding") == ["br"]
      [etag] = get_resp_header(head, "etag")

      cached =
        local_conn()
        |> put_req_header("accept-encoding", "br")
        |> put_req_header("if-none-match", etag)
        |> get("/assets/index-AbCd1234.js")

      assert cached.status == 304
      assert cached.resp_body == ""

      range =
        local_conn()
        |> put_req_header("accept-encoding", "br")
        |> put_req_header("range", "bytes=1-2")
        |> get("/assets/index-AbCd1234.js")

      assert range.status == 206
      assert range.resp_body == "la"
      assert get_resp_header(range, "content-range") == ["bytes 1-2/5"]
      assert get_resp_header(range, "content-encoding") == []
    end

    test "a denied UI bundle names its failure without making API routes depend on it", %{
      dist: dist
    } do
      alias Shuttle.FileAccess
      Shuttle.Test.Env.start_scoped!({FileAccess, name: nil, protected_roots: [dist]})
      assert_raise FileAccess.Error, fn -> FileAccess.task(dist, fn -> {:error, :eacces} end) end
      refused = get(local_conn(), "/assets/index-AbCd1234.js")
      assert refused.status == 503
      assert Jason.decode!(refused.resp_body)["error"] =~ dist
      assert get(local_conn(), "/api/v1/version").status == 200
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
