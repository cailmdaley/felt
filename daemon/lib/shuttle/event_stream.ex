defmodule Shuttle.EventStream do
  @moduledoc """
  The one reader of this host's hook-event stream (`~/.shuttle/events.jsonl`)
  and its rotated sibling `events.jsonl.1`. It reads each line once, decodes it
  once, and hands the decoded event to three pure projections it holds in
  memory:

    * `Shuttle.Activity` — the per-minute activity fold behind
      `GET /api/v1/activity`;
    * `Shuttle.SentFiles` — the sent-file events behind `/api/v1/sent-files`;
    * `Shuttle.WaitingTracker` — the last event per worker session, which the
      poller stamps onto running cards as `last_event_at` and `phase`.

  Every projection is a pure function of a prefix of the stream: the bytes
  below a given offset never change between rotations, so following the file
  forward is cheaper than rescanning it without being less true. The byte
  mechanics — reading only complete lines, draining a rotated file, telling a
  rotation from an append by inode — are `Shuttle.FileTail`'s.

  ## Seed, then follow

  `init/1` reads both files once — the live file first (its lines, offset and
  inode from one open file), then `events.jsonl.1`, whose events are ingested
  first because they were written first. The seed finishes before the process
  starts, so the poller, which starts after this process, sees every session
  the files know about on its first stamp. Afterwards only the bytes appended
  since are read, on a timer and again before each catch-up read.

  If `.1` carries the inode the live read came from, a rotation landed between
  the two reads and `.1` IS that file; ingesting both would count it twice, so
  the seed starts over. A rotation after `.1` is read is an ordinary one, and
  the next poll follows it.

  ## Rotation continues every projection

  `shuttle hook event` rotates by renaming the live file to `events.jsonl.1` and
  starting a fresh one. The stream recognizes that by the live path's inode
  moving, not by a shrink. When the rotated file carries the inode it was
  following, it ingests that file's bytes past the old offset (the lines
  written just before the rename) and then the new live file from its start:

    * the activity fold keeps its spell and pairing state and drops what the
      overwritten `.1` alone held (`Shuttle.Activity.drop_before/2`);
    * the sent-file events are kept as two segments, one per file, so after a
      rotation the old live segment becomes the rotated one and the segment
      the overwritten `.1` held is dropped — exactly what the two files hold;
    * the waiting map is last-event-wins, so it simply carries on.

  Anything else — the live file shrinking in place, or replaced by a file the
  stream cannot account for — rebuilds every projection from the two files.
  The waiting map keeps what it already knew across that rebuild: a session
  the new files do not mention stays known, and a record never moves back to
  an older event (`Shuttle.WaitingTracker.merge_known/2`).

  ## Reads

  `slice/4` and `sent_events/2` follow the file before they answer, so a read
  sees everything written before the request with no polling latency; between
  ticks that costs two `stat`s. Each answers only for the path it is actually
  following — any other path is a `:miss`, and the caller folds that path
  itself (`fold_files/3`). That is what keeps an injected fixture, or a crashed
  stream, correct rather than silently served stale.

  `session_activity/1` never enters this process's mailbox: the stream
  publishes its waiting map to a protected ETS table named after the server
  whenever a poll, catch-up read or seed settles, and readers compute phases
  from that row. The poller calls it inside the owner-feed request, which must
  wait neither on the filesystem nor behind a full reseed of a shrunken file.
  It is as fresh as the last poll, catch-up read or seed to complete.
  """

  use GenServer

  require Logger

  alias Shuttle.{Activity, FileTail, SentFiles, WaitingTracker}

  @poll_interval_ms 1_000
  # A catch-up read that lands during a reseed waits for it; the seed of a
  # full 64 MB pair takes a few seconds on a loaded host.
  @read_timeout_ms 30_000
  @miss_log_interval_ms 60_000

  defmodule State do
    @moduledoc false
    # `offset` and `inode` describe how far into which live file the
    # projections have read. `sent_rotated` and `sent_live` hold the sent-file
    # events of `.1` and of the live file, each newest-first so that ingest is
    # a prepend. `seed_hook` runs between reading the live file and reading the
    # rotated one — the window a racing rotation lands in. Tests rotate there.
    # `clock` returns epoch ms; the waiting projection prunes and reads by it.
    # `table` is the ETS table `session_activity/1` reads; `published` is the
    # waiting map last written there.
    defstruct [
      :events_file,
      :table,
      :published,
      :poll_interval_ms,
      :clock,
      :seed_hook,
      :inode,
      :activity,
      offset: 0,
      sent_rotated: [],
      sent_live: [],
      waiting: %{}
    ]
  end

  # ── Client ──

  @doc """
  Starts the stream. Opts: `:events_file` (default `default_events_file/0`),
  `:poll_interval_ms`, `:clock` (0-arity fn returning epoch ms), `:seed_hook`,
  `:name`.
  """
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @doc """
  The host-local event stream, honoring the same env the hook writes:
  `SHUTTLE_EVENTS_FILE`, else `$SHUTTLE_DATA_DIR/events.jsonl`, default
  `~/.shuttle/events.jsonl`. `cmd/shuttle_events.go` mirrors this resolver
  exactly; `cmd/hook_event.go` writes the lines.
  """
  @spec default_events_file() :: Path.t()
  def default_events_file do
    Shuttle.state_path("SHUTTLE_EVENTS_FILE", "events.jsonl")
  end

  @doc "The rotated sibling of `live`, named exactly as the writer names it."
  @spec rotated(Path.t()) :: Path.t()
  def rotated(live), do: live <> ".1"

  @doc """
  The activity buckets for the canonical window of `from_ms..to_ms` over
  `path`, after catching up — or `:miss` if this stream follows a different
  file or is not running.
  """
  @spec slice(GenServer.server(), Path.t(), integer(), integer()) ::
          {:ok, [Activity.bucket()]} | :miss
  def slice(server \\ __MODULE__, path, from_ms, to_ms) do
    GenServer.call(server, {:slice, path, from_ms, to_ms}, @read_timeout_ms)
  catch
    :exit, _ -> :miss
  end

  @doc """
  The sent-file events of `path` and its rotated sibling, oldest first, after
  catching up — or `:miss` if this stream follows a different file or is not
  running.
  """
  @spec sent_events(GenServer.server(), Path.t()) :: {:ok, [SentFiles.event()]} | :miss
  def sent_events(server \\ __MODULE__, path) do
    GenServer.call(server, {:sent_events, path}, @read_timeout_ms)
  catch
    :exit, _ -> :miss
  end

  @doc """
  `Shuttle.WaitingTracker.phases/2` of the published waiting map, at the
  stream's clock: `session => %{last_event_at: ms, phase: phase}` over every
  tracked `*-shuttle` session. An ETS read, never a call, so it answers at once
  even while the stream is mid-reseed. A stream that is not running is `%{}`.
  """
  @spec session_activity(atom()) ::
          %{optional(String.t()) => %{last_event_at: integer(), phase: String.t()}}
  def session_activity(server \\ __MODULE__) when is_atom(server) do
    case :ets.lookup(server, :waiting) do
      [{:waiting, waiting, clock}] -> WaitingTracker.phases(waiting, clock.())
      [] -> %{}
    end
  rescue
    # No table: the stream is not running under this name.
    ArgumentError -> %{}
  end

  @doc "The file this stream follows — for tests and diagnostics."
  @spec events_file(GenServer.server()) :: Path.t() | nil
  def events_file(server \\ __MODULE__) do
    GenServer.call(server, :events_file)
  catch
    :exit, _ -> nil
  end

  @doc """
  One line decoded, or `nil` for a blank, malformed or non-object line. The
  one decode every reader of the stream goes through.
  """
  @spec decode(String.t()) :: map() | nil
  def decode(line) do
    case Jason.decode(line) do
      {:ok, event} when is_map(event) -> event
      _ -> nil
    end
  end

  @doc """
  Every event of the rotated sibling of `live` and then of `live`, folded onto
  `acc` with `fun.(event, acc)` in file order and streamed rather than
  slurped. A missing file contributes nothing; a file that vanishes or becomes
  unreadable mid-read contributes nothing either. This is what a reader does
  on a `:miss`.
  """
  @spec fold_files(Path.t(), acc, (map(), acc -> acc)) :: acc when acc: term()
  def fold_files(live, acc, fun) do
    acc
    |> fold_file(rotated(live), fun)
    |> fold_file(live, fun)
  end

  defp fold_file(acc, path, fun) do
    if File.regular?(path) do
      path
      |> File.stream!()
      |> Enum.reduce(acc, fn line, acc ->
        case decode(line) do
          nil -> acc
          event -> fun.(event, acc)
        end
      end)
    else
      acc
    end
  rescue
    # A rotation racing this read. Keep what came before this file, but leave
    # a trace: a silently-swallowed read is otherwise indistinguishable from a
    # genuinely quiet hour.
    error ->
      Logger.debug("event stream: skipped #{path} — #{Exception.message(error)}")
      acc
  end

  @doc """
  Logs that the stream could not answer a `label` read for `path` and its
  caller is re-reading the files itself — at most once a minute per label, and
  only for this host's own stream (a fixture path misses by design).

  A miss is correct but costs a full read of a stream that reaches tens of
  megabytes, the very cost this process exists to remove. Three unrelated
  conditions collapse into it: the stream follows a different path, it is not
  running, or the call timed out. Unlogged, a daemon in any of those states
  looks exactly like one where the stream never helped, which on a CPU-capped
  host is the worst thing to have to diagnose from load alone. The limit is
  there because a miss repeats on every poll by construction.
  """
  @spec warn_miss(String.t(), Path.t()) :: :ok
  def warn_miss(label, path) do
    now = System.monotonic_time(:millisecond)
    key = {__MODULE__, :last_miss_log, label}
    last = :persistent_term.get(key, nil)

    if path == default_events_file() and (is_nil(last) or now - last >= @miss_log_interval_ms) do
      :persistent_term.put(key, now)

      Logger.warning(
        "#{label}: event stream miss for #{path}; re-reading the whole file. " <>
          "Check that #{inspect(__MODULE__)} is running and following this path."
      )
    end

    :ok
  end

  # ── Server ──

  @impl true
  def init(opts) do
    # Named after the server so each stream (tests run several) publishes to
    # its own table; ETS names do not collide with registered process names.
    table =
      :ets.new(Keyword.get(opts, :name, __MODULE__), [
        :named_table,
        :protected,
        read_concurrency: true
      ])

    state = %State{
      table: table,
      events_file: Keyword.get(opts, :events_file, default_events_file()),
      poll_interval_ms: Keyword.get(opts, :poll_interval_ms, @poll_interval_ms),
      clock: Keyword.get(opts, :clock, fn -> System.system_time(:millisecond) end),
      seed_hook: Keyword.get(opts, :seed_hook, fn -> :ok end)
    }

    state = seed(state)
    schedule_poll(state.poll_interval_ms)
    {:ok, publish(state)}
  end

  @impl true
  def handle_call({:slice, path, from_ms, to_ms}, _from, %State{events_file: path} = state) do
    state = state |> follow() |> publish()
    {:reply, {:ok, Activity.slice(state.activity, from_ms, to_ms)}, state}
  end

  def handle_call({:sent_events, path}, _from, %State{events_file: path} = state) do
    state = state |> follow() |> publish()
    events = Enum.reverse(state.sent_rotated, Enum.reverse(state.sent_live))
    {:reply, {:ok, events}, state}
  end

  def handle_call({:slice, _other, _from_ms, _to_ms}, _from, state), do: {:reply, :miss, state}

  def handle_call({:sent_events, _other}, _from, state), do: {:reply, :miss, state}

  def handle_call(:events_file, _from, state), do: {:reply, state.events_file, state}

  @impl true
  def handle_info(:poll, state) do
    state = follow(state)
    state = %{state | waiting: WaitingTracker.prune(state.waiting, state.clock.())}
    schedule_poll(state.poll_interval_ms)
    {:noreply, publish(state)}
  end

  def handle_info(_msg, state), do: {:noreply, state}

  # ── Following the file ──

  # Both files from scratch into empty projections, as a consistent pair — see
  # the moduledoc's "Seed, then follow".
  defp seed(%State{events_file: path} = state) do
    {lines, offset, inode} = FileTail.snapshot(path)
    state.seed_hook.()
    now = state.clock.()

    empty = %{state | activity: Activity.new_acc(), sent_rotated: [], sent_live: [], waiting: %{}}
    from_rotated = fold_file(empty, rotated(path), &ingest_event(&2, &1, now))

    if inode != nil and FileTail.inode(rotated(path)) == inode do
      seed(state)
    else
      state = ingest(%{from_rotated | sent_rotated: from_rotated.sent_live, sent_live: []}, lines)
      waiting = WaitingTracker.prune(state.waiting, now)
      settle(%{state | offset: offset, inode: inode, waiting: waiting})
    end
  end

  # A rebuild from the two files that keeps what the waiting map already knew.
  defp reseed(%State{waiting: known} = state) do
    state = seed(state)
    %{state | waiting: WaitingTracker.merge_known(known, state.waiting)}
  end

  defp follow(%State{events_file: path, inode: followed} = state) do
    case FileTail.inode(path) do
      # The live file is momentarily absent between a rotation's rename and the
      # next append, or has never existed.
      nil -> state
      ^followed -> append(state)
      inode when is_nil(followed) -> append(%{state | inode: inode})
      _moved -> rotate(state)
    end
  end

  defp append(%State{events_file: path, offset: offset} = state) do
    case FileTail.advance(path, offset) do
      {:append, lines, new_offset} ->
        %{ingest(state, lines) | offset: new_offset}

      {:reset, _size} ->
        Logger.info("event stream: #{path} shrank in place; rebuilding from both files")
        reseed(state)

      :noop ->
        state
    end
  end

  defp rotate(%State{events_file: path, inode: followed, offset: offset} = state) do
    rotated = rotated(path)

    if FileTail.inode(rotated) == followed do
      # The old live file's last bytes finish its segment, which becomes the
      # rotated one; the segment the overwritten `.1` held is gone.
      state = ingest(state, FileTail.drain(rotated, offset))

      state = %{
        state
        | activity: Activity.drop_before(state.activity, Activity.first_timestamp(rotated)),
          sent_rotated: state.sent_live,
          sent_live: []
      }

      # The inode comes from the open file, so it names the file these lines
      # came from even if another rotation lands mid-read.
      {lines, new_offset, inode} = FileTail.snapshot(path)
      settle(%{ingest(state, lines) | offset: new_offset, inode: inode})
    else
      Logger.info("event stream: #{path} was replaced by a file it cannot follow; rebuilding")
      reseed(state)
    end
  end

  # Lines of the live file, in file order, decoded once and handed to every
  # projection.
  defp ingest(state, lines) do
    now = state.clock.()

    Enum.reduce(lines, state, fn line, state ->
      case decode(line) do
        nil -> state
        event -> ingest_event(state, event, now)
      end
    end)
  end

  defp ingest_event(state, event, now) do
    %{
      state
      | activity: Activity.fold_event(state.activity, event),
        sent_live: Enum.reverse(SentFiles.project(event), state.sent_live),
        waiting: WaitingTracker.apply_event(state.waiting, event, now)
    }
  end

  # A seed or a rotation reads a whole file into one binary; collect now rather
  # than carry it until the heap next fills.
  defp settle(state) do
    :erlang.garbage_collect()
    state
  end

  defp schedule_poll(ms), do: Process.send_after(self(), :poll, ms)

  # The waiting map `session_activity/1` reads, with the clock its phases are
  # read against. Written only when the map changed.
  defp publish(%State{waiting: waiting, published: waiting} = state), do: state

  defp publish(%State{table: table, waiting: waiting, clock: clock} = state) do
    :ets.insert(table, {:waiting, waiting, clock})
    %{state | published: waiting}
  end
end
