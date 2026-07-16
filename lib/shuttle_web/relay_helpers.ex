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

  alias Shuttle.FeltStores

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
  Relay a byte-bodied forward verbatim, or render a 502 tunnel failure.

  The owning daemon already served the bytes through Phoenix, so `content_type`
  carries its own charset; relaying with a `nil` charset avoids appending a
  SECOND one (`image/png; charset=utf-8; charset=utf-8`), which browsers reject —
  a doubled charset renders a remote-owned image as a broken-image icon. Shared
  by the owner-routing GET endpoints (`/file`, `/astra`, `/sent-files`,
  `/api/v1/fibers/:id`), whose owning daemon returns raw bytes + a content-type.
  """
  def relay_bytes(conn, forward_result)

  def relay_bytes(conn, {:forwarded, status, content_type, body}) do
    conn |> put_resp_content_type(content_type, nil) |> send_resp(status, body)
  end

  def relay_bytes(conn, {:error, {:forward_failed, name, reason}}) do
    conn |> put_status(502) |> json(%{error: "forward to #{name} failed: #{inspect(reason)}"})
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

  @doc """
  Render a local CLI-verb result as `text/plain`, mapping the shared error
  vocabulary the felt-edit / felt-nest / lifecycle local branches produce:

    * `{:ok, output}` → 200 with the output verbatim.
    * `{:error, binary}` → 400 with the message (a validation refusal).
    * `{:command_error, status, output}` → 422 `"<tool> exited <status>: <output>"`.
    * `{:error, :timeout, reason}` → 503 with the reason.

  `tool` labels the 422 line (`"felt"` for the felt CLI, `"shuttle"` for the
  `felt shuttle` verbs). A caller that needs a side effect on success (a document
  refresh) keeps its own 200 branch and routes only the `else` failures here.
  """
  def send_cli_result(conn, tool, result)

  def send_cli_result(conn, _tool, {:ok, output}) do
    conn |> put_resp_content_type("text/plain") |> send_resp(200, output)
  end

  def send_cli_result(conn, _tool, {:error, reason}) when is_binary(reason) do
    conn |> put_resp_content_type("text/plain") |> send_resp(400, reason)
  end

  def send_cli_result(conn, tool, {:command_error, status, output}) do
    conn
    |> put_resp_content_type("text/plain")
    |> send_resp(422, "#{tool} exited #{status}: #{output}")
  end

  def send_cli_result(conn, _tool, {:error, :timeout, reason}) do
    conn |> put_resp_content_type("text/plain") |> send_resp(503, reason)
  end

  @doc """
  Resolve a fiber id to its owning felt store and canonical address, mapping the
  resolution failures to the CLI-result error vocabulary `send_cli_result/3`
  renders. Shared by the felt-edit and felt-nest local branches, whose owning
  writer needs `-C <host>` and the store-relative address.
  """
  @spec host_for_fiber(String.t()) ::
          {:ok, String.t(), String.t()}
          | {:error, String.t()}
          | {:error, :timeout, String.t()}
  def host_for_fiber(fiber_id) do
    case FeltStores.resolve_fiber(fiber_id) do
      {:ok, %{host: host, fiber_id: address}} -> {:ok, host, address}
      {:error, :not_found} -> {:error, "fiber not found: #{fiber_id}"}
      {:error, :timeout} -> {:error, :timeout, "felt timed out resolving #{fiber_id}"}
    end
  end

  @doc "True for a non-empty binary — the required-string guard the controllers share."
  def present?(value), do: is_binary(value) and value != ""
end
