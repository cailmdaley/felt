defmodule Shuttle.Board do
  @moduledoc "The retained host-local family-board records in the event stream."

  alias Shuttle.EventStream

  @retention_ms 14 * 24 * 60 * 60 * 1_000

  @doc "How far back the board reaches: its records, and the thread marks it serves."
  def retention_ms, do: @retention_ms

  @doc "Fold a valid board record by its fleet-wide identity."
  def fold(records, %{"type" => "board", "id" => id, "timestamp" => ts} = record)
      when is_binary(id) and id != "" and is_integer(ts),
      do: Map.put(records, id, record)

  def fold(records, _event), do: records

  @doc "Discard records outside the retained window."
  def prune(records, now),
    do: Map.reject(records, fn {_id, record} -> record["timestamp"] < now - @retention_ms end)

  @doc "Records at or after a timestamp, oldest first."
  def since(records, since_ms) when is_map(records) do
    records
    |> Map.values()
    |> Enum.filter(&(&1["timestamp"] >= since_ms))
    |> Enum.sort_by(&{&1["timestamp"], &1["id"]})
  end

  @doc "Read the local projection after catching up with the stream."
  def all_since(since_ms, stream \\ EventStream),
    do: stream |> EventStream.board_records() |> since(since_ms)
end
