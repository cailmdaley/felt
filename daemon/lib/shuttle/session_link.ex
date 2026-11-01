defmodule Shuttle.SessionLink do
  @moduledoc """
  Published bridge links for native sessions.

  Request paths read ETS and enqueue refreshes; the supervised resolver owns
  transcript discovery and bounded incremental reads. A Claude transcript is
  published after its observed baseline has been consumed, then only appended
  bytes are read. Native Pi and Codex transcripts are classified without
  parsing their contents.

  The cursor uses path, inode, size and mtime. It detects ordinary truncation,
  replacement, and same-size rewrites with a changed mtime. It cannot detect an
  in-place rewrite of an already-read prefix followed by growth when the
  observed inode, size and mtime do not distinguish that mutation. Same-size
  rewrites with an unchanged mtime are likewise undetectable. Native transcript
  writers do not provide a stronger append-only contract.
  """

  use GenServer
  require Logger

  alias Shuttle.{HarnessPaths, Transcript}

  @table :shuttle_session_links
  @chunk_bytes 65_536
  @queue_limit 500
  @retry_ms 1_000
  @retry_max_ms 60_000
  @young_retry_ms 3_000
  @young_window_ms 300_000
  @mature_retry_ms 60_000
  @marker "remote_session_change"

  @typedoc "Where one session can be opened, as resolved on this host."
  @type link :: %{
          session: String.t(),
          availability: :available_local | :transcript_missing | :resolving,
          harness: String.t() | nil,
          url: String.t() | nil
        }

  def start_link(opts \\ []) do
    case Keyword.get(opts, :name, __MODULE__) do
      nil -> GenServer.start_link(__MODULE__, opts)
      name -> GenServer.start_link(__MODULE__, opts, name: name)
    end
  end

  @impl true
  def init(opts) do
    table = Keyword.get(opts, :table, @table)
    :ets.new(table, [:named_table, :public, :set, read_concurrency: true])

    {:ok,
     %{
       table: table,
       queue: :queue.new(),
       queued: MapSet.new(),
       retrying: %{},
       retry_attempts: %{},
       retry_delays: %{},
       warned: MapSet.new(),
       cursors: %{},
       generations: %{},
       scheduled: false,
       chunk_bytes: Keyword.get(opts, :chunk_bytes, @chunk_bytes),
       retry_base_ms: Keyword.get(opts, :retry_base_ms, @retry_ms),
       retry_max_ms: Keyword.get(opts, :retry_max_ms, @retry_max_ms),
       after_pass: Keyword.get(opts, :after_pass),
       bytes_read: 0
     }}
  end

  @doc "Return the currently published answer and enqueue a nonblocking refresh."
  @spec resolve(String.t(), keyword()) :: link()
  def resolve(session, opts \\ []) when is_binary(session) do
    {key, roots} = identity(session, opts)
    enqueue(opts, key, session, roots)

    case lookup(table(opts), key) do
      {:ok, link} -> link
      :miss -> %{session: session, availability: :resolving, harness: nil, url: nil}
    end
  end

  @doc "Return a published Claude URL, or nil; never resolves a path or reads a transcript."
  @spec cached_url(String.t(), keyword()) :: String.t() | nil
  def cached_url(session, opts \\ []) when is_binary(session) do
    {key, roots} = identity(session, opts)
    enqueue(opts, key, session, roots)

    case lookup(table(opts), key) do
      {:ok, %{availability: :available_local, url: url}} -> url
      _ -> nil
    end
  end

  @doc "True for the only accepted bridge URL shape."
  @spec claude_url?(term()) :: boolean()
  def claude_url?(url), do: is_binary(url) and String.starts_with?(url, "https://claude.ai/")

  @doc "The installed desktop app's native thread route; not a phone universal link."
  def desktop_url(thread_id) when is_binary(thread_id) do
    if Regex.match?(
         ~r/\A[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z/i,
         thread_id
       ),
       do: "codex://threads/" <> thread_id
  end

  def desktop_url(_), do: nil

  @doc false
  def forget(session, opts \\ []) do
    {key, _roots} = identity(session, opts)
    server = Keyword.get(opts, :server, __MODULE__)
    GenServer.call(server, {:forget, key})
    :ok
  rescue
    ArgumentError -> :ok
  catch
    :exit, _ -> :ok
  end

  @impl true
  def handle_cast({:enqueue, key, session, roots}, state) do
    {:noreply, state |> queue(key, session, roots) |> schedule_if_needed()}
  end

  def handle_call({:forget, key}, _from, state) do
    generation = Map.get(state.generations, key, 0) + 1
    :ets.delete(state.table, key)

    queue =
      state.queue
      |> :queue.to_list()
      |> Enum.reject(fn {queued_key, _, _, _} -> queued_key == key end)
      |> :queue.from_list()

    {:reply, :ok,
     %{
       state
       | queue: queue,
         queued: MapSet.delete(state.queued, key),
         retrying: cancel_retry(state, key),
         retry_attempts: Map.delete(state.retry_attempts, key),
         retry_delays: Map.delete(state.retry_delays, key),
         cursors: Map.delete(state.cursors, key),
         generations: Map.put(state.generations, key, generation)
     }}
  end

  @impl true
  def handle_call(:stats, _from, state),
    do: {:reply, %{bytes_read: state.bytes_read, queued: MapSet.size(state.queued)}, state}

  @doc false
  def stats(server \\ __MODULE__), do: GenServer.call(server, :stats)

  @impl true
  def handle_info(:work, state) do
    case :queue.out(state.queue) do
      {:empty, _} ->
        {:noreply, %{state | scheduled: false}}

      {{:value, {key, session, roots, generation}}, queue} ->
        state = %{
          state
          | queue: queue,
            queued: MapSet.delete(state.queued, key),
            scheduled: false
        }

        if generation != Map.get(state.generations, key, 0) do
          state = schedule_if_needed(state)
          {:noreply, state}
        else
          {result, cursors, bytes_read} =
            case advance(key, session, roots, state.cursors, state.table, state.chunk_bytes) do
              {:retry, reason, cursors, bytes_read} -> {{:retry, reason}, cursors, bytes_read}
              {result, cursors, bytes_read} -> {result, cursors, bytes_read}
            end

          state = %{state | cursors: cursors, bytes_read: state.bytes_read + bytes_read}
          run_after_pass(state.after_pass, key, result, cursors)

          state =
            case result do
              :continue ->
                queue(reset_backoff(state, key), key, session, roots)

              {:retry, reason} ->
                retry_later(state, key, session, roots, generation, reason)

              :done ->
                reset_backoff(state, key)
            end

          {:noreply, schedule_if_needed(state)}
        end
    end
  end

  def handle_info({:retry, key, session, roots, generation, attempt}, state) do
    current? =
      generation == Map.get(state.generations, key, 0) and
        match?(%{generation: ^generation, attempt: ^attempt}, Map.get(state.retrying, key))

    state = if current?, do: %{state | retrying: Map.delete(state.retrying, key)}, else: state
    state = if current?, do: queue(state, key, session, roots), else: state

    state = schedule_if_needed(state)
    {:noreply, state}
  end

  defp queue(state, key, session, roots) do
    if MapSet.member?(state.queued, key) or Map.has_key?(state.retrying, key) or
         MapSet.size(state.queued) >= @queue_limit do
      state
    else
      %{
        state
        | queue:
            :queue.in({key, session, roots, Map.get(state.generations, key, 0)}, state.queue),
          queued: MapSet.put(state.queued, key)
      }
    end
  end

  defp schedule_if_needed(%{scheduled: false} = state) do
    if :queue.is_empty(state.queue) do
      state
    else
      send(self(), :work)
      %{state | scheduled: true}
    end
  end

  defp schedule_if_needed(state), do: state

  @doc false
  def retry_delay_ms(attempt, base_ms \\ @retry_ms, max_ms \\ @retry_max_ms)
      when is_integer(attempt) and attempt >= 1 and is_integer(base_ms) and base_ms > 0 and
             is_integer(max_ms) and max_ms > 0 do
    retry_delay_ms(attempt, base_ms, max_ms, base_ms)
  end

  defp retry_delay_ms(_attempt, _base, max, delay) when delay >= max, do: max
  defp retry_delay_ms(1, _base, _max, delay), do: delay

  defp retry_delay_ms(attempt, base, max, delay),
    do: retry_delay_ms(attempt - 1, base, max, min(delay * 2, max))

  defp retry_later(state, key, session, roots, generation, reason) do
    attempt = Map.get(state.retry_attempts, key, 0) + 1
    delay_ms = retry_delay_ms(attempt, state.retry_base_ms, state.retry_max_ms)

    timer =
      Process.send_after(self(), {:retry, key, session, roots, generation, attempt}, delay_ms)

    state = warn_once(state, key, reason)

    %{
      state
      | retrying:
          Map.put(state.retrying, key, %{
            generation: generation,
            attempt: attempt,
            timer: timer,
            delay_ms: delay_ms
          }),
        retry_attempts: Map.put(state.retry_attempts, key, attempt),
        retry_delays:
          Map.update(state.retry_delays, key, [delay_ms], fn delays ->
            if length(delays) < 5, do: delays ++ [delay_ms], else: delays
          end)
    }
  end

  defp warn_once(state, key, reason) do
    warning_key = {key, reason}

    if MapSet.member?(state.warned, warning_key) do
      state
    else
      Logger.warning(
        "session link resolver retrying session=#{elem(key, 0)} reason=#{inspect(reason)}"
      )

      %{state | warned: MapSet.put(state.warned, warning_key)}
    end
  end

  defp reset_backoff(state, key) do
    %{
      state
      | retry_attempts: Map.delete(state.retry_attempts, key),
        retry_delays: Map.delete(state.retry_delays, key)
    }
  end

  defp cancel_retry(state, key) do
    case Map.pop(state.retrying, key) do
      {nil, retrying} ->
        retrying

      {%{timer: timer}, retrying} ->
        Process.cancel_timer(timer)
        retrying
    end
  end

  defp run_after_pass(nil, _key, _result, _cursors), do: :ok
  defp run_after_pass(callback, key, result, cursors), do: callback.(key, result, cursors)

  defp advance(key, session, roots, cursors, table, chunk_bytes) do
    prior = Map.get(cursors, key)
    now = System.monotonic_time(:millisecond)
    missing_retry_ms = Keyword.get(roots, :missing_retry_ms, missing_retry_ms(prior, now))

    if prior && Map.get(prior, :missing) &&
         now - prior.checked_at < missing_retry_ms do
      {:done, cursors, 0}
    else
      missing? = prior && Map.get(prior, :missing)
      missing_cursor = if missing?, do: prior, else: nil
      prior = if missing?, do: nil, else: prior
      cursors = if missing?, do: Map.delete(cursors, key), else: cursors

      case transcript_path(prior, session, roots) do
        {:retry, reason} ->
          {:retry, reason, cursors, 0}

        {:ok, nil} ->
          link = %{session: session, availability: :transcript_missing, harness: nil, url: nil}
          :ets.insert(table, {key, link})

          first_miss_at = if missing_cursor, do: missing_cursor.first_miss_at, else: now

          {:done,
           Map.put(cursors, key, %{missing: true, checked_at: now, first_miss_at: first_miss_at}),
           0}

        {:ok, path} ->
          harness =
            if prior && prior.path == path,
              do: prior.harness,
              else: Transcript.harness_for(path, roots)

          if harness != "claude-code" do
            link = %{session: session, availability: :available_local, harness: harness, url: nil}
            :ets.insert(table, {key, link})
            {:done, Map.put(cursors, key, %{path: path, harness: harness}), 0}
          else
            advance_claude(key, session, path, cursors, table, chunk_bytes)
          end
      end
    end
  rescue
    exception -> {:retry, {:discovery_exception, exception.__struct__}, cursors, 0}
  catch
    kind, _ -> {:retry, {:discovery_throw, kind}, cursors, 0}
  end

  defp transcript_path(%{path: path}, session, roots) do
    case File.stat(path) do
      {:ok, %{type: :regular}} ->
        {:ok, path}

      {:ok, _other} ->
        {:ok, Transcript.path(session, roots)}

      {:error, reason} when reason in [:enoent, :enotdir] ->
        {:ok, Transcript.path(session, roots)}

      {:error, reason} ->
        {:retry, {:stat_path, reason}}
    end
  end

  defp transcript_path(_prior, session, roots), do: {:ok, Transcript.path(session, roots)}

  defp missing_retry_ms(%{missing: true, first_miss_at: first_miss_at}, now)
       when now - first_miss_at >= @young_window_ms,
       do: @mature_retry_ms

  defp missing_retry_ms(_, _now), do: @young_retry_ms

  defp advance_claude(key, session, path, cursors, table, chunk_bytes) do
    case :file.open(path, [:read, :binary, :raw]) do
      {:ok, file} ->
        try do
          with {:ok, info} <- file_info(file) do
            stat = File.Stat.from_record(info)
            prior = Map.get(cursors, key)

            reset? =
              is_nil(prior) or prior.path != path or Map.get(prior, :inode) != stat.inode or
                stat.size < prior.offset or stat.size < prior.observed_size or
                (stat.size == prior.observed_size and stat.mtime != prior.mtime)

            cursor =
              if reset?,
                do: %{
                  path: path,
                  harness: "claude-code",
                  inode: stat.inode,
                  offset: 0,
                  partial_chunks: [],
                  url: nil,
                  observed_size: stat.size,
                  mtime: stat.mtime
                },
                else: prior

            target = stat.size

            cond do
              cursor.offset >= target ->
                if reset?, do: publish(table, key, session, cursor.url)

                {:done,
                 Map.put(cursors, key, %{cursor | observed_size: target, mtime: stat.mtime}), 0}

              true ->
                count = min(chunk_bytes, target - cursor.offset)

                with {:ok, _position} <- file_position(file, cursor.offset),
                     {:ok, bytes} <- file_read(file, count) do
                  next =
                    consume(cursor, bytes, cursor.offset + byte_size(bytes), target, stat.mtime)

                  if next.offset >= target do
                    case current_generation?(path, stat, target) do
                      :current ->
                        publish(table, key, session, next.url)
                        {:done, Map.put(cursors, key, next), byte_size(bytes)}

                      :changed ->
                        {:continue, Map.delete(cursors, key), byte_size(bytes)}

                      {:error, reason} ->
                        {:retry, reason, cursors, byte_size(bytes)}
                    end
                  else
                    {:continue, Map.put(cursors, key, next), byte_size(bytes)}
                  end
                else
                  {:error, reason} -> {:retry, reason, cursors, 0}
                end
            end
          else
            {:error, reason} -> {:retry, reason, cursors, 0}
          end
        after
          :file.close(file)
        end

      {:error, reason} ->
        {:retry, {:open, reason}, cursors, 0}
    end
  end

  defp file_info(file) do
    case :file.read_file_info(file) do
      {:ok, info} -> {:ok, info}
      {:error, reason} -> {:error, {:stat, reason}}
    end
  end

  defp file_position(file, offset) do
    case :file.position(file, offset) do
      {:ok, position} -> {:ok, position}
      {:error, reason} -> {:error, {:seek, reason}}
    end
  end

  defp file_read(file, count) do
    case :file.read(file, count) do
      {:ok, bytes} -> {:ok, bytes}
      :eof -> {:error, {:read, :eof}}
      {:error, reason} -> {:error, {:read, reason}}
    end
  end

  defp current_generation?(path, read_stat, target) do
    case :file.read_file_info(path) do
      {:ok, info} ->
        current = File.Stat.from_record(info)

        if current.inode == read_stat.inode and current.size >= target and
             not (current.size == target and current.mtime != read_stat.mtime),
           do: :current,
           else: :changed

      {:error, reason} ->
        {:error, {:stat_path, reason}}
    end
  end

  defp consume(cursor, bytes, next_offset, target, mtime) do
    if :binary.match(bytes, "\n") == :nomatch do
      %{
        cursor
        | offset: next_offset,
          partial_chunks: [bytes | cursor.partial_chunks],
          observed_size: target,
          mtime: mtime
      }
    else
      data = :erlang.iolist_to_binary([Enum.reverse(cursor.partial_chunks), bytes])
      parts = :binary.split(data, "\n", [:global])
      complete? = byte_size(data) > 0 and :binary.last(data) == ?\n

      {lines, partial_chunks} =
        if complete?,
          do: {Enum.drop(parts, -1), []},
          else: {Enum.drop(parts, -1), [List.last(parts) || ""]}

      url = Enum.reduce(lines, cursor.url, fn line, last -> decode_url(line) || last end)

      %{
        cursor
        | offset: next_offset,
          partial_chunks: partial_chunks,
          url: url,
          observed_size: target,
          mtime: mtime
      }
    end
  end

  defp publish(table, key, session, url) do
    :ets.insert(
      table,
      {key, %{session: session, availability: :available_local, harness: "claude-code", url: url}}
    )
  end

  defp lookup(table, key) do
    case :ets.lookup(table, key) do
      [{^key, link}] -> {:ok, link}
      _ -> :miss
    end
  rescue
    ArgumentError -> :miss
  end

  defp enqueue(opts, key, session, roots) do
    GenServer.cast(Keyword.get(opts, :server, __MODULE__), {:enqueue, key, session, roots})
  catch
    :exit, _ -> :ok
  end

  defp table(opts), do: Keyword.get(opts, :table, @table)

  defp identity(session, opts) do
    roots = effective_roots(opts)

    key =
      {session, Enum.map([:root, :pi_root, :codex_root], &Keyword.fetch!(roots, &1)),
       Keyword.get(roots, :today), Keyword.get(roots, :since),
       Keyword.get(roots, :missing_retry_ms)}

    {key, roots}
  end

  defp effective_roots(opts) do
    [
      root: Shuttle.Env.expand(HarnessPaths.claude_projects_root(opts)),
      pi_root: Shuttle.Env.expand(HarnessPaths.pi_sessions_root(opts)),
      codex_root: Shuttle.Env.expand(HarnessPaths.codex_sessions_root(opts))
    ] ++ Keyword.take(opts, [:today, :since, :missing_retry_ms])
  end

  defp decode_url(line) do
    if String.contains?(line, @marker) do
      case Jason.decode(line) do
        {:ok, %{"attachment" => %{"type" => @marker, "url" => url}}} when is_binary(url) ->
          if claude_url?(url), do: url

        _ ->
          nil
      end
    end
  end
end
