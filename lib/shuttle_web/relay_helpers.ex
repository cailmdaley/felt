defmodule ShuttleWeb.RelayHelpers do
  @moduledoc """
  Shared response helpers for the owner-routing controllers.

  Every write endpoint behind `Shuttle.OriginRouter` relays the owning daemon's
  verbatim response on a forward, and surfaces a tunnel failure as a 502. The
  forwarded leg is identical across endpoints; the failure body differs per
  endpoint (the `*: false` envelope key it echoes), so the JSON helper takes the
  failure body as a builder.

  Import into a controller: `import ShuttleWeb.RelayHelpers`.
  """

  import Plug.Conn
  import Phoenix.Controller, only: [json: 2]

  @doc """
  Relay a JSON-bodied forward verbatim, or render a 502 tunnel failure.

  The forwarded body is already JSON the owning daemon produced, so it is sent
  as-is. On a forward failure, `on_failure.(name, reason)` builds the JSON map
  the endpoint surfaces (its `*: false` envelope plus `origin`/`error`).
  """
  def relay_json(conn, forward_result, on_failure)

  def relay_json(conn, {:forwarded, status, body}, _on_failure) do
    conn |> put_resp_content_type("application/json") |> send_resp(status, body)
  end

  def relay_json(conn, {:error, {:forward_failed, name, reason}}, on_failure) do
    conn |> put_status(502) |> json(on_failure.(name, reason))
  end

  @doc """
  Relay a plain-text forward verbatim, or render a 502 tunnel failure.

  Identical across the felt-edit / felt-nest / lifecycle endpoints, whose
  owning daemon returns `text/plain`.
  """
  def relay_text(conn, forward_result)

  def relay_text(conn, {:forwarded, status, body}) do
    conn |> put_resp_content_type("text/plain") |> send_resp(status, body)
  end

  def relay_text(conn, {:error, {:forward_failed, name, reason}}) do
    conn
    |> put_resp_content_type("text/plain")
    |> send_resp(502, "forward to #{name} failed: #{inspect(reason)}")
  end

  @doc "True for a non-empty binary — the required-string guard the controllers share."
  def present?(value), do: is_binary(value) and value != ""
end
