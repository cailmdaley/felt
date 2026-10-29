defmodule ShuttleWeb.BoardController do
  @moduledoc "Host-local board feed."
  use Phoenix.Controller, formats: [:json]

  import ShuttleWeb.RelayHelpers,
    only: [integer_param: 3, json_with_validator: 3, bad_param: 2]

  alias Shuttle.{Board, BoardFamily, Poller, RemoteTemporalRegistry}

  def family(conn, params) do
    now = System.system_time(:millisecond)
    all? = params["all"] == "true"
    default = now - if(all?, do: 6, else: 24) * 3_600_000

    cond do
      not all? and params["fiber"] in [nil, ""] and params["session"] in [nil, ""] ->
        conn |> put_status(400) |> json(%{error: "fiber or session is required"})

      true ->
        with {:ok, since_ms} <- integer_param(params, "since_ms", default: default),
             {:ok, {entries, _, _}} <- thread_inputs() do
          since_ms = max(since_ms, now - 14 * 86_400_000)

          remote =
            RemoteTemporalRegistry.entries(:board) |> Map.values() |> Enum.flat_map(& &1.items)

          records =
            (Board.all_since(since_ms) ++ remote)
            |> Enum.filter(fn
              %{"timestamp" => timestamp} when is_integer(timestamp) -> timestamp >= since_ms
              _ -> false
            end)

          host = Poller.own_host_id()
          sessions = BoardFamily.session_index(entries, host)
          json(conn, BoardFamily.compose(entries, records, sessions, host, params))
        else
          {:error, {:bad_param, key}} -> bad_param(conn, key)
          {:error, reason} -> conn |> put_status(503) |> json(%{error: reason})
        end
    end
  end

  defp thread_inputs do
    Poller.thread_inputs()
  catch
    :exit, _ -> {:error, :poller_unavailable}
  end

  def show(conn, params) do
    with {:ok, since_ms} <- integer_param(params, "since_ms", default: 0) do
      records = Board.all_since(since_ms)
      json_with_validator(conn, {since_ms, records}, fn -> %{records: records} end)
    else
      {:error, {:bad_param, key}} -> bad_param(conn, key)
    end
  end
end
