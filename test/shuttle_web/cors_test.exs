defmodule ShuttleWeb.CORSTest do
  @moduledoc """
  Tests that the Shuttle HTTP API serves CORS headers so the portolan kanban
  (running on localhost:3000 or the Vite dev server on localhost:5173) can POST
  to the daemon (127.0.0.1:4000) directly from the browser.

  Covers:
  - OPTIONS preflight returns 204 + correct Access-Control-* headers.
  - Actual GET/POST requests from an allowed origin carry CORS headers.
  - Requests from non-allowed origins pass through without CORS headers.
  - Non-credentialed requests (no Origin header) are unaffected.
  """

  use ExUnit.Case
  import Plug.Conn
  import Phoenix.ConnTest

  @endpoint ShuttleWeb.Endpoint

  # ── Preflight (OPTIONS) ──────────────────────────────────────────────────────

  test "OPTIONS /api/v1/dispatch from allowed origin returns 204 + CORS headers" do
    conn =
      build_conn()
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
      build_conn()
      |> put_req_header("origin", "http://localhost:5173")
      |> put_req_header("access-control-request-method", "GET")
      |> options("/api/v1/agents")

    assert conn.status == 204
    assert get_resp_header(conn, "access-control-allow-origin") == ["http://localhost:5173"]
  end

  test "OPTIONS preflight from 127.0.0.1:3000 is also accepted" do
    conn =
      build_conn()
      |> put_req_header("origin", "http://127.0.0.1:3000")
      |> put_req_header("access-control-request-method", "POST")
      |> options("/api/v1/dispatch")

    assert conn.status == 204
    assert get_resp_header(conn, "access-control-allow-origin") == ["http://127.0.0.1:3000"]
  end

  test "OPTIONS preflight from disallowed origin returns no CORS headers" do
    conn =
      build_conn()
      |> put_req_header("origin", "https://evil.example.com")
      |> put_req_header("access-control-request-method", "POST")
      |> options("/api/v1/dispatch")

    # Plug halts with 204 for all OPTIONS, but no CORS header for unknown origins.
    assert get_resp_header(conn, "access-control-allow-origin") == []
  end

  # ── Actual requests ──────────────────────────────────────────────────────────

  test "GET /api/v1/agents from allowed origin carries CORS response header" do
    conn =
      build_conn()
      |> put_req_header("origin", "http://localhost:3000")
      |> put_req_header("accept", "application/json")
      |> get("/api/v1/agents")

    assert conn.status == 200
    assert get_resp_header(conn, "access-control-allow-origin") == ["http://localhost:3000"]
  end

  test "Vary: Origin header is set on responses with CORS headers" do
    conn =
      build_conn()
      |> put_req_header("origin", "http://localhost:3000")
      |> put_req_header("accept", "application/json")
      |> get("/api/v1/agents")

    assert get_resp_header(conn, "vary") == ["Origin"]
  end

  test "request without Origin header is unaffected (no CORS header added)" do
    conn =
      build_conn()
      |> put_req_header("accept", "application/json")
      |> get("/api/v1/agents")

    assert conn.status == 200
    assert get_resp_header(conn, "access-control-allow-origin") == []
  end

  test "request from disallowed origin carries no CORS response header" do
    conn =
      build_conn()
      |> put_req_header("origin", "https://evil.example.com")
      |> put_req_header("accept", "application/json")
      |> get("/api/v1/agents")

    assert conn.status == 200
    assert get_resp_header(conn, "access-control-allow-origin") == []
  end
end
