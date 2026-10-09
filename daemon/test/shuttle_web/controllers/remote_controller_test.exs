defmodule ShuttleWeb.RemoteControllerTest do
  @moduledoc """
  Wiring for `POST /api/v1/remotes/:name/reset`. The breaker behavior itself
  (trip after N cascades, one reset buys one cascade, auto-heal) is covered at
  the registry layer (`RemoteRegistryTest` "circuit breaker"); here we pin the
  HTTP contract: reset reaches the globally named RemoteRegistry and maps its
  returns onto statuses — 409 for a breaker that isn't tripped, 404 for an
  unconfigured remote, 503 when no registry runs.
  """
  use ExUnit.Case, async: true
  import Shuttle.Test.ApiConn
  import Plug.Conn
  import Phoenix.ConnTest

  @endpoint ShuttleWeb.Endpoint

  # The endpoint calls this test's Shuttle.RemoteRegistry (`Shuttle.Env.server/1`),
  # an unnamed instance registered in the test's scope.
  # auto_poll: false keeps the registry inert — no HTTP client is ever hit.
  defp start_registry do
    Shuttle.Test.Env.start_scoped!(
      %{
        id: make_ref(),
        start:
          {Shuttle.RemoteRegistry, :start_link,
           [
             [
               name: nil,
               remotes: [%{name: "candide", url: "http://localhost:4001"}],
               auto_poll: false
             ]
           ]},
        restart: :temporary
      },
      Shuttle.RemoteRegistry
    )
  end

  test "409 when the remote's breaker is not tripped" do
    start_registry()

    conn = post(api_conn(), "/api/v1/remotes/candide/reset", "{}")
    assert %{"error" => "not_tripped", "remote" => "candide"} = json_response(conn, 409)
  end

  test "404 for an unconfigured remote" do
    start_registry()

    conn = post(api_conn(), "/api/v1/remotes/nonesuch/reset", "{}")
    assert %{"error" => "unknown_remote"} = json_response(conn, 404)
  end

  test "503 when no RemoteRegistry is running" do
    conn = post(api_conn(), "/api/v1/remotes/candide/reset", "{}")
    assert %{"error" => "registry_unavailable"} = json_response(conn, 503)
  end
end
