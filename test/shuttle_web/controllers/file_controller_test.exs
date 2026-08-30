defmodule ShuttleWeb.FileControllerTest do
  @moduledoc """
  Wiring for `GET /api/v1/file` — the owner-routed file-bytes route the
  standalone UI's fiber panel reads for `:::{embed}` artifacts and relative
  images. The local branch (absolute-path read + MIME + bytes) is exercised
  against real temp files; the remote branch reuses the shared
  `Shuttle.OriginRouter.forward_get/4` with a stubbed transport, mirroring the
  felt-edit/transition forward tests.
  """
  use ExUnit.Case
  alias Shuttle.Test.StubGetFileClient
  import Shuttle.Test.EnvHelpers
  import Plug.Conn
  import Phoenix.ConnTest

  @endpoint ShuttleWeb.Endpoint

  describe "local serve" do
    test "200 with bytes + content-type for an existing absolute path" do
      path = tmp_path("txt")
      File.write!(path, "hello embed")
      on_exit(fn -> File.rm(path) end)

      conn = get(api_conn(), "/api/v1/file?path=#{URI.encode_www_form(path)}")

      assert conn.status == 200
      assert conn.resp_body == "hello embed"
      assert get_resp_header(conn, "content-type") |> List.first() =~ "text/plain"
    end

    test "content-type follows the file extension" do
      path = tmp_path("svg")
      File.write!(path, "<svg/>")
      on_exit(fn -> File.rm(path) end)

      conn = get(api_conn(), "/api/v1/file?path=#{URI.encode_www_form(path)}")

      assert conn.status == 200
      assert get_resp_header(conn, "content-type") |> List.first() =~ "image/svg"
    end

    test "404 for a non-existent absolute path" do
      conn = get(api_conn(), "/api/v1/file?path=#{URI.encode_www_form(tmp_path("missing"))}")

      assert conn.status == 404
      assert %{"error" => _} = json_response(conn, 404)
    end

    test "400 for a relative path" do
      conn = get(api_conn(), "/api/v1/file?path=relative/sneaky.txt")
      assert conn.status == 400
      assert %{"error" => "path must be absolute"} = json_response(conn, 400)
    end

    test "400 when path is missing" do
      conn = get(api_conn(), "/api/v1/file")
      assert conn.status == 400
      assert %{"error" => "path is required"} = json_response(conn, 400)
    end

    test "file-info returns mtime and size without reading bytes" do
      path = tmp_path("txt")
      File.write!(path, "hello embed")
      on_exit(fn -> File.rm(path) end)

      conn = get(api_conn(), "/api/v1/file-info?path=#{URI.encode_www_form(path)}")

      assert conn.status == 200
      assert %{"exists" => true, "modified_at" => mtime, "size" => 11} = json_response(conn, 200)
      assert is_integer(mtime)
    end

    test "file-info returns an explicit absent revision for a missing path" do
      conn = get(api_conn(), "/api/v1/file-info?path=#{URI.encode_www_form(tmp_path("missing"))}")

      assert conn.status == 200
      assert %{"exists" => false} = json_response(conn, 200)
    end

    test "200 carries ETag, Last-Modified, and Cache-Control validators" do
      path = tmp_path("txt")
      File.write!(path, "hello embed")
      on_exit(fn -> File.rm(path) end)

      conn = get(api_conn(), "/api/v1/file?path=#{URI.encode_www_form(path)}")

      assert conn.status == 200
      assert [etag] = get_resp_header(conn, "etag")
      assert etag =~ ~r/^W\/"[0-9a-f]{32}"$/
      assert [_last_modified] = get_resp_header(conn, "last-modified")
      assert get_resp_header(conn, "cache-control") == ["public, max-age=300"]
    end

    test "304 when If-None-Match matches the served ETag" do
      path = tmp_path("txt")
      File.write!(path, "hello embed")
      on_exit(fn -> File.rm(path) end)

      first = get(api_conn(), "/api/v1/file?path=#{URI.encode_www_form(path)}")
      [etag] = get_resp_header(first, "etag")

      conn =
        api_conn()
        |> put_req_header("if-none-match", etag)
        |> get("/api/v1/file?path=#{URI.encode_www_form(path)}")

      assert conn.status == 304
      assert conn.resp_body == ""
    end

    test "304 when If-Modified-Since is at or after the file's mtime" do
      path = tmp_path("txt")
      File.write!(path, "hello embed")
      on_exit(fn -> File.rm(path) end)

      first = get(api_conn(), "/api/v1/file?path=#{URI.encode_www_form(path)}")
      [last_modified] = get_resp_header(first, "last-modified")

      conn =
        api_conn()
        |> put_req_header("if-modified-since", last_modified)
        |> get("/api/v1/file?path=#{URI.encode_www_form(path)}")

      assert conn.status == 304
    end

    test "200 (not 304) when the validators are stale — a changed ETag or an earlier If-Modified-Since" do
      path = tmp_path("txt")
      File.write!(path, "hello embed")
      on_exit(fn -> File.rm(path) end)

      stale_etag = ~s(W/"0000000000000000000000000000000")

      conn =
        api_conn()
        |> put_req_header("if-none-match", stale_etag)
        |> get("/api/v1/file?path=#{URI.encode_www_form(path)}")

      assert conn.status == 200
      assert conn.resp_body == "hello embed"

      conn =
        api_conn()
        |> put_req_header("if-modified-since", "Thu, 01 Jan 1970 00:00:00 GMT")
        |> get("/api/v1/file?path=#{URI.encode_www_form(path)}")

      assert conn.status == 200
      assert conn.resp_body == "hello embed"
    end

    test "a strict non-*/* Accept header still reaches the controller (not 406)" do
      path = tmp_path("pdf")
      File.write!(path, "%PDF-1.4 fake")
      on_exit(fn -> File.rm(path) end)

      conn =
        build_conn()
        |> Plug.Conn.put_req_header("accept", "application/pdf")
        |> get("/api/v1/file?path=#{URI.encode_www_form(path)}")

      assert conn.status == 200
      assert conn.resp_body == "%PDF-1.4 fake"
    end
  end

  describe "remote forward" do
    test "forwards a remote-owned path to the owning daemon and relays bytes" do
      stub_forward(
        "candide",
        "http://localhost:4001",
        {:ok, 200, "image/png", <<137, 80, 78, 71>>}
      )

      conn =
        get(
          api_conn(),
          "/api/v1/file?path=#{URI.encode_www_form("/abs/on/candide.png")}&origin=candide"
        )

      assert conn.status == 200
      assert conn.resp_body == <<137, 80, 78, 71>>
      assert get_resp_header(conn, "content-type") |> List.first() =~ "image/png"

      # origin stripped; path crosses as a query param to the owner's own /file.
      assert StubGetFileClient.last().url ==
               "http://localhost:4001/api/v1/file?path=%2Fabs%2Fon%2Fcandide.png"
    end

    test "forwards file-info to the owning daemon without downloading the file" do
      stub_forward(
        "candide",
        "http://localhost:4001",
        {:ok, 200, "application/json", ~s({"exists":true,"modified_at":7,"size":3})}
      )

      conn =
        get(
          api_conn(),
          "/api/v1/file-info?path=#{URI.encode_www_form("/abs/on/candide.png")}&origin=candide"
        )

      assert conn.status == 200
      assert json_response(conn, 200) == %{"exists" => true, "modified_at" => 7, "size" => 3}

      assert StubGetFileClient.last().url ==
               "http://localhost:4001/api/v1/file-info?path=%2Fabs%2Fon%2Fcandide.png"
    end

    test "relays the remote content-type VERBATIM — no doubled charset" do
      # The owner serves through Phoenix, so its content-type already carries
      # `; charset=utf-8`. Relaying must not append a SECOND charset, or the
      # header becomes `image/png; charset=utf-8; charset=utf-8` and browsers
      # reject the image (the broken-image / blue-question-mark bug on a
      # remote-owned sent file).
      stub_forward(
        "candide",
        "http://localhost:4001",
        {:ok, 200, "image/png; charset=utf-8", <<137, 80, 78, 71>>}
      )

      conn =
        get(
          api_conn(),
          "/api/v1/file?path=#{URI.encode_www_form("/abs/on/candide.png")}&origin=candide"
        )

      assert get_resp_header(conn, "content-type") == ["image/png; charset=utf-8"]
    end

    test "relays the remote's status verbatim (a remote 404 stays a 404)" do
      stub_forward(
        "candide",
        "http://localhost:4001",
        {:ok, 404, "application/json", ~s({"error":"x"})}
      )

      conn = get(api_conn(), "/api/v1/file?path=#{URI.encode_www_form("/gone")}&origin=candide")
      assert conn.status == 404
    end

    test "502 when the tunnel forward fails" do
      stub_forward("candide", "http://localhost:4001", {:error, :econnrefused})

      conn = get(api_conn(), "/api/v1/file?path=#{URI.encode_www_form("/x")}&origin=candide")
      assert conn.status == 502
      assert %{"error" => _} = json_response(conn, 502)
    end
  end

  defp stub_forward(remote_name, remote_url, response) do
    start_supervised!(StubGetFileClient)
    StubGetFileClient.set_response(response)

    previous_remotes = Application.get_env(:shuttle, :remotes)
    previous_client = Application.get_env(:shuttle, :write_forward_client)
    Application.put_env(:shuttle, :remotes, [%{name: remote_name, url: remote_url}])
    Application.put_env(:shuttle, :write_forward_client, StubGetFileClient)

    on_exit(fn ->
      restore_app_env(:remotes, previous_remotes)
      restore_app_env(:write_forward_client, previous_client)
    end)
  end

  defp tmp_path(ext),
    do:
      Path.join(
        System.tmp_dir!(),
        "shuttle_file_ctrl_#{System.unique_integer([:positive])}.#{ext}"
      )

  defp api_conn do
    build_conn()
    |> put_req_header("accept", "application/json")
  end
end
