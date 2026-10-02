defmodule ShuttleWeb.ReadinessPlug do
  @moduledoc """
  Fail fast on API routes whose state is not safe to serve until boot completes.

  The board shell and `/phone` redirect remain available before Poller
  initialization, as do version, direct text/file message delivery, peer
  discovery and the append-only local session ledger. Plug.Static runs before
  this gate, so its assets also load. The booting response intentionally has no
  Retry-After header: HTTP clients such as OTP :httpc may replay POST requests
  when that header accompanies 503.
  """

  @behaviour Plug

  import Plug.Conn

  @available_during_boot [
    {"GET", "/"},
    {"GET", "/phone"},
    {"GET", "/api/v1/version"},
    {"HEAD", "/api/v1/version"},
    {"POST", "/api/v1/messages"},
    {"POST", "/api/v1/messages/files"},
    {"GET", "/api/v1/peers"},
    {"GET", "/api/v1/sessions"}
  ]

  @impl true
  def init(opts), do: opts

  @impl true
  def call(conn, _opts) do
    readiness = Shuttle.Readiness.status()

    if readiness.ready or request_available_during_boot?(conn) do
      conn
    else
      conn
      |> put_resp_content_type("application/json")
      |> send_resp(
        :service_unavailable,
        Jason.encode!(%{
          error: "booting",
          ready: false,
          pending: readiness.pending,
          elapsed_ms: readiness.duration_ms
        })
      )
      |> halt()
    end
  end

  defp request_available_during_boot?(conn),
    do: {conn.method, conn.request_path} in @available_during_boot
end
