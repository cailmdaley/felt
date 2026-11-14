defmodule ShuttleWeb.OutboxController do
  @moduledoc "Durable Outbox dismissals carried by the fleet's board feeds."
  use Phoenix.Controller, formats: [:json]

  alias Shuttle.{Board, CLI, RemoteTemporalRegistry}

  def dismiss(conn, %{"key" => key} = params) when is_binary(key) and key != "" do
    args = ["outbox", "dismiss", key]
    args = if params["fiber"] in [nil, ""], do: args, else: args ++ ["--fiber", params["fiber"]]

    case CLI.run(args) do
      {:ok, _} ->
        json(conn, %{ok: true})

      {:command_error, _status, output} ->
        conn |> put_status(422) |> json(%{error: String.trim(output)})

      {:error, reason} ->
        conn |> put_status(422) |> json(%{error: inspect(reason)})
    end
  end

  def dismiss(conn, _params), do: conn |> put_status(400) |> json(%{error: "key is required"})

  def dismissed(conn, _params) do
    reach = Board.retention_ms()
    since = System.system_time(:millisecond) - reach

    remote =
      RemoteTemporalRegistry.entries_nowait(:board)
      |> Map.values()
      |> Enum.flat_map(& &1.items)
      |> Enum.filter(&is_integer(&1["received_at"]))
      |> Enum.filter(&(&1["received_at"] >= since))

    keys =
      (Board.all_since(since) ++ remote)
      |> Enum.filter(&(&1["kind"] == "dismissed"))
      |> Enum.map(& &1["text"])
      |> Enum.uniq()
      |> Enum.sort()

    json(conn, %{dismissed: keys, reach_ms: reach})
  end
end
