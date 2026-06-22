defmodule ShuttleWeb.AstraControllerTest do
  @moduledoc """
  Wiring for `GET /api/v1/astra` — the owner-routed astra.yaml → mdast bake the
  paper render reads. Local validation (absolute path, dir + astra.yaml present)
  is exercised against temp dirs; the remote branch reuses the shared
  `Shuttle.OriginRouter.forward_get/4` with a stubbed transport, mirroring the
  file-controller forward tests. A real end-to-end bake runs only when a
  built MySTRA + the iris example checkout + `node` are present (skipped in CI).
  """
  use ExUnit.Case
  import Plug.Conn
  import Phoenix.ConnTest

  @endpoint ShuttleWeb.Endpoint

  # Sibling LightconeResearch checkout's canonical example, if present.
  @iris_dir Path.expand(
              Path.join([__DIR__, "..", "..", "..", "..", "LightconeResearch", "ASTRA", "examples", "iris"])
            )

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

  describe "local validation" do
    test "400 when path is missing" do
      conn = get(api_conn(), "/api/v1/astra")
      assert conn.status == 400
      assert %{"error" => "path is required"} = json_response(conn, 400)
    end

    test "400 for a relative path" do
      conn = get(api_conn(), "/api/v1/astra?path=relative/proj")
      assert conn.status == 400
      assert %{"error" => "path must be absolute"} = json_response(conn, 400)
    end

    test "404 when the project dir does not exist" do
      conn = get(api_conn(), "/api/v1/astra?path=#{URI.encode_www_form(tmp_dir())}")
      assert conn.status == 404
      assert %{"error" => "project dir not found"} = json_response(conn, 404)
    end

    test "404 when the dir has no astra.yaml" do
      dir = tmp_dir()
      File.mkdir_p!(dir)
      on_exit(fn -> File.rm_rf(dir) end)

      conn = get(api_conn(), "/api/v1/astra?path=#{URI.encode_www_form(dir)}")
      assert conn.status == 404
      assert %{"error" => "no astra.yaml in project dir"} = json_response(conn, 404)
    end
  end

  describe "remote forward" do
    test "forwards a remote-owned astra.yaml to the owning daemon and relays JSON" do
      stub_forward("candide", "http://localhost:4001", {:ok, 200, "application/json", ~s({"pages":[]})})

      conn =
        get(api_conn(), "/api/v1/astra?path=#{URI.encode_www_form("/abs/on/candide/repro")}&origin=candide")

      assert conn.status == 200
      assert %{"pages" => []} = json_response(conn, 200)

      # origin stripped; path crosses as a query param to the owner's own /astra.
      assert StubGetFileClient.last().url ==
               "http://localhost:4001/api/v1/astra?path=%2Fabs%2Fon%2Fcandide%2Frepro"
    end

    test "relays the remote's status verbatim (a remote 502 stays a 502)" do
      stub_forward("candide", "http://localhost:4001", {:ok, 502, "application/json", ~s({"error":"bake failed"})})

      conn = get(api_conn(), "/api/v1/astra?path=#{URI.encode_www_form("/x")}&origin=candide")
      assert conn.status == 502
    end

    test "502 when the tunnel forward fails" do
      stub_forward("candide", "http://localhost:4001", {:error, :econnrefused})

      conn = get(api_conn(), "/api/v1/astra?path=#{URI.encode_www_form("/x")}&origin=candide")
      assert conn.status == 502
      assert %{"error" => _} = json_response(conn, 502)
    end
  end

  if File.dir?(@iris_dir) and System.find_executable("node") do
    describe "real bake (iris example present)" do
      @tag :integration
      test "200 with baked pages for the iris example" do
        conn = get(api_conn(), "/api/v1/astra?path=#{URI.encode_www_form(@iris_dir)}")

        assert conn.status == 200
        body = json_response(conn, 200)
        assert [page | _] = body["pages"]
        assert page["slug"] == "index"
        assert is_list(page["ast"]["children"])
        assert length(page["ast"]["children"]) > 0
      end
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

  defp tmp_dir,
    do: Path.join(System.tmp_dir!(), "shuttle_astra_ctrl_#{System.unique_integer([:positive])}")

  defp api_conn do
    build_conn()
    |> put_req_header("accept", "application/json")
  end
end
