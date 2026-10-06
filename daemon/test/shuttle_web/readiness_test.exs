defmodule ShuttleWeb.ReadinessTest do
  # sync: Shuttle.Readiness keeps boot state in :persistent_term, which gates
  # every state-dependent route for every ConnTest module.
  use ExUnit.Case, async: false

  import Phoenix.ConnTest
  import Shuttle.Test.ApiConn
  import Plug.Conn

  alias Shuttle.Readiness

  @endpoint ShuttleWeb.Endpoint

  setup do
    Readiness.begin_boot()

    on_exit(fn ->
      Readiness.begin_boot()
      Readiness.mark_ready()
    end)

    :ok
  end

  test "state-dependent routes fail fast with JSON 503 and no Retry-After" do
    conn = get(api_conn(), "/api/v1/state")

    assert conn.status == 503
    assert %{"error" => "booting", "ready" => false} = Jason.decode!(conn.resp_body)
    assert get_resp_header(conn, "content-type") |> List.first() =~ "application/json"
    assert get_resp_header(conn, "retry-after") == []
  end

  test "dispatch cannot reach the Poller while application boot is incomplete" do
    conn = post(api_conn(), "/api/v1/dispatch", Jason.encode!(%{"fiber_id" => "work/not-ready"}))

    assert conn.status == 503
    assert %{"error" => "booting", "ready" => false} = Jason.decode!(conn.resp_body)
    assert get_resp_header(conn, "retry-after") == []
  end

  test "version remains a prompt liveness probe and reports readiness" do
    conn = get(api_conn(), "/api/v1/version")

    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)
    assert body["ready"] == false
    assert body["contract"]["reason"] == "booting"
  end

  test "version reports ready true once Application.start completes" do
    Readiness.mark_ready()

    conn = get(api_conn(), "/api/v1/version")

    assert conn.status == 200
    assert Jason.decode!(conn.resp_body)["ready"] == true
  end

  test "message-with-files POST can validate while the application is booting" do
    conn = post(api_conn(), "/api/v1/messages/files", Jason.encode!(%{}))
    assert conn.status == 400
  end

  test "direct message POST can validate while the Poller is booting" do
    conn =
      api_conn()
      |> post("/api/v1/messages", Jason.encode!(%{}))

    assert conn.status == 400
    assert %{"error" => _} = Jason.decode!(conn.resp_body)
  end

  test "board shell, message files, HEAD version and session discovery remain available" do
    for {method, path} <- [
          {:get, "/"},
          {:head, "/api/v1/version"},
          {:post, "/api/v1/messages/files"},
          {:get, "/api/v1/peers"},
          {:get, "/api/v1/sessions"}
        ] do
      conn = Plug.Test.conn(method, path) |> ShuttleWeb.ReadinessPlug.call([])
      refute conn.halted
      assert conn.status == nil
    end

    # The board shell loads while state-dependent API routes are gated.
    shell = get(api_conn(), "/")
    refute shell.status == 503
    refute shell.resp_body =~ "\"error\":\"booting\""

    # HEAD follows GET's version exemption and keeps the response body empty.
    head = head(api_conn(), "/api/v1/version")
    assert head.status == 200
    assert head.resp_body in [nil, ""]

    # The durable ledger is independent of Poller state and remains readable.
    conn = get(api_conn(), "/api/v1/sessions")
    assert conn.status == 200
  end

  test "CORS headers are preserved on a booting 503" do
    conn =
      api_conn()
      |> put_req_header("origin", "http://localhost:5173")
      |> get("/api/v1/state")

    assert conn.status == 503
    assert get_resp_header(conn, "access-control-allow-origin") == ["http://localhost:5173"]
  end
end
