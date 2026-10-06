defmodule ShuttleWeb.CaptureControllerTest do
  use ExUnit.Case, async: true
  import Shuttle.Test.ApiConn
  import Phoenix.ConnTest
  import Plug.Conn

  alias Shuttle.Test.{ForwardStub, StubPostClient}

  @endpoint ShuttleWeb.Endpoint

  test "POST /api/v1/capture without prompt is a 400" do
    conn =
      api_conn()
      |> post("/api/v1/capture", Jason.encode!(%{project_dir: "/tmp"}))

    assert conn.status == 400
    assert Jason.decode!(conn.resp_body)["error"] =~ "prompt"
  end

  test "POST /api/v1/capture rejects a whitespace-only ordinary prompt" do
    conn =
      api_conn()
      |> post(
        "/api/v1/capture",
        Jason.encode!(%{prompt: " \n\t ", project_dir: "/no/such/project"})
      )

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

  test "forwards a remote-origin capture to the owning daemon, origin stripped, relaying its response" do
    ForwardStub.stub_forward(
      "candide",
      "http://localhost:4001",
      {:ok, 200, Jason.encode!(%{"spawned" => true, "tmux_session" => "capture-1"})},
      StubPostClient
    )

    conn =
      api_conn()
      |> post(
        "/api/v1/capture",
        Jason.encode!(%{
          prompt: "an idea",
          project_dir: "/candide/project",
          origin: "candide"
        })
      )

    # The owning daemon's response is relayed verbatim (status + JSON body).
    assert conn.status == 200
    assert %{"spawned" => true, "tmux_session" => "capture-1"} = Jason.decode!(conn.resp_body)

    # Forwarded to the owning remote's identical /capture with origin stripped —
    # the session must spawn where the project lives.
    last = StubPostClient.last()
    assert last.url == "http://localhost:4001/api/v1/capture"
    forwarded = Jason.decode!(last.body)
    refute Map.has_key?(forwarded, "origin")
    assert forwarded["prompt"] == "an idea"
    assert forwarded["project_dir"] == "/candide/project"
  end
end
