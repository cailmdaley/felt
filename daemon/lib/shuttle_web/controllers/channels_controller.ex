defmodule ShuttleWeb.ChannelsController do
  @moduledoc "Durable channel dismissals, pins and order for the human's Channels view, carried by the fleet's board feeds."
  use Phoenix.Controller, formats: [:json]

  alias Shuttle.{Board, CLI, RemoteTemporalRegistry}

  def dismiss(conn, params), do: write(conn, "dismiss", params)
  def pin(conn, params), do: write(conn, "pin", params)

  def order(conn, params) do
    case params["keys"] do
      [_ | _] = keys ->
        if Enum.all?(keys, &(is_binary(&1) and &1 != "")),
          do: run(conn, ["channels", "order" | keys]),
          else: conn |> put_status(400) |> json(%{error: "keys must be channel keys"})

      _ ->
        conn |> put_status(400) |> json(%{error: "keys are required"})
    end
  end

  defp write(conn, verb, %{"key" => key} = params) when is_binary(key) and key != "" do
    args = ["channels", verb, key]
    args = if params["fiber"] in [nil, ""], do: args, else: args ++ ["--fiber", params["fiber"]]
    run(conn, args)
  end

  defp write(conn, _verb, _params),
    do: conn |> put_status(400) |> json(%{error: "key is required"})

  defp run(conn, args) do
    case CLI.run(args) do
      {:ok, _} ->
        json(conn, %{ok: true})

      {:command_error, _status, output} ->
        conn |> put_status(422) |> json(%{error: String.trim(output)})

      {:error, reason} ->
        conn |> put_status(422) |> json(%{error: inspect(reason)})
    end
  end

  def dismissed(conn, _params) do
    reach = Board.retention_ms()
    since = System.system_time(:millisecond) - reach

    remote =
      RemoteTemporalRegistry.entries_nowait(:board)
      |> Map.values()
      |> Enum.flat_map(& &1.items)
      |> Enum.filter(&is_integer(&1["received_at"]))
      |> Enum.filter(&(&1["received_at"] >= since))

    records = Board.all_since(since) ++ remote

    keys =
      records
      |> Enum.filter(&(&1["kind"] == "dismissed"))
      |> Enum.map(& &1["text"])
      |> Enum.uniq()
      |> Enum.sort()

    # Each pinned channel with its latest pin: a pin lapses once that leaves the reach.
    pinned =
      records
      |> Enum.filter(
        &(&1["kind"] == "pinned" and is_binary(&1["text"]) and is_integer(&1["timestamp"]))
      )
      |> Enum.reduce(%{}, fn record, acc ->
        Map.update(acc, record["text"], record["timestamp"], &max(&1, record["timestamp"]))
      end)

    # The newest order wins, wherever it was written.
    order =
      records
      |> Enum.filter(
        &(&1["kind"] == "ordered" and is_list(&1["keys"]) and is_integer(&1["timestamp"]))
      )
      |> Enum.max_by(& &1["timestamp"], fn -> nil end)

    json(conn, %{
      dismissed: keys,
      pinned: pinned,
      order: order && %{keys: order["keys"], at: order["timestamp"]},
      reach_ms: reach
    })
  end
end
