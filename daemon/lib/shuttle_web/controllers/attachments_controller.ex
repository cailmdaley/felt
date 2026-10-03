defmodule ShuttleWeb.AttachmentsController do
  @moduledoc """
  `POST /api/v1/attachments` — store the composer's pasted images on the host
  that owns the fiber, so the directive sent next can name their paths.

  Body: `{"fiber", "origin"?, "attachments": [{"name", "mime", "data",
  "sha256"}]}` with `data` base64. Response: `{"files": [{"name", "path",
  "sha256", "size"}]}` in request order, `path` absolute on the owning host.

  Owner-routed through `Shuttle.OriginRouter` exactly like `/dispatch`: a
  request carrying a remote `origin` is forwarded to that daemon's identical
  path with `origin` stripped and its answer relayed verbatim. Locally the
  fiber must resolve in this host's felt stores (404 otherwise, 504 when felt
  timed out), so a mis-routed request writes nothing. Validation and the write
  itself are `Shuttle.Attachments`; a broken rule is a 400 with an `error`
  string.
  """

  use Phoenix.Controller, formats: [:json]

  import ShuttleWeb.RelayHelpers, only: [relay_json: 3]

  alias Shuttle.{Attachments, FeltStores, OriginRouter}

  # A full batch is ~34 MB of JSON; a slow link needs longer than the
  # write plane's default 30 s to carry it.
  @forward_timeout_ms 120_000

  def create(conn, params) do
    case OriginRouter.route(Map.get(params, "origin")) do
      {:remote, remote} ->
        relay_json(
          conn,
          OriginRouter.forward(remote, "/api/v1/attachments", conn.body_params,
            forward_timeout_ms: @forward_timeout_ms
          ),
          &forward_failed/2
        )

      :local ->
        create_local(conn, params)
    end
  end

  defp create_local(conn, params) do
    with {:ok, fiber} <- fiber_param(params),
         {:ok, resolved} <- resolve(fiber),
         {:ok, files} <- Attachments.store(resolved, Map.get(params, "attachments")) do
      json(conn, %{files: files})
    else
      {:error, status, message} when is_integer(status) ->
        conn |> put_status(status) |> json(%{error: message})

      {:error, :invalid, message} ->
        conn |> put_status(400) |> json(%{error: message})

      {:error, :io, message} ->
        conn |> put_status(500) |> json(%{error: message})
    end
  end

  defp fiber_param(params) do
    case Map.get(params, "fiber") do
      fiber when is_binary(fiber) and fiber != "" -> {:ok, fiber}
      _ -> {:error, 400, "fiber is required"}
    end
  end

  defp resolve(fiber) do
    case FeltStores.resolve_fiber_or_error(fiber) do
      {:ok, resolved} -> {:ok, resolved}
      {:error, :timeout, message} -> {:error, 504, message}
      {:error, message} -> {:error, 404, message}
    end
  end

  defp forward_failed(name, reason),
    do: %{error: "forward to #{name} failed: #{inspect(reason)}", origin: name}
end
