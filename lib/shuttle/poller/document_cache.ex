defmodule Shuttle.Poller.DocumentCache do
  @moduledoc """
  The poll-cycle document cache for `Shuttle.Poller`.

  Extracted from the poller as the most self-contained cluster: it owns how the
  fiber-document feed is rebuilt each tick (`refresh/3`), how an entry is keyed
  (`cache_key/1`, uid when present else id), whether a prior entry can be reused
  without re-shelling felt (`reusable_entry?/2`, mtime-equality), and how a single
  entry is read on a miss (`fetch_entry/4`).

  The cache itself — `document_cache`, `document_cache_stats`,
  `document_cache_ready` — lives on `Shuttle.Poller.State`; the GenServer owns
  state. These functions take the poller state and return plain values (the new
  cache + stats), mirroring the original private helpers. felt shell-out stays in
  the poller and is injected as `run_felt` so this module imports no felt internals.
  """

  require Logger

  alias Shuttle.FiberDocuments

  @doc """
  Rebuild the document cache from `candidates`, reusing unchanged entries by
  mtime and re-reading the rest via `run_felt`. Returns `{cache, stats}` where
  `stats` carries hits/misses/evictions/entries.

  `run_felt` is the poller's `run_felt/3` closure, `fn store, args -> ... end`,
  threading the poller's runner so felt shell-out stays owned by the poller.
  """
  def refresh(state, candidates, host_map, run_felt) when is_function(run_felt, 2) do
    previous = state.document_cache

    {cache, stats} =
      Enum.reduce(candidates, {%{}, %{hits: 0, misses: 0}}, fn candidate, {cache_acc, stats} ->
        key = cache_key(candidate)
        modified_at = Map.get(candidate, "modified_at")
        cached = Map.get(previous, key)

        if reusable_entry?(cached, modified_at) do
          {Map.put(cache_acc, key, cached), Map.update!(stats, :hits, &(&1 + 1))}
        else
          case fetch_entry(candidate, host_map, run_felt) do
            {:ok, entry} ->
              cached = %{modified_at: modified_at, entry: entry}
              {Map.put(cache_acc, key, cached), Map.update!(stats, :misses, &(&1 + 1))}

            {:error, reason} ->
              Logger.warning(
                "document cache refresh skipped #{Map.get(candidate, "id", "(unknown)")}: #{inspect(reason)}"
              )

              if cached do
                {Map.put(cache_acc, key, cached), Map.update!(stats, :hits, &(&1 + 1))}
              else
                {cache_acc, Map.update!(stats, :misses, &(&1 + 1))}
              end
          end
        end
      end)

    stats =
      stats
      |> Map.put(:evictions, max(map_size(previous) - map_size(cache), 0))
      |> Map.put(:entries, map_size(cache))

    {cache, stats}
  end

  @doc "Cache key for a candidate/fiber: its uid when present, else its id."
  def cache_key(candidate) do
    case Map.get(candidate, "uid") do
      uid when is_binary(uid) and uid != "" -> uid
      _ -> Map.get(candidate, "id", "")
    end
  end

  @doc "A cached entry is reusable iff its stored mtime equals the candidate's."
  def reusable_entry?(%{modified_at: modified_at, entry: entry}, modified_at)
      when is_map(entry),
      do: true

  def reusable_entry?(_, _), do: false

  @doc """
  Read one candidate's document entry via felt, threading `run_felt`.
  Returns `{:ok, entry}` or `{:error, reason}`.
  """
  def fetch_entry(candidate, host_map, run_felt) when is_function(run_felt, 2) do
    with id when is_binary(id) and id != "" <- Map.get(candidate, "id"),
         store when is_binary(store) <- Map.get(host_map, id),
         {:ok, output} <- run_felt.(store, ["show", id, "--json"]),
         {:ok, %{} = fiber} <- Jason.decode(output),
         [entry | _] <- FiberDocuments.entries_for_fiber(store, Map.delete(fiber, "body")) do
      {:ok, entry}
    else
      nil -> {:error, :missing_store}
      "" -> {:error, :missing_id}
      {:error, error} -> {:error, error}
      [] -> {:error, :invalid_entry}
      _ -> {:error, :invalid_json}
    end
  end
end
