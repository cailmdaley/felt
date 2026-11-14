defmodule ShuttleWeb.RecentSessionsControllerTest do
  @moduledoc """
  `GET /api/v1/sessions/recent` — on this host it shells
  `shuttle sessions --json --local --since=…` through the `:felt_runner` seam;
  for a remote it forwards to that daemon with `host=local`.
  """

  use ExUnit.Case, async: false
  import Shuttle.Test.ApiConn
  import Phoenix.ConnTest

  alias Shuttle.Test.{Env, StubGetFileClient}

  @endpoint ShuttleWeb.Endpoint

  defmodule MockRunner do
    @behaviour Shuttle.Runner

    @impl true
    def cmd("shuttle", args, _opts) do
      send(Shuttle.Env.app(:rs_test_pid), {:argv, args})

      if "--since=broken" in args do
        {"--since must be a duration", 1}
      else
        {Jason.encode!(%{
           "host" => "mac",
           "since" => "2026-11-13T00:00:00Z",
           "sessions" => [%{"session" => "s1", "live" => false}],
           "errors" => []
         }), 0}
      end
    end
  end

  setup do
    Env.put_app_env(:felt_runner, MockRunner)
    Env.put_app_env(:rs_test_pid, self())
    :ok
  end

  test "lists this host's sessions through the CLI" do
    body =
      local_conn()
      |> get("/api/v1/sessions/recent", %{"since" => "2026-11-13", "harness" => "codex"})
      |> json_response(200)

    assert [%{"session" => "s1", "live" => false}] = body["sessions"]

    assert_received {:argv,
                     ["sessions", "--json", "--local", "--since=2026-11-13", "--harness=codex"]}
  end

  test "since is required and a CLI failure is a 502" do
    assert %{"error" => "since is required"} =
             local_conn() |> get("/api/v1/sessions/recent") |> json_response(400)

    assert %{"error" => "shuttle sessions exited 1"} =
             local_conn()
             |> get("/api/v1/sessions/recent", %{"since" => "broken"})
             |> json_response(502)
  end

  describe "remote host routing" do
    setup do
      StubGetFileClient.start!()
      Env.put_app_env(:write_forward_client, StubGetFileClient)
      Env.put_app_env(:remotes, [%{name: "candide", url: "http://127.0.0.1:19999"}])
      :ok
    end

    test "forwards to the owner with host=local and relays its document" do
      doc = %{"host" => "candide", "since" => "x", "sessions" => [], "errors" => []}
      StubGetFileClient.set_response({:ok, 200, "application/json", Jason.encode!(doc)})

      assert ^doc =
               local_conn()
               |> get("/api/v1/sessions/recent", %{"since" => "1d", "host" => "candide"})
               |> json_response(200)

      query =
        StubGetFileClient.last().url |> URI.parse() |> Map.fetch!(:query) |> URI.decode_query()

      assert query == %{"host" => "local", "since" => "1d"}
      refute_received {:argv, _}
    end

    test "an unknown host is a 503" do
      assert %{"error" => "host nowhere is not in this daemon's fleet"} =
               local_conn()
               |> get("/api/v1/sessions/recent", %{"since" => "1d", "host" => "nowhere"})
               |> json_response(503)
    end
  end
end
