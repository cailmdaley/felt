defmodule Shuttle.Poller.ChangeDiscovery do
  @moduledoc """
  Incremental store reads, independent of the dispatch poll's cadence.

  The CLI checks native nanosecond metadata with eight concurrent readers.
  This module keeps its index in memory and reads only changed addresses through
  the ordinary Shuttle listing, preserving projection and physical ownership.
  All command and filesystem work runs in the Poller's supervised task.
  """

  def read(state, indexes, owner) do
    task = self()

    spawn(fn ->
      owner_ref = Process.monitor(owner)
      task_ref = Process.monitor(task)

      receive do
        {:DOWN, ^owner_ref, :process, _, _} -> Process.exit(task, :kill)
        {:DOWN, ^task_ref, :process, _, _} -> :ok
      end
    end)

    Map.new(state.felt_stores, fn store ->
      started = System.monotonic_time(:millisecond)

      result =
        if Shuttle.FS.protected?(Path.join(store, ".felt")) or
             Shuttle.FS.protected?(Shuttle.FeltStores.store_felt_realpath(store)) do
          {:ok, %{index: "{}", indexed_paths: 0, ids: [], rows: []}}
        else
          scan(state, store, Map.get(indexes, store, "{}"))
        end

      result =
        case result do
          {:ok, scan} ->
            {:ok, Map.put(scan, :duration_ms, System.monotonic_time(:millisecond) - started)}

          error ->
            error
        end

      {store, result}
    end)
  end

  defp scan(state, store, index) do
    previous = if is_binary(index), do: index, else: "{}"

    case state.runner.cmd("shuttle", ["-C", store, "scan-changes"],
           input: previous,
           timeout_ms: 60_000
         ) do
      {output, 0} ->
        with [header, next] <- String.split(output, "\n", parts: 2),
             {:ok, %{"ids" => ids, "indexed_paths" => indexed_paths}} <- Jason.decode(header),
             true <- is_binary(next) and next != "",
             {:ok, %{rows: rows}} <- Shuttle.Poller.Discovery.list_changed(store, state, ids) do
          {:ok, %{index: next, indexed_paths: indexed_paths, ids: ids, rows: rows}}
        else
          error -> {:error, inspect(error)}
        end

      {output, status} ->
        {:error, "scan-changes exited #{inspect(status)}: #{String.slice(output, 0, 500)}"}
    end
  end
end
