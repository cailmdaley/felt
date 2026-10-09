defmodule ShuttleWeb.ClaimControllerTest do
  use ExUnit.Case, async: true
  import Shuttle.Test.ApiConn
  import Phoenix.ConnTest
  import Plug.Conn

  alias Shuttle.Test.{ForwardStub, StubPostClient}

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

  test "forwards a remote-origin claim to the owning daemon, origin stripped, relaying its response" do
    ForwardStub.stub_forward(
      "candide",
      "http://localhost:4001",
      {:ok, 200,
       Jason.encode!(%{
         "claimed" => true,
         "fiber_id" => "tests/x",
         "tmux_session" => "capture-x"
       })},
      StubPostClient
    )

    conn =
      api_conn()
      |> post(
        "/api/v1/claim",
        Jason.encode!(%{
          fiber_id: "tests/x",
          tmux_session: "capture-x",
          origin: "candide"
        })
      )

    # The owning daemon's response is relayed verbatim (status + JSON body).
    assert conn.status == 200
    assert %{"claimed" => true, "fiber_id" => "tests/x"} = Jason.decode!(conn.resp_body)

    # Forwarded to the owning remote's identical /claim with origin stripped —
    # only the owner can see the tmux session and run the watcher.
    last = StubPostClient.last()
    assert last.url == "http://localhost:4001/api/v1/claim"
    forwarded = Jason.decode!(last.body)
    refute Map.has_key?(forwarded, "origin")
    assert forwarded["fiber_id"] == "tests/x"
    assert forwarded["tmux_session"] == "capture-x"
  end
end
