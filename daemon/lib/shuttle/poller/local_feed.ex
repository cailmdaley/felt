defmodule Shuttle.Poller.LocalFeed do
  @moduledoc """
  The last observed owner feed on disk, so a restarting daemon's board keeps its
  local rows while the document cache warms.

  `Shuttle.RemoteFiberRegistry` keeps each remote's feed under
  `$SHUTTLE_DATA_DIR/remote-fibers/<host>.json`; this is the local origin's
  counterpart, `$SHUTTLE_DATA_DIR/local-fibers/<host>.json`, written with the
  same atomic tmp-and-rename (`Shuttle.RegistryCommon.persist/4`). The envelope
  names its owner host, and a file naming another host is not this daemon's.

  This module also runs as a supervised GenServer that outlives Poller restarts
  and serializes writes per target file path (at most one write task in flight
  per path, with a single coalescing pending slot). The Poller calls `submit/2`
  without blocking on disk I/O and reads the file once at boot. The remembered
  rows reach readers only through `Shuttle.Poller.cached_fiber_documents/2` with
  `last_known: true`, until the first successful listing replaces them; the
  runtime overlay is stamped over them live, as over observed rows. Dispatch
  never reads them: it works from the document cache.

  A missing, unreadable, malformed, other-version or other-host file, or one
  with any row outside the entry shape, loads as no rows.
  """

  use GenServer
  require Logger

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

  # ── Supervised per-file writer ──

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @doc """
  Seed the supervised writer's known on-disk snapshot for `host` after boot
  load so an unchanged first poll does not rewrite identical bytes.
  """
  @spec seed(String.t(), [map()], keyword()) :: :ok
  def seed(host, entries, opts \\ []) do
    server = Keyword.get(opts, :server, __MODULE__)
    file = path_in(dir(), host)

    if server_alive?(server) do
      GenServer.cast(server, {:seed, file, entries})
    end

    :ok
  end

  @doc """
  Queue `entries` to be persisted for `host` by the supervised writer.
  Non-blocking; writes for the same file path are serialized across Poller
  restarts and coalesced so an older snapshot never overtakes a newer one.
  """
  @spec submit(String.t(), [map()], keyword()) :: :ok
  def submit(host, entries, opts \\ []) do
    server = Keyword.get(opts, :server, __MODULE__)
    target_dir = Keyword.get(opts, :dir, dir())
    file = path_in(target_dir, host)
    callers = [self() | Process.get(:"$callers") || []]
    persist_fn = Keyword.get(opts, :persist_fn)

    if server_alive?(server) do
      GenServer.cast(server, {:submit, file, target_dir, host, entries, callers, persist_fn})
    else
      _ = run_persist(persist_fn, target_dir, host, entries)
    end

    :ok
  end

  @doc false
  def idle?(host, opts \\ []) do
    server = Keyword.get(opts, :server, __MODULE__)
    file = path_in(Keyword.get(opts, :dir, dir()), host)

    if server_alive?(server) do
      GenServer.call(server, {:idle?, file})
    else
      true
    end
  end

  @impl true
  def init(_opts) do
    {:ok, %{slots: %{}, tasks: %{}}}
  end

  @impl true
  def handle_call({:idle?, file}, _from, state) do
    idle? =
      case Map.get(state.slots, file) do
        %{writer: %{writing: nil, pending: nil}} -> true
        nil -> true
        _ -> false
      end

    {:reply, idle?, state}
  end

  @impl true
  def handle_cast({:seed, file, entries}, state) do
    if Map.has_key?(state.slots, file) do
      {:noreply, state}
    else
      {:noreply, put_in(state.slots[file], %{writer: writer(entries), meta: nil})}
    end
  end

  def handle_cast({:submit, file, target_dir, host, entries, callers, persist_fn}, state) do
    slot = Map.get(state.slots, file, %{writer: writer(:uninitialized), meta: nil})
    meta = %{dir: target_dir, host: host, callers: callers, persist_fn: persist_fn}
    {next_writer, to_write} = offer(slot.writer, entries)
    state = put_in(state.slots[file], %{writer: next_writer, meta: meta})
    {:noreply, maybe_start_write(state, file, meta, to_write)}
  end

  @impl true
  def handle_info({ref, {:local_feed_written, file, result}}, state)
      when is_map_key(state.tasks, ref) do
    Process.demonitor(ref, [:flush])
    {:noreply, complete_write(state, ref, file, result)}
  end

  def handle_info({:DOWN, ref, :process, _pid, reason}, state)
      when is_map_key(state.tasks, ref) do
    file = Map.fetch!(state.tasks, ref)
    {:noreply, complete_write(state, ref, file, {:error, reason})}
  end

  def handle_info(_msg, state), do: {:noreply, state}

  defp maybe_start_write(state, _file, _meta, nil), do: state

  defp maybe_start_write(state, file, meta, rows) do
    task =
      Task.Supervisor.async_nolink(Shuttle.TaskSupervisor, fn ->
        Process.put(:"$callers", meta.callers)
        {:local_feed_written, file, run_persist(meta.persist_fn, meta.dir, meta.host, rows)}
      end)

    put_in(state.tasks[task.ref], file)
  end

  defp complete_write(state, ref, file, result) do
    if result != :ok,
      do: Logger.warning("local feed write failed; retrying later: #{inspect(result)}")

    state = update_in(state.tasks, &Map.delete(&1, ref))

    case Map.get(state.slots, file) do
      nil ->
        state

      %{writer: w, meta: meta} ->
        {next_writer, to_write} = finished(w, result)
        state = put_in(state.slots[file], %{writer: next_writer, meta: meta})
        maybe_start_write(state, file, meta, to_write)
    end
  end

  defp run_persist(nil, target_dir, host, rows), do: persist_in(target_dir, host, rows)
  defp run_persist(fun, _target_dir, host, rows) when is_function(fun, 2), do: fun.(host, rows)

  defp server_alive?(pid) when is_pid(pid), do: Process.alive?(pid)
  defp server_alive?(name) when is_atom(name), do: Process.whereis(name) != nil
  defp server_alive?(_), do: false

  # ── Persistence & pure state machine ──

  @doc "Write `entries` as `host`'s last observed owner feed."
  @spec persist(String.t(), [map()]) :: :ok | {:error, term()}
  def persist(host, entries), do: persist_in(dir(), host, entries)

  @doc false
  def persist_in(target_dir, host, entries) do
    RegistryCommon.persist(
      target_dir,
      host,
      %{version: @version, host: host, fibers: entries},
      "LocalFeed"
    )
  end

  @doc """
  A single writer's state: `written` is the last snapshot on disk, `writing`
  the one being written (at most one), `pending` the newest waiting behind it.
  """
  @spec writer([map()] | :uninitialized) :: map()
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
    with {:ok, raw} <- Shuttle.FS.read(path_in(dir(), host)),
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

  defp path_in(target_dir, host), do: Path.join(target_dir, "#{RegistryCommon.safe_name(host)}.json")
end
