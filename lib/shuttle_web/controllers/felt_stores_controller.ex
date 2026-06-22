defmodule ShuttleWeb.FeltStoresController do
  @moduledoc """
  Agent-API endpoint: POST /api/v1/felt-stores

  Persists Shuttle's registered felt-store list. An empty list clears the
  persisted file so the daemon falls back to its default single-host setup.

  Request body: %{"felt_stores" => [string]}

  Returns:
    200  %{ok: true, felt_stores: [string], persisted_at: iso8601}
    400  %{error: string}
    500  %{error: string}
  """

  use Phoenix.Controller, formats: [:json]

  def create(conn, %{"felt_stores" => hosts}) when is_list(hosts) do
    case Shuttle.FeltStores.save(hosts) do
      {:ok, normalized} ->
        json(conn, %{
          ok: true,
          felt_stores: normalized,
          persisted_at: DateTime.to_iso8601(DateTime.utc_now())
        })

      {:error, reason} ->
        conn
        |> put_status(500)
        |> json(%{error: "failed to persist felt stores: #{format_error(reason)}"})
    end
  end

  def create(conn, _params) do
    conn
    |> put_status(400)
    |> json(%{error: "felt_stores must be an array of host paths"})
  end

  defp format_error(%{message: message}) when is_binary(message), do: message

  defp format_error({:file_error, reason}),
    do: :file.format_error(reason) |> IO.iodata_to_binary()

  defp format_error(reason), do: inspect(reason)
end
