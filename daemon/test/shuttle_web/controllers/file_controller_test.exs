defmodule ShuttleWeb.FileControllerTest do
  @moduledoc """
  Wiring for `GET /api/v1/file` — the owner-routed file-bytes route the
  standalone UI's fiber panel reads for `:::{embed}` artifacts and relative
  images. The local branch (absolute-path read + MIME + bytes) is exercised
  against real temp files; the remote branch uses the header-aware
  `Shuttle.OriginRouter.forward_file_get/5` with a stubbed transport.
  """
  use ExUnit.Case
  import Shuttle.Test.ForwardStub
  import Shuttle.Test.ApiConn
  alias Shuttle.Test.StubGetFileClient
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

    @tag :tmp_dir
    test "serves a sibling asset to an opaque report origin without ACAO", %{tmp_dir: dir} do
      report_dir = Path.join(dir, "report")
      report_path = Path.join(report_dir, "index.html")
      css_path = Path.join(report_dir, "foo.css")
      File.mkdir_p!(report_dir)
      File.write!(report_path, ~s(<link rel="stylesheet" href="foo.css">))
      File.write!(css_path, "body { color: red; }")

      report_url = URI.parse("http://127.0.0.1" <> file_asset_url("local", report_path))
      sibling_url = report_url |> URI.merge("foo.css") |> Map.fetch!(:path)
      assert sibling_url == file_asset_url("local", css_path)

      conn =
        local_conn()
        |> put_req_header("origin", "null")
        |> put_req_header("accept", "text/css")
        |> get(sibling_url)

      assert conn.status == 200
      assert conn.resp_body == "body { color: red; }"
      assert get_resp_header(conn, "content-type") |> List.first() =~ "text/css"
      assert get_resp_header(conn, "access-control-allow-origin") == []
    end

    @tag :tmp_dir
    test "404 for a missing sibling asset from an opaque report origin", %{tmp_dir: dir} do
      path = Path.join([dir, "report", "missing.css"])

      conn =
        local_conn()
        |> put_req_header("origin", "null")
        |> put_req_header("accept", "text/css")
        |> get(file_asset_url("local", path))

      assert conn.status == 404
      assert %{"error" => "file not found"} = json_response(conn, 404)
      assert get_resp_header(conn, "access-control-allow-origin") == []
    end

    test "uses browser media types for common audio and video extensions" do
      for {extension, content_type} <- [
            {"mp3", "audio/mpeg"},
            {"wav", "audio/wav"},
            {"m4a", "audio/mp4"},
            {"aac", "audio/aac"},
            {"ogg", "audio/ogg"},
            {"oga", "audio/ogg"},
            {"flac", "audio/flac"},
            {"opus", "audio/ogg"},
            {"mp4", "video/mp4"},
            {"m4v", "video/x-m4v"},
            {"mov", "video/quicktime"},
            {"webm", "video/webm"}
          ] do
        path = tmp_path(extension)
        File.write!(path, "media")
        on_exit(fn -> File.rm(path) end)

        conn = get(api_conn(), "/api/v1/file?path=#{URI.encode_www_form(path)}")

        assert conn.status == 200
        assert conn.resp_body == "media"
        assert get_resp_header(conn, "content-type") == [content_type]
      end
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

    test "serves an MP3 byte range from the requested seek offset" do
      audio = :binary.copy("0123456789", 10)
      path = tmp_path("mp3")
      File.write!(path, audio)
      on_exit(fn -> File.rm(path) end)
      url = "/api/v1/file?path=#{URI.encode_www_form(path)}"

      full = get(api_conn(), url)
      assert full.status == 200
      assert full.resp_body == audio
      assert get_resp_header(full, "accept-ranges") == ["bytes"]
      assert get_resp_header(full, "content-length") == ["100"]
      assert get_resp_header(full, "content-type") == ["audio/mpeg"]

      seek = api_conn() |> put_req_header("range", "bytes=75-") |> get(url)

      assert seek.status == 206
      assert seek.resp_body == binary_part(audio, 75, 25)
      assert get_resp_header(seek, "accept-ranges") == ["bytes"]
      assert get_resp_header(seek, "content-range") == ["bytes 75-99/100"]
      assert get_resp_header(seek, "content-length") == ["25"]
      assert get_resp_header(seek, "content-type") == ["audio/mpeg"]
    end

    test "serves bounded, open-ended, and suffix byte ranges" do
      path = tmp_path("mp4")
      File.write!(path, "0123456789")
      on_exit(fn -> File.rm(path) end)
      url = "/api/v1/file?path=#{URI.encode_www_form(path)}"

      for {range, body, content_range} <- [
            {"bytes=2-5", "2345", "bytes 2-5/10"},
            {"bytes=3-", "3456789", "bytes 3-9/10"},
            {"bytes=-3", "789", "bytes 7-9/10"},
            {"bytes=8-99", "89", "bytes 8-9/10"}
          ] do
        conn = api_conn() |> put_req_header("range", range) |> get(url)

        assert conn.status == 206
        assert conn.resp_body == body
        assert get_resp_header(conn, "accept-ranges") == ["bytes"]
        assert get_resp_header(conn, "content-range") == [content_range]
        assert get_resp_header(conn, "content-length") == [Integer.to_string(byte_size(body))]
        assert get_resp_header(conn, "content-type") == ["video/mp4"]
      end
    end

    test "returns 416 and the representation size for unsatisfiable byte ranges" do
      path = tmp_path("mp4")
      File.write!(path, "0123456789")
      on_exit(fn -> File.rm(path) end)
      url = "/api/v1/file?path=#{URI.encode_www_form(path)}"

      for range <- ["bytes=10-", "bytes=10-12", "bytes=-0"] do
        conn = api_conn() |> put_req_header("range", range) |> get(url)

        assert conn.status == 416
        assert conn.resp_body == ""
        assert get_resp_header(conn, "accept-ranges") == ["bytes"]
        assert get_resp_header(conn, "content-range") == ["bytes */10"]
        assert get_resp_header(conn, "content-length") == ["0"]
      end
    end

    test "ignores malformed and multiple ranges" do
      path = tmp_path("mp4")
      File.write!(path, "0123456789")
      on_exit(fn -> File.rm(path) end)
      url = "/api/v1/file?path=#{URI.encode_www_form(path)}"

      for range <- ["bytes=bad", "items=0-1", "bytes=", "bytes=0-1,4-5", "bytes=4-2"] do
        conn = api_conn() |> put_req_header("range", range) |> get(url)

        assert conn.status == 200
        assert conn.resp_body == "0123456789"
        assert get_resp_header(conn, "content-range") == []
      end
    end

    test "If-Range dates authorize current ranges, but weak ETags and old dates do not" do
      path = tmp_path("mp4")
      File.write!(path, "0123456789")
      File.touch!(path, {{2020, 1, 1}, {0, 0, 0}})
      on_exit(fn -> File.rm(path) end)
      url = "/api/v1/file?path=#{URI.encode_www_form(path)}"

      first = get(api_conn(), url)
      [etag] = get_resp_header(first, "etag")
      [last_modified] = get_resp_header(first, "last-modified")
      assert String.starts_with?(etag, "W/")

      ranged =
        api_conn()
        |> put_req_header("range", "bytes=0-1")
        |> put_req_header("if-range", last_modified)
        |> get(url)

      assert ranged.status == 206
      assert ranged.resp_body == "01"

      weak_tag =
        api_conn()
        |> put_req_header("range", "bytes=0-1")
        |> put_req_header("if-range", etag)
        |> get(url)

      assert weak_tag.status == 200
      assert weak_tag.resp_body == "0123456789"
      assert get_resp_header(weak_tag, "content-range") == []

      stale_date =
        api_conn()
        |> put_req_header("range", "bytes=0-1")
        |> put_req_header("if-range", "Thu, 01 Jan 1970 00:00:00 GMT")
        |> get(url)

      assert stale_date.status == 200
      assert stale_date.resp_body == "0123456789"

      future_date =
        api_conn()
        |> put_req_header("range", "bytes=0-1")
        |> put_req_header("if-range", "Tue, 01 Jan 2030 00:00:00 GMT")
        |> get(url)

      assert future_date.status == 200
      assert future_date.resp_body == "0123456789"
    end

    test "200 carries ETag, Last-Modified, and Cache-Control validators" do
      path = tmp_path("txt")
      File.write!(path, "hello embed")
      on_exit(fn -> File.rm(path) end)

      conn = get(api_conn(), "/api/v1/file?path=#{URI.encode_www_form(path)}")

      assert conn.status == 200
      assert [etag] = get_resp_header(conn, "etag")
      assert etag =~ ~r/^W\/"sha256-[0-9a-f]{64}"$/
      assert [_last_modified] = get_resp_header(conn, "last-modified")
      assert get_resp_header(conn, "cache-control") == ["public, max-age=300"]
    end

    test "equal-size rewrites with the same timestamp do not return 304" do
      path = tmp_path("html")
      on_exit(fn -> File.rm(path) end)
      stamp = {{2020, 1, 1}, {0, 0, 0}}
      url = "/api/v1/file?path=#{URI.encode_www_form(path)}"

      File.write!(path, "<p>old</p>")
      File.touch!(path, stamp)
      first = get(api_conn(), url)
      [etag] = get_resp_header(first, "etag")

      File.write!(path, "<p>new</p>")
      File.touch!(path, stamp)
      second = api_conn() |> put_req_header("if-none-match", etag) |> get(url)

      assert second.status == 200
      assert second.resp_body == "<p>new</p>"
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
        |> put_req_header("range", "bytes=0-1")
        |> get("/api/v1/file?path=#{URI.encode_www_form(path)}")

      assert conn.status == 304
      assert conn.resp_body == ""
      assert get_resp_header(conn, "content-range") == []
    end

    test "If-Modified-Since alone never returns 304" do
      path = tmp_path("txt")
      File.write!(path, "hello embed")
      on_exit(fn -> File.rm(path) end)

      first = get(api_conn(), "/api/v1/file?path=#{URI.encode_www_form(path)}")
      [last_modified] = get_resp_header(first, "last-modified")
      [etag] = get_resp_header(first, "etag")
      assert etag =~ ~r/^W\/"sha256-[0-9a-f]{64}"$/

      conn =
        api_conn()
        |> put_req_header("if-modified-since", last_modified)
        |> get("/api/v1/file?path=#{URI.encode_www_form(path)}")

      assert conn.status == 200
      assert conn.resp_body == "hello embed"
    end

    test "If-None-Match takes precedence over a matching If-Modified-Since" do
      path = tmp_path("txt")
      File.write!(path, "hello embed")
      on_exit(fn -> File.rm(path) end)

      first = get(api_conn(), "/api/v1/file?path=#{URI.encode_www_form(path)}")
      [last_modified] = get_resp_header(first, "last-modified")
      stale_etag = ~s(W/"00000000000000000000000000000000")

      conn =
        api_conn()
        |> put_req_header("if-none-match", stale_etag)
        |> put_req_header("if-modified-since", last_modified)
        |> get("/api/v1/file?path=#{URI.encode_www_form(path)}")

      assert conn.status == 200
      assert conn.resp_body == "hello embed"
    end

    test "If-None-Match accepts a matching list member and wildcard" do
      path = tmp_path("txt")
      File.write!(path, "hello embed")
      on_exit(fn -> File.rm(path) end)

      first = get(api_conn(), "/api/v1/file?path=#{URI.encode_www_form(path)}")
      [etag] = get_resp_header(first, "etag")

      conn =
        api_conn()
        |> put_req_header("if-none-match", ~s("other", #{etag}))
        |> get("/api/v1/file?path=#{URI.encode_www_form(path)}")

      assert conn.status == 304

      conn =
        api_conn()
        |> put_req_header("if-none-match", "*")
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
        local_conn()
        |> Plug.Conn.put_req_header("accept", "application/pdf")
        |> get("/api/v1/file?path=#{URI.encode_www_form(path)}")

      assert conn.status == 200
      assert conn.resp_body == "%PDF-1.4 fake"
    end
  end

  describe "bounded file I/O" do
    @tag :tmp_dir
    test "large ranges use file offsets and a metadata ETag without reading the whole file", %{
      tmp_dir: dir
    } do
      path = sparse_file(dir, 12 * 1024 * 1024)
      url = "/api/v1/file?path=#{URI.encode_www_form(path)}"

      {conn, reads} =
        Shuttle.Test.FileReadTrace.run(fn ->
          api_conn() |> put_req_header("range", "bytes=2-5") |> get(url)
        end)

      assert conn.status == 206
      assert conn.resp_body == <<0, 0, 0, 0>>
      assert get_resp_header(conn, "content-range") == ["bytes 2-5/12582912"]
      assert [etag] = get_resp_header(conn, "etag")
      assert etag =~ ~r/^W\/"stat-/
      assert reads == []
      assert conn.state == :file
    end

    @tag :tmp_dir
    test "open-ended ranges stop after four MiB", %{tmp_dir: dir} do
      path = sparse_file(dir, 12 * 1024 * 1024)

      conn =
        api_conn()
        |> put_req_header("range", "bytes=7-")
        |> get("/api/v1/file?path=#{URI.encode_www_form(path)}")

      assert conn.status == 206
      assert byte_size(conn.resp_body) == 4 * 1024 * 1024
      assert get_resp_header(conn, "content-range") == ["bytes 7-4194310/12582912"]
      assert get_resp_header(conn, "content-length") == ["4194304"]
    end

    @tag :tmp_dir
    test "large full GET delegates to send_file without a whole-file read", %{tmp_dir: dir} do
      path = sparse_file(dir, 2 * 1024 * 1024)

      {conn, reads} =
        Shuttle.Test.FileReadTrace.run(fn ->
          get(api_conn(), "/api/v1/file?path=#{URI.encode_www_form(path)}")
        end)

      assert conn.status == 200
      assert conn.state == :file
      assert reads == []
    end

    @tag :tmp_dir
    test "HEAD reads no file body for either small or large files and ignores Range", %{
      tmp_dir: dir
    } do
      for size <- [10, 2 * 1024 * 1024] do
        path = sparse_file(dir, size)

        {conn, reads} =
          Shuttle.Test.FileReadTrace.run(fn ->
            api_conn()
            |> put_req_header("range", "bytes=2-5")
            |> head("/api/v1/file?path=#{URI.encode_www_form(path)}")
          end)

        assert conn.status == 200
        assert conn.resp_body == ""
        assert get_resp_header(conn, "content-length") == [Integer.to_string(size)]
        assert get_resp_header(conn, "content-range") == []
        assert reads == []
      end
    end

    @tag :tmp_dir
    test "large suffix ranges and If-Range fallbacks keep file-backed responses", %{tmp_dir: dir} do
      path = sparse_file(dir, 2 * 1024 * 1024)
      url = "/api/v1/file?path=#{URI.encode_www_form(path)}"
      first = api_conn() |> head(url)
      [etag] = get_resp_header(first, "etag")
      [date] = get_resp_header(first, "last-modified")

      suffix = api_conn() |> put_req_header("range", "bytes=-3") |> get(url)
      assert suffix.status == 206
      assert suffix.resp_body == <<0, 0, 0>>
      assert suffix.state == :file
      assert get_resp_header(suffix, "content-range") == ["bytes 2097149-2097151/2097152"]

      for {validator, status} <- [
            {date, 206},
            {etag, 200},
            {"Thu, 01 Jan 1970 00:00:00 GMT", 200}
          ] do
        {conn, reads} =
          Shuttle.Test.FileReadTrace.run(fn ->
            api_conn()
            |> put_req_header("range", "bytes=0-1")
            |> put_req_header("if-range", validator)
            |> get(url)
          end)

        assert conn.status == status
        assert conn.state == :file
        assert reads == []
      end
    end

    @tag :tmp_dir
    test "large metadata validators track mtime, size, and inode", %{tmp_dir: dir} do
      path = sparse_file(dir, 2 * 1024 * 1024)
      url = "/api/v1/file?path=#{URI.encode_www_form(path)}"
      token = fn -> api_conn() |> head(url) |> get_resp_header("etag") end
      stamp = {{2020, 1, 1}, {0, 0, 0}}
      File.touch!(path, stamp)
      original = token.()
      File.touch!(path, {{2021, 1, 1}, {0, 0, 0}})
      assert token.() != original
      File.touch!(path, stamp)
      File.write!(path, "x", [:append])
      assert token.() != original
      replacement = sparse_file(dir, 2 * 1024 * 1024)
      # Keep the old inode allocated until the replacement has been created.
      File.rename!(replacement, path <> ".old")
      sparse_file(dir, 2 * 1024 * 1024)
      File.touch!(path, stamp)
      assert token.() != original
    end

    @tag :tmp_dir
    test "large matching validators return 304 without a body read", %{tmp_dir: dir} do
      path = sparse_file(dir, 2 * 1024 * 1024)
      url = "/api/v1/file?path=#{URI.encode_www_form(path)}"
      first = api_conn() |> head(url)
      [etag] = get_resp_header(first, "etag")

      {conn, reads} =
        Shuttle.Test.FileReadTrace.run(fn ->
          api_conn() |> put_req_header("if-none-match", etag) |> get(url)
        end)

      assert conn.status == 304
      assert conn.resp_body == ""
      assert reads == []
    end
  end

  defp sparse_file(dir, size) do
    path = Path.join(dir, "media-#{size}.mp4")
    {:ok, file} = :file.open(String.to_charlist(path), [:write, :binary, :raw])
    :ok = :file.pwrite(file, size - 1, <<0>>)
    :ok = :file.close(file)
    path
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

    test "forwards relative report assets through the owner's existing /file route" do
      stub_forward("candide", "http://localhost:4001", {:ok, 200, "text/css", "body {}"})

      conn = get(api_conn(), file_asset_url("candide", "/project/report/foo.css"))

      assert conn.status == 200
      assert conn.resp_body == "body {}"
      assert get_resp_header(conn, "content-type") == ["text/css"]
      assert StubGetFileClient.last().url ==
               "http://localhost:4001/api/v1/file?path=%2Fproject%2Freport%2Ffoo.css"
    end

    test "forwards conditional headers and relays a remote 304 with its validators" do
      etag = ~s(W/"remote-file")

      headers = [
        {"etag", etag},
        {"last-modified", "Tue, 01 Jan 2030 00:00:00 GMT"},
        {"cache-control", "public, max-age=300"}
      ]

      stub_forward(
        "candide",
        "http://localhost:4001",
        {:ok, 304, headers, "application/octet-stream", ""}
      )

      last_modified = "Tue, 01 Jan 2030 00:00:00 GMT"

      conn =
        api_conn()
        |> put_req_header("if-none-match", etag)
        |> put_req_header("if-modified-since", last_modified)
        |> get("/api/v1/file?path=#{URI.encode_www_form("/abs/on/candide.html")}&origin=candide")

      assert conn.status == 304
      assert conn.resp_body == ""
      assert get_resp_header(conn, "etag") == [etag]
      assert get_resp_header(conn, "last-modified") == [last_modified]
      assert get_resp_header(conn, "cache-control") == ["public, max-age=300"]

      assert StubGetFileClient.last().headers == [
               {"if-none-match", etag},
               {"if-modified-since", last_modified}
             ]

      assert StubGetFileClient.last().url ==
               "http://localhost:4001/api/v1/file?path=%2Fabs%2Fon%2Fcandide.html"
    end

    test "forwards Range and If-Range and relays a remote 206 byte response" do
      last_modified = "Tue, 01 Jan 2030 00:00:00 GMT"
      etag = ~s(W/"remote-media")

      headers = [
        {"accept-ranges", "bytes"},
        {"content-range", "bytes 2-4/10"},
        {"content-length", "3"},
        {"content-type", "audio/mpeg"},
        {"etag", etag},
        {"last-modified", last_modified},
        {"cache-control", "public, max-age=300"}
      ]

      stub_forward(
        "candide",
        "http://localhost:4001",
        {:ok, 206, headers, "audio/mpeg", "abc"}
      )

      conn =
        api_conn()
        |> put_req_header("range", "bytes=2-4")
        |> put_req_header("if-range", last_modified)
        |> get("/api/v1/file?path=#{URI.encode_www_form("/abs/on/candide.mp3")}&origin=candide")

      assert conn.status == 206
      assert conn.resp_body == "abc"
      assert get_resp_header(conn, "accept-ranges") == ["bytes"]
      assert get_resp_header(conn, "content-range") == ["bytes 2-4/10"]
      assert get_resp_header(conn, "content-length") == ["3"]
      assert get_resp_header(conn, "content-type") == ["audio/mpeg"]
      assert get_resp_header(conn, "etag") == [etag]
      assert get_resp_header(conn, "last-modified") == [last_modified]
      assert get_resp_header(conn, "cache-control") == ["public, max-age=300"]

      assert StubGetFileClient.last().headers == [
               {"range", "bytes=2-4"},
               {"if-range", last_modified}
             ]
    end

    test "bounds single range requests before forwarding to an older owner" do
      stub_forward("candide", "http://localhost:4001", {:ok, 206, [], "video/mp4", "abc"})
      url = "/api/v1/file?path=%2Fremote.mp4&origin=candide"

      for {requested, forwarded} <- [
            {"bytes=7-", "bytes=7-4194310"},
            {"bytes=7-99999999", "bytes=7-4194310"},
            {"bytes=-99999999", "bytes=-4194304"},
            {"bytes=-3", "bytes=-3"},
            {"bytes=4-2", "bytes=4-2"}
          ] do
        conn = api_conn() |> put_req_header("range", requested) |> get(url)
        assert conn.status == 206
        assert StubGetFileClient.last().headers == [{"range", forwarded}]
        assert StubGetFileClient.last().timeout == 30_000
      end
    end

    test "relays four-MiB remote partial media with its exact byte metadata" do
      body = :binary.copy("x", 4 * 1024 * 1024)
      headers = [{"content-range", "bytes 7-4194310/99999999"}, {"content-length", "4194304"}]
      stub_forward("candide", "http://localhost:4001", {:ok, 206, headers, "video/mp4", body})

      conn =
        api_conn()
        |> put_req_header("range", "bytes=7-")
        |> get("/api/v1/file?path=%2Fremote.mp4&origin=candide")

      assert conn.status == 206
      assert conn.resp_body == body
      assert get_resp_header(conn, "content-range") == ["bytes 7-4194310/99999999"]
      assert get_resp_header(conn, "content-length") == ["4194304"]
      assert StubGetFileClient.last().headers == [{"range", "bytes=7-4194310"}]
    end

    test "limits a remote error body to 64KiB and corrects Content-Length" do
      body = :binary.copy("error", 100_000)
      headers = [{"content-length", Integer.to_string(byte_size(body))}]

      stub_forward(
        "candide",
        "http://localhost:4001",
        {:ok, 404, headers, "application/json", body}
      )

      conn = get(api_conn(), "/api/v1/file?path=%2Fmissing&origin=candide")
      assert conn.status == 404
      assert conn.resp_body == binary_part(body, 0, 64 * 1024)
      assert get_resp_header(conn, "content-length") == ["65536"]
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

    test "file-info retains the generic relay's response and does not apply file caps" do
      body = :binary.copy("x", 64 * 1024 + 1)
      stub_forward("candide", "http://localhost:4001", {:ok, 404, "text/plain", body})

      conn =
        api_conn()
        |> put_req_header("range", "bytes=7-")
        |> get("/api/v1/file-info?path=%2Fremote&origin=candide")

      assert conn.status == 404
      assert conn.resp_body == body
      assert StubGetFileClient.last().headers == []
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

  defp file_asset_url(origin, path) do
    encoded_origin = URI.encode(origin, fn char -> URI.char_unreserved?(char) end)

    encoded_path =
      path
      |> String.split("/", trim: true)
      |> Enum.map_join("/", fn segment ->
        URI.encode(segment, fn char -> URI.char_unreserved?(char) end)
      end)

    "/api/v1/file-assets/#{encoded_origin}/#{encoded_path}"
  end

  defp tmp_path(ext),
    do:
      Path.join(
        System.tmp_dir!(),
        "shuttle_file_ctrl_#{System.unique_integer([:positive])}.#{ext}"
      )
end
