defmodule ShuttleWeb.CORSTest do
  @moduledoc """
  Tests that the Shuttle HTTP API serves CORS headers so the board UI dev
  server (Vite on localhost:5173, or the legacy localhost:3000 fallback) can
  POST to the daemon (127.0.0.1:4000) directly from the browser.

  Covers:
  - OPTIONS preflight returns 204 + correct Access-Control-* headers.
  - Actual GET/POST requests from an allowed origin carry CORS headers.
  - Requests from non-allowed origins pass through without CORS headers for safe
    reads, while unsafe browser writes are rejected before routing.
  - Non-credentialed requests (no Origin header) are unaffected.
  """

  use ExUnit.Case
  import Plug.Conn
  import Phoenix.ConnTest

  @endpoint ShuttleWeb.Endpoint

  defp local_conn(method \\ :get, path \\ "/", body \\ nil) do
    %{Phoenix.ConnTest.build_conn(method, path, body) | host: "127.0.0.1", port: 4000}
  end

  # ── Preflight (OPTIONS) ──────────────────────────────────────────────────────

  test "OPTIONS /api/v1/dispatch from allowed origin returns 204 + CORS headers" do
    conn =
      local_conn()
      |> put_req_header("origin", "http://localhost:3000")
      |> put_req_header("access-control-request-method", "POST")
      |> put_req_header("access-control-request-headers", "content-type")
      |> options("/api/v1/dispatch")

    assert conn.status == 204
    assert get_resp_header(conn, "access-control-allow-origin") == ["http://localhost:3000"]
    assert get_resp_header(conn, "access-control-allow-methods") != []
    assert get_resp_header(conn, "access-control-allow-headers") != []
  end

  test "OPTIONS /api/v1/agents from Vite dev origin (port 5173) returns 204 + CORS headers" do
    conn =
      local_conn()
      |> put_req_header("origin", "http://localhost:5173")
      |> put_req_header("access-control-request-method", "GET")
      |> options("/api/v1/agents")

    assert conn.status == 204
    assert get_resp_header(conn, "access-control-allow-origin") == ["http://localhost:5173"]
  end

  test "OPTIONS preflight from 127.0.0.1:3000 is also accepted" do
    conn =
      local_conn()
      |> put_req_header("origin", "http://127.0.0.1:3000")
      |> put_req_header("access-control-request-method", "POST")
      |> options("/api/v1/dispatch")

    assert conn.status == 204
    assert get_resp_header(conn, "access-control-allow-origin") == ["http://127.0.0.1:3000"]
  end

  test "OPTIONS preflight from disallowed origin returns no CORS headers" do
    conn =
      local_conn()
      |> put_req_header("origin", "https://evil.example.com")
      |> put_req_header("access-control-request-method", "POST")
      |> options("/api/v1/dispatch")

    # Plug halts with 204 for all OPTIONS, but no CORS header for unknown origins.
    assert get_resp_header(conn, "access-control-allow-origin") == []
  end

  # ── Actual requests ──────────────────────────────────────────────────────────

  test "GET /api/v1/agents from allowed origin carries CORS response header" do
    conn =
      local_conn()
      |> put_req_header("origin", "http://localhost:3000")
      |> put_req_header("accept", "application/json")
      |> get("/api/v1/agents")

    assert conn.status == 200
    assert get_resp_header(conn, "access-control-allow-origin") == ["http://localhost:3000"]
  end

  test "Vary: Origin header is set on responses with CORS headers" do
    conn =
      local_conn()
      |> put_req_header("origin", "http://localhost:3000")
      |> put_req_header("accept", "application/json")
      |> get("/api/v1/agents")

    assert get_resp_header(conn, "vary") == ["Origin"]
  end

  test "request without Origin header is unaffected (no CORS header added)" do
    conn =
      local_conn()
      |> put_req_header("accept", "application/json")
      |> get("/api/v1/agents")

    assert conn.status == 200
    assert get_resp_header(conn, "access-control-allow-origin") == []
  end

  test "request from disallowed origin carries no CORS response header" do
    conn =
      local_conn()
      |> put_req_header("origin", "https://evil.example.com")
      |> put_req_header("accept", "application/json")
      |> get("/api/v1/agents")

    assert conn.status == 200
    assert get_resp_header(conn, "access-control-allow-origin") == []
  end

  test "a simple cross-origin POST is rejected before it reaches a controller" do
    conn =
      local_conn(:post, "/api/v1/felt-edit", %{})
      |> put_req_header("origin", "https://evil.example.com")
      |> ShuttleWeb.CORSPlug.call([])

    assert conn.status == 403
    assert conn.resp_body == "origin not allowed"
    assert conn.halted
  end

  test "the endpoint rejects a simple cross-origin POST before the controller runs" do
    conn =
      local_conn()
      |> put_req_header("origin", "https://evil.example.com")
      |> put_req_header("content-type", "application/x-www-form-urlencoded")
      |> post("/api/v1/felt-edit", "fiber_id=missing")

    assert conn.status == 403
    assert conn.resp_body == "origin not allowed"
  end

  test "same-origin POST is allowed through a direct local listener" do
    conn = local_conn(:post, "/api/v1/felt-edit", %{})

    conn =
      conn
      |> put_req_header("origin", "http://127.0.0.1:4000")
      |> ShuttleWeb.CORSPlug.call([])

    refute conn.halted
    assert conn.status == nil
  end

  test "a direct listener does not trust an arbitrary same-origin host" do
    conn = %{local_conn(:post, "/api/v1/felt-edit", %{}) | host: "evil.example.com", port: 80}

    conn =
      conn
      |> put_req_header("origin", "http://evil.example.com")
      |> ShuttleWeb.CORSPlug.call([])

    assert conn.status == 403
    assert conn.resp_body == "origin not allowed"
  end

  test "malformed Origin is rejected without crashing the plug" do
    conn =
      local_conn(:post, "/api/v1/felt-edit", %{})
      |> put_req_header("origin", "http:")
      |> ShuttleWeb.CORSPlug.call([])

    assert conn.status == 403
    assert conn.resp_body == "origin not allowed"
  end

  test "same-origin POST is allowed through an HTTPS reverse proxy" do
    conn =
      local_conn(:post, "/api/v1/felt-edit", %{})
      |> put_req_header("x-forwarded-host", "shuttle.example.ts.net")
      |> put_req_header("x-forwarded-proto", "https")
      |> put_req_header("origin", "https://shuttle.example.ts.net")
      |> ShuttleWeb.CORSPlug.call([])

    refute conn.halted
    assert conn.status == nil
  end

  test "a public forwarded host requires the forwarded scheme too" do
    conn =
      local_conn(:post, "/api/v1/felt-edit", %{})
      |> put_req_header("x-forwarded-host", "shuttle.example.ts.net")
      |> put_req_header("origin", "https://shuttle.example.ts.net")
      |> ShuttleWeb.CORSPlug.call([])

    assert conn.status == 403
    assert conn.resp_body == "origin not allowed"
  end

  test "malformed forwarded authority is rejected without crashing the plug" do
    conn =
      local_conn(:get, "/api/v1/agents", nil)
      |> put_req_header("x-forwarded-host", "%")
      |> put_req_header("x-forwarded-proto", "https")
      |> put_req_header("origin", "https://evil.example.com")
      |> ShuttleWeb.CORSPlug.call([])

    assert conn.status == 403
    assert conn.resp_body == "origin not allowed"
  end

  test "an unsupported forwarded scheme cannot authorize a public host" do
    conn =
      local_conn(:get, "/api/v1/agents", nil)
      |> put_req_header("x-forwarded-host", "shuttle.example.ts.net")
      |> put_req_header("x-forwarded-proto", "gopher")
      |> put_req_header("origin", "https://shuttle.example.ts.net")
      |> ShuttleWeb.CORSPlug.call([])

    assert conn.status == 403
    assert conn.resp_body == "origin not allowed"
  end

  test "owner-forwarded POST without Origin remains allowed" do
    conn =
      local_conn(:post, "/api/v1/felt-edit", %{})
      |> ShuttleWeb.CORSPlug.call([])

    refute conn.halted
    assert conn.status == nil
  end

  test "a disallowed-origin GET remains readable but carries no CORS header" do
    conn =
      local_conn(:get, "/api/v1/agents", nil)
      |> put_req_header("origin", "https://evil.example.com")
      |> ShuttleWeb.CORSPlug.call([])

    refute conn.halted
    assert get_resp_header(conn, "access-control-allow-origin") == []
  end

  test "a no-Origin request with an arbitrary direct Host is rejected" do
    conn =
      %{local_conn() | host: "evil.example.com", port: 80}
      |> get("/api/v1/agents")

    assert conn.status == 403
    assert conn.resp_body == "origin not allowed"
  end
end
