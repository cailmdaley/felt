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
  import Plug.Conn
  import Phoenix.ConnTest

  @endpoint ShuttleWeb.Endpoint

  # GET transport stub for the cross-host /file forward. Records the last url it
  # was asked to fetch and replays a scripted `get_file/2` response, so the
  # forward leg runs without a real tunnel. Defined before the tests so its
  # nested alias is established at every reference.
  defmodule StubGetFileClient do
    use Agent

    def start_link(_ \\ []),
      do: Agent.start_link(fn -> %{response: nil, last: nil} end, name: __MODULE__)

    def set_response(response), do: Agent.update(__MODULE__, &Map.put(&1, :response, response))
    def last, do: Agent.get(__MODULE__, & &1.last)

    def get_file(url, _timeout_ms) do
      Agent.update(__MODULE__, &Map.put(&1, :last, %{url: url}))
      Agent.get(__MODULE__, & &1.response)
    end
  end

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
      stub_forward("candide", "http://localhost:4001", {:ok, 200, "image/png", <<137, 80, 78, 71>>})

      conn =
        get(api_conn(), "/api/v1/file?path=#{URI.encode_www_form("/abs/on/candide.png")}&origin=candide")

      assert conn.status == 200
      assert conn.resp_body == <<137, 80, 78, 71>>
      assert get_resp_header(conn, "content-type") |> List.first() =~ "image/png"

      # origin stripped; path crosses as a query param to the owner's own /file.
      assert StubGetFileClient.last().url ==
               "http://localhost:4001/api/v1/file?path=%2Fabs%2Fon%2Fcandide.png"
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
        get(api_conn(), "/api/v1/file?path=#{URI.encode_www_form("/abs/on/candide.png")}&origin=candide")

      assert get_resp_header(conn, "content-type") == ["image/png; charset=utf-8"]
    end

    test "relays the remote's status verbatim (a remote 404 stays a 404)" do
      stub_forward("candide", "http://localhost:4001", {:ok, 404, "application/json", ~s({"error":"x"})})

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

  defp restore_app_env(key, nil), do: Application.delete_env(:shuttle, key)
  defp restore_app_env(key, value), do: Application.put_env(:shuttle, key, value)

  defp tmp_path(ext),
    do: Path.join(System.tmp_dir!(), "shuttle_file_ctrl_#{System.unique_integer([:positive])}.#{ext}")

  defp api_conn do
    build_conn()
    |> put_req_header("accept", "application/json")
  end
end
