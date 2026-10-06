defmodule ShuttleWeb.FileControllerTest do
  @moduledoc """
  Wiring for `GET /api/v1/file` — the owner-routed file-bytes route the
  standalone UI's fiber panel reads for `:::{embed}` artifacts and relative
  images. The local branch (absolute-path read + MIME + bytes) is exercised
  against real temp files; the remote branch uses the header-aware
  `Shuttle.OriginRouter.forward_file_get/5` with a stubbed transport.
  """
  # group: FileReadTrace sets a VM-wide call-trace pattern on File.read/1 (shared with PollerTest's :dbg).
  use ExUnit.Case, async: true, group: :call_trace
  use ExUnitProperties
  import Shuttle.Test.ForwardStub
  import Shuttle.Test.ApiConn
  alias Shuttle.Test.StubGetFileClient
  import Plug.Conn
  import Phoenix.ConnTest

  @endpoint ShuttleWeb.Endpoint
  @sandbox_policy "sandbox allow-scripts allow-popups " <>
                    "allow-popups-to-escape-sandbox allow-downloads allow-modals allow-forms"

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

    # The router decodes path segments before matching, so every spelling that
    # reaches FileController must carry the policy too.
    @tag :tmp_dir
    test "sandboxes percent-encoded spellings of the file routes", %{tmp_dir: dir} do
      path = Path.join(dir, "probe.xml")
      File.write!(path, "<x:script xmlns:x='http://www.w3.org/1999/xhtml'>1</x:script>")
      query = "path=#{URI.encode_www_form(path)}"
      asset = String.trim_leading(path, "/")

      for url <- [
            "/api/v1/fil%65?#{query}",
            "/%61pi/v1/file?#{query}",
            "/api/v%31/file?#{query}",
            "/api/v1/file-asset%73/local/#{asset}"
          ] do
        conn = get(api_conn(), url)

        assert conn.status == 200, url
        assert conn.resp_body =~ "x:script", url
        assert get_resp_header(conn, "content-security-policy") == [@sandbox_policy], url
        assert get_resp_header(conn, "x-content-type-options") == ["nosniff"], url
      end
    end

    @tag :tmp_dir
    test "sandboxes a sibling HTML asset opened from an opaque report", %{tmp_dir: dir} do
      report_path = Path.join(dir, "report.html")
      popup_path = Path.join(dir, "popup.html")
      File.write!(report_path, ~s(<a href="popup.html" target="_blank">open</a>))
      body = "<script>window.opener.location = 'https://example.invalid'</script>"
      File.write!(popup_path, body)

      report_url = URI.parse("http://127.0.0.1" <> file_asset_url("local", report_path))
      sibling_url = report_url |> URI.merge("popup.html") |> Map.fetch!(:path)
      assert sibling_url == file_asset_url("local", popup_path)

      conn =
        local_conn()
        |> put_req_header("origin", "null")
        |> put_req_header("accept", "text/html")
        |> get(sibling_url)

      assert conn.status == 200
      assert conn.resp_body == body
      assert get_resp_header(conn, "content-security-policy") == [@sandbox_policy]
      assert get_resp_header(conn, "access-control-allow-origin") == []
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

    # Only If-None-Match decides a 304: a list member that weakly matches the
    # served ETag, or `*`. If-Modified-Since never does, matching or stale, so a
    # same-second rewrite cannot be answered 304.
    property "304 exactly when an If-None-Match member matches the served ETag" do
      path = tmp_path("txt")
      File.write!(path, "hello embed")
      on_exit(fn -> File.rm(path) end)
      url = "/api/v1/file?path=#{URI.encode_www_form(path)}"

      first = get(api_conn(), url)
      [etag] = get_resp_header(first, "etag")
      [last_modified] = get_resp_header(first, "last-modified")
      "W/" <> strong_etag = etag

      stale_tag =
        string(?0..?9, length: 64)
        |> bind(fn digits -> member_of([~s(W/"sha256-#{digits}"), ~s("#{digits}")]) end)

      member =
        one_of([
          member_of([{:match, etag}, {:match, strong_etag}, {:match, "*"}]),
          map(stale_tag, &{:stale, &1})
        ])

      check all(
              members <- list_of(member, max_length: 4),
              separator <- member_of([",", ", ", " ,  "]),
              since <- member_of([nil, last_modified, "Thu, 01 Jan 1970 00:00:00 GMT"]),
              ranged? <- boolean(),
              max_runs: 100
            ) do
        conn =
          [
            {"if-none-match", members != [] and Enum.map_join(members, separator, &elem(&1, 1))},
            {"if-modified-since", since},
            {"range", ranged? and "bytes=0-1"}
          ]
          |> Enum.reject(fn {_name, value} -> value in [nil, false] end)
          |> Enum.reduce(api_conn(), fn {name, value}, conn ->
            put_req_header(conn, name, value)
          end)
          |> get(url)

        case {Enum.any?(members, &match?({:match, _}, &1)), ranged?} do
          {true, _} ->
            assert conn.status == 304
            assert conn.resp_body == ""
            assert get_resp_header(conn, "content-range") == []

          {false, true} ->
            assert conn.status == 206
            assert conn.resp_body == "he"

          {false, false} ->
            assert conn.status == 200
            assert conn.resp_body == "hello embed"
        end
      end
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

  describe "file security boundary" do
    # Scriptable documents (every HTML spelling, XML feeds, SVG), an extension
    # no table knows, and native media. The sandbox is independent of type, so
    # each keeps its served content type and gains the policy.
    @file_types [
      {"html", "text/html", "text/html"},
      {"htm", "text/html", "text/html"},
      {"HTML", "text/html", "text/html"},
      {"xhtml", "application/xhtml+xml", "application/xhtml+xml"},
      {"xml", "application/xml", "text/xml"},
      {"rss", "application/rss+xml", "application/rss+xml"},
      {"atom", "application/atom+xml", "application/atom+xml"},
      {"svg", "image/svg+xml", "image/svg+xml"},
      {"svgz", "image/svg+xml", "image/svg+xml"},
      {"unknown", "*/*", "application/octet-stream"},
      {"pdf", "application/pdf", "application/pdf"},
      {"mp3", "audio/mpeg", "audio/mpeg"},
      {"mp4", "video/mp4", "video/mp4"},
      {"png", "image/png", "image/png"}
    ]

    @tag :tmp_dir
    @tag :file_security
    test "sandboxes every local type and status on every byte route, without CORS access", %{
      tmp_dir: dir
    } do
      body = "<script>window.open('popup.html')</script>"

      for {extension, accept, content_type} <- @file_types, route <- byte_routes() do
        row = "local #{extension} on #{route}"
        path = Path.join(dir, "document.#{extension}")
        File.write!(path, body)
        url = file_url(route, "local", path)

        browser =
          local_conn() |> put_req_header("origin", "null") |> put_req_header("accept", accept)

        whole = get(browser, url)
        assert whole.status == 200, row
        assert whole.resp_body == body, row
        assert get_resp_header(whole, "content-type") |> List.first() =~ content_type, row
        [etag] = get_resp_header(whole, "etag")

        for {conn, status} <- [
              {whole, 200},
              {head(browser, url), 200},
              {browser |> put_req_header("range", "bytes=1-3") |> get(url), 206},
              {browser |> put_req_header("if-none-match", etag) |> get(url), 304},
              {browser |> put_req_header("range", "bytes=99-") |> get(url), 416}
            ] do
          assert conn.status == status, "#{row} #{status}"
          assert_file_security(conn, "#{row} #{status}")
          assert get_resp_header(conn, "access-control-allow-origin") == [], "#{row} #{status}"
        end
      end
    end

    @tag :file_security
    test "sandboxes every relayed type and status on every byte route, ignoring owner headers" do
      body = "<script>window.open('popup.html')</script>"

      unsafe_headers = [
        {"content-security-policy", "sandbox allow-scripts allow-same-origin"},
        {"x-content-type-options", "unsafe"},
        {"access-control-allow-origin", "null"}
      ]

      stub_forward("file-owner", "http://localhost:4001", {:error, :unset})

      for {extension, accept, content_type} <- @file_types, route <- byte_routes() do
        path = "/project/document.#{extension}"
        url = file_url(route, "file-owner", path)

        browser =
          local_conn() |> put_req_header("origin", "null") |> put_req_header("accept", accept)

        for {label, owner_response, status, relayed_body} <- [
              {"unsafe owner headers", {:ok, 200, unsafe_headers, content_type, body}, 200, body},
              {"owner omits CSP", {:ok, 200, content_type, body}, 200, body},
              {"206", {:ok, 206, [], content_type, ""}, 206, ""},
              {"304", {:ok, 304, [], content_type, ""}, 304, ""},
              {"404", {:ok, 404, [], content_type, ""}, 404, ""},
              {"416", {:ok, 416, [], content_type, ""}, 416, ""},
              {"relay failure", {:error, :econnrefused}, 502, nil}
            ] do
          row = "relayed #{extension} on #{route}: #{label}"
          StubGetFileClient.set_response(owner_response)

          conn = get(browser, url)
          assert conn.status == status, row
          if relayed_body, do: assert(conn.resp_body == relayed_body, row)
          assert_file_security(conn, row)
          assert get_resp_header(conn, "access-control-allow-origin") == [], row

          assert StubGetFileClient.last().url ==
                   "http://localhost:4001/api/v1/file?path=#{URI.encode_www_form(path)}",
                 row
        end
      end
    end

    @tag :tmp_dir
    @tag :file_security
    test "retains file security on missing and invalid paths", %{tmp_dir: dir} do
      for {url, status} <- [
            {"/api/v1/file", 400},
            {"/api/v1/file?path=", 400},
            {"/api/v1/file?path=relative.xml", 400},
            {file_url(:file, "local", Path.join(dir, "missing.xml")), 404},
            {file_asset_url("local", Path.join(dir, "missing.xml")), 404},
            {file_asset_url("local", dir), 404},
            {"/api/v1/file-assets/local", 400}
          ] do
        conn = get(api_conn(), url)
        assert conn.status == status
        assert_file_security(conn)
      end
    end

    @tag :file_security
    test "retains file security on CORS errors and preflight before the controller" do
      for url <- ["/api/v1/file", "/api/v1/file-assets/local/missing.xml"] do
        forbidden = local_conn() |> put_req_header("origin", "null") |> post(url)
        assert forbidden.status == 403
        assert_file_security(forbidden)

        preflight = options(local_conn(), url)
        assert preflight.status == 204
        assert_file_security(preflight)
      end
    end

    # Phoenix renders these from outside the endpoint pipeline.
    @tag :file_security
    test "retains file security when the endpoint raises before the controller" do
      for {label, request} <- [
            {"unparsable /file body", fn -> api_conn() |> post("/api/v1/file", "{") end},
            {"unparsable asset body",
             fn -> api_conn() |> post("/api/v1/file-assets/local/missing.xml", "{") end},
            {"undecodable query", fn -> get(api_conn(), "/api/v1/file?path=%FF") end}
          ] do
        {400, headers, _body} = assert_error_sent(400, request)

        assert List.keyfind(headers, "content-security-policy", 0) ==
                 {"content-security-policy", @sandbox_policy},
               label

        assert List.keyfind(headers, "x-content-type-options", 0) ==
                 {"x-content-type-options", "nosniff"},
               label
      end
    end

    @tag :file_security
    test "retains file security on booting responses before the controller" do
      # This test's own boot snapshot, not the one every request reads.
      Shuttle.Test.Env.own_scope!()
      Shuttle.Readiness.begin_boot()
      key = Shuttle.Env.scope_key({Shuttle.Readiness, :boot_state})
      on_exit(fn -> :persistent_term.erase(key) end)

      for url <- ["/api/v1/file", "/api/v1/file-assets/local/missing.xml"] do
        conn = get(api_conn(), url)
        assert conn.status == 503
        assert_file_security(conn)
      end
    end

    @tag :tmp_dir
    @tag :file_security
    test "sandboxes every API response but not the board page", %{tmp_dir: dir} do
      conn = get(api_conn(), "/api/v1/file-info?path=#{URI.encode_www_form(dir)}")
      assert conn.status == 200
      assert get_resp_header(conn, "content-security-policy") == [@sandbox_policy]
      assert get_resp_header(conn, "x-content-type-options") == ["nosniff"]

      conn = get(api_conn(), "/")
      assert get_resp_header(conn, "content-security-policy") == []
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

  describe "large documents" do
    @tag :tmp_dir
    test "a whole GET names a large document by its digest and an unchanged poll is a 304",
         %{tmp_dir: dir} do
      path = Path.join(dir, "report.html")
      body = :binary.copy("<p>report</p>", div(2 * 1024 * 1024, 13) + 1)
      File.write!(path, body)
      url = "/api/v1/file?path=#{URI.encode_www_form(path)}"
      digest = :crypto.hash(:sha256, body) |> Base.encode16(case: :lower)

      first = get(api_conn(), url)
      assert first.status == 200
      assert first.state == :file
      assert get_resp_header(first, "etag") == [~s(W/"sha256-#{digest}")]

      again = api_conn() |> put_req_header("if-none-match", ~s(W/"sha256-#{digest}")) |> get(url)
      assert again.status == 304
      assert again.resp_body == ""

      File.write!(path, "<p>rewritten</p>", [:append])

      changed =
        api_conn() |> put_req_header("if-none-match", ~s(W/"sha256-#{digest}")) |> get(url)

      assert changed.status == 200
      refute get_resp_header(changed, "etag") == [~s(W/"sha256-#{digest}")]
    end

    @tag :tmp_dir
    test "ranged and HEAD reads of a large document never read it to make a digest", %{
      tmp_dir: dir
    } do
      path = Path.join(dir, "report.html")
      File.write!(path, :binary.copy("x", 2 * 1024 * 1024))
      url = "/api/v1/file?path=#{URI.encode_www_form(path)}"

      {conns, reads} =
        Shuttle.Test.FileReadTrace.run(fn ->
          [
            api_conn() |> put_req_header("range", "bytes=0-65535") |> get(url),
            api_conn() |> head(url)
          ]
        end)

      assert Enum.map(conns, & &1.status) == [206, 200]
      assert Enum.all?(conns, &(hd(get_resp_header(&1, "etag")) =~ ~r/^W\/"stat-/))
      assert reads == []
    end

    @tag :tmp_dir
    test "a settled version's digest is remembered; a file still being written is not", %{
      tmp_dir: dir
    } do
      path = Path.join(dir, "report.html")
      File.write!(path, "draft")
      {:ok, stat} = File.stat(path, time: :posix)
      settled = max(stat.mtime, stat.ctime) + 2
      digest = :crypto.hash(:sha256, "draft") |> Base.encode16(case: :lower)

      assert ShuttleWeb.FileDigests.digest(path, stat, settled - 1) == {:ok, digest}
      assert ShuttleWeb.FileDigests.lookup(path, stat) == nil
      assert ShuttleWeb.FileDigests.digest(path, stat, settled) == {:ok, digest}
      assert ShuttleWeb.FileDigests.lookup(path, stat) == digest
      assert ShuttleWeb.FileDigests.lookup(path, %{stat | ctime: stat.ctime + 1}) == nil
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
      assert get_resp_header(conn, "content-security-policy") == [@sandbox_policy]
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

  defp assert_file_security(conn, message \\ "file security") do
    assert get_resp_header(conn, "content-security-policy") == [@sandbox_policy], message
    assert get_resp_header(conn, "x-content-type-options") == ["nosniff"], message
  end

  # The router's byte-serving FileController actions; `file_url/3` names each
  # one's URL, so a new byte route fails here until it is covered.
  defp byte_routes do
    for %{plug: ShuttleWeb.FileController, plug_opts: action} <-
          Phoenix.Router.routes(ShuttleWeb.Router),
        action != :info,
        do: action
  end

  defp file_url(action, origin, path) when action in [:file, :show],
    do: "/api/v1/file?#{URI.encode_query(%{"path" => path, "origin" => origin})}"

  defp file_url(:asset, origin, path), do: file_asset_url(origin, path)

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
