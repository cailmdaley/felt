defmodule Shuttle.Poller.DocumentCache do
  @moduledoc """
  The poll-cycle document cache for `Shuttle.Poller`.

  Extracted from the poller as the most self-contained cluster: it owns how the
  fiber-document feed is rebuilt each tick (`refresh/3`), how an entry is keyed
  (`cache_key/1`, uid when present else id), and whether a prior entry can be
  reused without rebuilding (`reusable_entry?/2`, mtime-equality).

  ## One walk, not N shell-outs

  The candidate rows the poller already discovered (`felt ls` with the widened
  kanban projection — see `Shuttle.FiberDocuments.kanban_fields/0`) carry every
  field a cache entry needs, so an entry is built DIRECTLY from its candidate row
  via `Shuttle.FiberDocuments.entries_for_fiber/2` — no per-miss `felt show`.
  The mtime predicate stays as a cheap "reuse the already-built entry map"
  optimization; on a slow filesystem (a Lustre login node with 726 shuttle
  fibers) the tick costs exactly one `felt ls` per store and zero stats.

  The cache itself — `document_cache`, `document_cache_stats`,
  `document_cache_ready` — lives on `Shuttle.Poller.State`; the GenServer owns
  state. These functions take the poller state and return plain values (the new
  cache + stats).
  """

  require Logger

  alias Shuttle.FiberDocuments

  @doc """
  Rebuild the document cache from `candidates`, reusing unchanged entries by
  mtime and building the rest directly from their candidate rows. Returns
  `{cache, stats}` where `stats` carries hits/misses/evictions/entries.

  `host_map` is `%{fiber_id => felt_store}`, resolving each candidate to the
  store that physically roots it (so the entry's `felt_store`/`path` are correct).
  """
  def refresh(state, candidates, host_map) do
    previous = state.document_cache

    {cache, stats} =
      Enum.reduce(candidates, {%{}, %{hits: 0, misses: 0}}, fn candidate, {cache_acc, stats} ->
        key = cache_key(candidate)
        modified_at = Map.get(candidate, "modified_at")
        cached = Map.get(previous, key)

        if reusable_entry?(cached, modified_at) do
          # mtime-reuse hit: the fiber body is unchanged, but adding/removing a
          # sibling report.html does NOT bump `modified_at`, so reconcile the
          # entry's `:report_path` against the candidate row's native field
          # before reusing (put when the field is present, drop when absent).
          reused = reconcile_report_path(cached, candidate)
          {Map.put(cache_acc, key, reused), Map.update!(stats, :hits, &(&1 + 1))}
        else
          case build_entry(candidate, host_map) do
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

  # Reconcile a reused entry's `:report_path` against the candidate row's native
  # `report_path` field — the only report signal that changes without a
  # `modified_at` bump. Mirrors `FiberDocuments.entry_for/3` (:field): a present
  # non-empty field means the sibling report exists (emit `dir/report.html`);
  # absence means it does not (drop any stale `:report_path`). Keyed off the
  # entry's already-computed `:dir`, so it stats nothing.
  defp reconcile_report_path(%{entry: entry} = cached, candidate) do
    reported? = match?(v when is_binary(v) and v != "", Map.get(candidate, "report_path"))
    dir = Map.get(entry, :dir)

    cond do
      reported? and is_binary(dir) ->
        %{cached | entry: Map.put(entry, :report_path, Path.join(dir, "report.html"))}

      not reported? and Map.has_key?(entry, :report_path) ->
        %{cached | entry: Map.delete(entry, :report_path)}

      true ->
        cached
    end
  end

  @doc "A cached entry is reusable iff its stored mtime equals the candidate's."
  def reusable_entry?(%{modified_at: modified_at, entry: entry}, modified_at)
      when is_map(entry),
      do: true

  def reusable_entry?(_, _), do: false

  # Build one candidate's document entry directly from its felt-list row. No
  # shell-out and no stat: the row already carries the full kanban projection
  # (including the native `report_path` existence signal), so
  # `FiberDocuments.entries_for_fiber/2` shapes the wire entry in-process.
  defp build_entry(candidate, host_map) do
    id = Map.get(candidate, "id")
    store = if is_binary(id), do: Map.get(host_map, id)

    cond do
      not (is_binary(id) and id != "") ->
        {:error, :missing_id}

      not is_binary(store) ->
        {:error, :missing_store}

      true ->
        case FiberDocuments.entries_for_fiber(store, Map.delete(candidate, "body")) do
          [entry | _] -> {:ok, entry}
          [] -> {:error, :invalid_entry}
        end
    end
  end
end
