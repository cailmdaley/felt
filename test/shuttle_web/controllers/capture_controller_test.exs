defmodule ShuttleWeb.CaptureControllerTest do
  use ExUnit.Case
  import Phoenix.ConnTest
  import Plug.Conn

  @endpoint ShuttleWeb.Endpoint

  test "POST /api/v1/capture without prompt is a 400" do
    conn =
      api_conn()
      |> post("/api/v1/capture", Jason.encode!(%{project_dir: "/tmp"}))

    assert conn.status == 400
    assert Jason.decode!(conn.resp_body)["error"] =~ "prompt"
  end

  test "POST /api/v1/capture without project_dir is a 400" do
    conn =
      api_conn()
      |> post("/api/v1/capture", Jason.encode!(%{prompt: "an idea"}))

    assert conn.status == 400
    assert Jason.decode!(conn.resp_body)["error"] =~ "project_dir"
  end

  test "POST /api/v1/capture with a missing project_dir is a 422" do
    conn =
      api_conn()
      |> post(
        "/api/v1/capture",
        Jason.encode!(%{prompt: "an idea", project_dir: "/no/such/dir/portolan"})
      )

    assert conn.status == 422
    assert Jason.decode!(conn.resp_body)["reason"] == "project_dir_missing"
  end

  # Axes constraint rejection (effort outside effort_levels, chrome on a
  # non-claude harness) is covered at the Dispatcher layer
  # (dispatcher_test.exs "capture rejects axes outside the agent's
  # constraints"); the controller maps any string reason to a 422.

  defp api_conn do
    build_conn() |> put_req_header("content-type", "application/json")
  end
end
