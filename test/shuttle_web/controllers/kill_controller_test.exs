defmodule ShuttleWeb.KillControllerTest do
  @moduledoc """
  Wiring for `POST /api/v1/kill`. The kill behavior (SIGKILL + synchronous
  runtime teardown, idempotent no-session, no status write) is covered at the
  Poller layer (`PollerTest` "kill_session …"), and the owner-routing is the
  shared `Shuttle.OriginRouter` exercised by the felt-edit/transition controller
  tests. The local-branch happy path needs a running `Shuttle.Poller` GenServer,
  which ExUnit controller tests don't boot, so here we pin only the request
  contract guard.
  """
  use ExUnit.Case
  import Plug.Conn
  import Phoenix.ConnTest

  @endpoint ShuttleWeb.Endpoint

  test "400 when fiber_id is missing" do
    conn = post(api_conn(), "/api/v1/kill", Jason.encode!(%{"origin" => "local"}))
    assert conn.status == 400
    assert %{"error" => _} = json_response(conn, 400)
  end

  defp api_conn do
    build_conn()
    |> put_req_header("content-type", "application/json")
    |> put_req_header("accept", "application/json")
  end
end
