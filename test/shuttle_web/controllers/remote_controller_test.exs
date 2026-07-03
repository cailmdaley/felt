defmodule ShuttleWeb.RemoteControllerTest do
  @moduledoc """
  Wiring for `POST /api/v1/remotes/:name/reset`. The breaker behavior itself
  (trip after N cascades, one reset buys one cascade, auto-heal) is covered at
  the registry layer (`RemoteRegistryTest` "circuit breaker"); here we pin the
  HTTP contract: reset reaches the globally named RemoteRegistry and maps its
  returns onto statuses — 409 for a breaker that isn't tripped, 404 for an
  unconfigured remote, 503 when no registry runs.
  """
  use ExUnit.Case
  import Plug.Conn
  import Phoenix.ConnTest

  @endpoint ShuttleWeb.Endpoint

  # The endpoint calls the globally named Shuttle.RemoteRegistry (test env
  # sets start_remote_registry: false, so the name is ours to claim).
  # auto_poll: false keeps the registry inert — no HTTP client is ever hit.
  defp start_registry do
    start_supervised!(%{
      id: make_ref(),
      start:
        {Shuttle.RemoteRegistry, :start_link,
         [
           [
             name: Shuttle.RemoteRegistry,
             remotes: [%{name: "candide", url: "http://localhost:4001"}],
             auto_poll: false
           ]
         ]},
      restart: :temporary
    })
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

  defp api_conn do
    build_conn()
    |> put_req_header("content-type", "application/json")
    |> put_req_header("accept", "application/json")
  end
end
