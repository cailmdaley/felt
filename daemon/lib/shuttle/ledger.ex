defmodule Shuttle.Ledger do
  @moduledoc """
  The shared read path for the daemon's host-local JSONL ledgers.

  `sessions.jsonl` and `commits.jsonl` are the same file shape read the same
  way: the rotated sibling then the live file (so a window reaching back past a
  rotation is whole), tolerant per-line parsing, sorted by `at`. A malformed
  line is skipped, never raised; a file that vanishes mid-read (a rotation
  racing the read) yields what the other file gave us.
  """

  require Logger

  @rotated_suffix ".1"

  @doc """
  Every record whose integer `at` falls in the inclusive window, oldest first.

  A `nil` `until_ms` is open-ended. `require_key`, when given, additionally
  drops records whose value at that key is not a non-empty binary — the join
  key every reader dedupes on, so a row without one is a row every caller would
  have to filter. `label` names the ledger in the skipped-file debug line.
  """
  @spec read_window(String.t(), integer(), integer() | nil, String.t() | nil, String.t()) :: [
          map()
        ]
  def read_window(path, since_ms, until_ms, require_key, label) do
    [path <> @rotated_suffix, path]
    |> Enum.filter(&File.regular?/1)
    |> Enum.flat_map(&stream_records(&1, since_ms, until_ms, require_key, label))
    |> Enum.sort_by(& &1["at"])
  end

  defp stream_records(path, since_ms, until_ms, require_key, label) do
    path
    |> File.stream!()
    |> Stream.flat_map(&parse_line(&1, since_ms, until_ms, require_key))
    |> Enum.to_list()
  rescue
    # Vanished or unreadable between the check and the stream — a rotation
    # racing this read. Serve what the other file gave us.
    error ->
      Logger.debug("#{label}: skipped #{path} — #{Exception.message(error)}")
      []
  end

  defp parse_line(line, since_ms, until_ms, require_key) do
    case Jason.decode(line) do
      {:ok, %{"at" => at} = record} when is_integer(at) ->
        if at >= since_ms and (is_nil(until_ms) or at <= until_ms) and
             required?(record, require_key),
           do: [record],
           else: []

      _ ->
        []
    end
  end

  defp required?(_record, nil), do: true

  defp required?(record, key) do
    case Map.get(record, key) do
      value when is_binary(value) and value != "" -> true
      _ -> false
    end
  end
end
