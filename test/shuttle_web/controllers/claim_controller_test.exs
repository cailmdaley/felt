defmodule ShuttleWeb.ClaimControllerTest do
  use ExUnit.Case
  import Phoenix.ConnTest
  import Plug.Conn

  @endpoint ShuttleWeb.Endpoint

  test "POST /api/v1/claim without fiber_id is a 400" do
    conn =
      api_conn()
      |> post("/api/v1/claim", Jason.encode!(%{tmux_session: "capture-x"}))

    assert conn.status == 400
    assert Jason.decode!(conn.resp_body)["error"] =~ "fiber_id"
  end

  test "POST /api/v1/claim without tmux_session is a 400" do
    conn =
      api_conn()
      |> post("/api/v1/claim", Jason.encode!(%{fiber_id: "tests/x"}))

    assert conn.status == 400
    assert Jason.decode!(conn.resp_body)["error"] =~ "tmux_session"
  end

  defp api_conn do
    build_conn() |> put_req_header("content-type", "application/json")
  end
end
