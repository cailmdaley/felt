defmodule ShuttleWeb.FeltNestController do
  @moduledoc """
  Felt re-parenting (nest / unnest) for kanban cards — the detail modal's
  parent edit, posted directly to Shuttle.

  Owner-routed via `Shuttle.OriginRouter`, same as `/felt-edit`: a local-owned
  card is re-parented here; a remote-owned card's request is forwarded to the
  owning daemon's identical `/felt-nest` over the SSH tunnel (origin stripped),
  and its response is relayed verbatim. `felt nest`/`felt unnest` is the single
  writer, so felt owns the validation (existence, cycle refusal) and surfaces a
  loud non-zero exit.

  `POST /api/v1/felt-nest` body: `{ "fiber_id": "...", "origin": "...",
  "parent": "<parent-id>" | null }`.

    * `parent` string — `felt -C <host> nest <fiber> <parent>`. The parent must
      resolve within the SAME felt host as the fiber; a cross-host re-parent is
      refused with a 400 rather than handed to felt with a dangling id.
    * `parent` null/`""` — `felt -C <host> unnest <fiber>` (promote to
      top-level).

  Responds 200 with felt's plain-text output; the caller derives the fiber's
  new id itself (last path segment re-rooted under the parent).
  """

  use Phoenix.Controller, formats: [:json]
  import ShuttleWeb.RelayHelpers, only: [relay_text: 2]

  alias Shuttle.{Felt, FeltStores, OriginRouter}

  def create(conn, %{"fiber_id" => fiber_id} = params) when is_binary(fiber_id) do
    case OriginRouter.route(Map.get(params, "origin")) do
      {:remote, remote} ->
        relay_text(conn, OriginRouter.forward(remote, "/api/v1/felt-nest", conn.body_params))

      :local ->
        create_local(conn, fiber_id, params)
    end
  end

  def create(conn, _params) do
    conn
    |> put_resp_content_type("text/plain")
    |> send_resp(400, "fiber_id is required")
  end

  defp create_local(conn, fiber_id, params) do
    with {:ok, host, address} <- host_for_fiber(fiber_id),
         {:ok, args} <- args(host, address, Map.fetch(params, "parent")),
         {:ok, output} <- run(host, args) do
      conn
      |> put_resp_content_type("text/plain")
      |> send_resp(200, output)
    else
      {:error, reason} when is_binary(reason) ->
        conn
        |> put_resp_content_type("text/plain")
        |> send_resp(400, reason)

      {:command_error, status, output} ->
        conn
        |> put_resp_content_type("text/plain")
        |> send_resp(422, "felt exited #{status}: #{output}")
    end
  end

  defp host_for_fiber(fiber_id) do
    case FeltStores.resolve_fiber(fiber_id) do
      {:ok, %{host: host, fiber_id: address}} -> {:ok, host, address}
      {:error, :not_found} -> {:error, "fiber not found: #{fiber_id}"}
    end
  end

  # `parent` is required (absent is a caller bug, not a no-op); null or ""
  # means unnest. A string parent must resolve within the same host.
  defp args(_host, _address, :error), do: {:error, "parent is required (null to unnest)"}
  defp args(_host, address, {:ok, nil}), do: {:ok, ["unnest", address]}
  defp args(_host, address, {:ok, ""}), do: {:ok, ["unnest", address]}

  defp args(host, address, {:ok, parent}) when is_binary(parent) do
    case FeltStores.resolve_fiber(parent) do
      {:ok, %{host: ^host, fiber_id: parent_address}} ->
        {:ok, ["nest", address, parent_address]}

      {:ok, %{host: other}} ->
        {:error, "cannot reparent across felt hosts (#{host} → #{other})"}

      {:error, :not_found} ->
        {:error, "parent fiber not found: #{parent}"}
    end
  end

  defp args(_host, _address, {:ok, _}), do: {:error, "parent must be a string or null"}

  defp run(host, args), do: Felt.run(["-C", host] ++ args)
end
