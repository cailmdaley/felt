defmodule Shuttle.Poller.LocalFeed do
  @moduledoc """
  The last observed owner feed on disk, so a restarting daemon's board keeps its
  local rows while the document cache warms.

  `Shuttle.RemoteFiberRegistry` keeps each remote's feed under
  `$SHUTTLE_DATA_DIR/remote-fibers/<host>.json`; this is the local origin's
  counterpart, `$SHUTTLE_DATA_DIR/local-fibers/<host>.json`, written with the
  same atomic tmp-and-rename (`Shuttle.RegistryCommon.persist/4`). The envelope
  names its owner host, and a file naming another host is not this daemon's.

  The Poller hands writes to one task at a time (see `Shuttle.Poller`'s local
  feed writer) and reads the file once at boot. The remembered rows reach
  readers only through `Shuttle.Poller.cached_fiber_documents/2` with
  `last_known: true`, until the first successful listing replaces them; the
  runtime overlay is stamped over them live, as over observed rows. Dispatch
  never reads them: it works from the document cache.

  A missing, unreadable, malformed, other-version or other-host file, or one
  with any row outside the entry shape, loads as no rows.
  """

  alias Shuttle.RegistryCommon

  @version 1

  # Every key a cache entry may carry, and the shape each must have.
  @keys %{
    "felt_store" => :felt_store,
    "path" => :path,
    "fiber" => :fiber,
    "dir" => :dir,
    "report_path" => :report_path,
    "orchestrator" => :orchestrator
  }

  @doc "Write `entries` as `host`'s last observed owner feed."
  @spec persist(String.t(), [map()]) :: :ok | {:error, term()}
  def persist(host, entries) do
    RegistryCommon.persist(
      dir(),
      host,
      %{version: @version, host: host, fibers: entries},
      "LocalFeed"
    )
  end

  @doc """
  A single writer's state: `written` is the last snapshot on disk, `writing`
  the one being written (at most one), `pending` the newest waiting behind it.
  """
  @spec writer([map()]) :: map()
  def writer(written), do: %{written: written, writing: nil, pending: nil}

  @doc """
  Offer the owner feed's current rows. Returns the writer and the rows to start
  writing now, or nil: a snapshot equal to the newest known is dropped, one
  arriving during a write replaces any older one waiting, so a newer snapshot
  is never overtaken.
  """
  @spec offer(map(), [map()]) :: {map(), [map()] | nil}
  def offer(writer, rows) do
    cond do
      rows == newest(writer) -> {writer, nil}
      writer.writing != nil -> {%{writer | pending: rows}, nil}
      true -> {%{writer | writing: rows}, rows}
    end
  end

  @doc """
  Record the write in flight as finished with `result`. Only `:ok` advances
  `written`, so a failed snapshot is offered again by the next publication.
  Returns the writer and the pending rows to start writing now, or nil.
  """
  @spec finished(map(), :ok | {:error, term()}) :: {map(), [map()] | nil}
  def finished(%{writing: rows} = writer, result) do
    written = if result == :ok, do: rows, else: writer.written
    writer = %{writer | written: written, writing: nil}

    case writer.pending do
      nil -> {writer, nil}
      next -> {%{writer | writing: next, pending: nil}, next}
    end
  end

  defp newest(%{pending: rows}) when rows != nil, do: rows
  defp newest(%{writing: rows}) when rows != nil, do: rows
  defp newest(%{written: rows}), do: rows

  @doc "`host`'s remembered owner feed rows, atom-keyed like the cache's entries."
  @spec load(String.t()) :: [map()]
  def load(host) do
    with {:ok, raw} <- Shuttle.FS.read(path(host)),
         {:ok, %{"version" => @version, "host" => ^host, "fibers" => fibers}}
         when is_list(fibers) <- Jason.decode(raw),
         {:ok, entries} <- entries(fibers) do
      entries
    else
      _ -> []
    end
  end

  defp entries(rows) do
    Enum.reduce_while(rows, {:ok, []}, fn row, {:ok, acc} ->
      case entry(row) do
        {:ok, entry} -> {:cont, {:ok, [entry | acc]}}
        :error -> {:halt, :error}
      end
    end)
    |> case do
      {:ok, acc} -> {:ok, Enum.reverse(acc)}
      :error -> :error
    end
  end

  defp entry(%{"felt_store" => store, "path" => path, "fiber" => %{"id" => id}} = row)
       when is_binary(store) and is_binary(path) and is_binary(id) do
    if Enum.all?(row, &allowed?/1),
      do: {:ok, Map.new(row, fn {k, v} -> {Map.fetch!(@keys, k), v} end)},
      else: :error
  end

  defp entry(_row), do: :error

  defp allowed?({"fiber", value}), do: is_map(value)
  defp allowed?({"orchestrator", value}), do: is_binary(value) or is_nil(value)
  defp allowed?({key, value}), do: Map.has_key?(@keys, key) and is_binary(value)

  defp dir, do: Path.join(Shuttle.data_dir(), "local-fibers")

  defp path(host), do: Path.join(dir(), "#{RegistryCommon.safe_name(host)}.json")
end
