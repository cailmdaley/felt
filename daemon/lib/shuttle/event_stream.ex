defmodule Shuttle.EventStream do
  @moduledoc """
  The one reader of this host's hook-event stream (`~/.shuttle/events.jsonl`)
  and its rotated sibling `events.jsonl.1`. It reads each line once, decodes it
  once, and hands the decoded event to five pure projections it holds in
  memory:

    * `Shuttle.Activity` — the per-minute activity fold behind
      `GET /api/v1/activity`;
    * `Shuttle.SentFiles` — the sent-file events behind `/api/v1/sent-files`;
    * `Shuttle.WaitingTracker` — explicit turn state per harness session UUID,
      stamped onto running cards as `last_event_at` and `phase`;
    * `Shuttle.SessionBinding` — receiver-process succession joining the
      worker's persisted UUID to its current harness session;
    * `Shuttle.Board` — retained board records keyed by id.

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
    * the waiting machine and receiver succession projection carry on.

  Anything else — the live file shrinking in place, or replaced by a file the
  stream cannot account for — rebuilds every projection from the two files.
  The waiting and binding maps keep what they already knew across that rebuild.
  Retained turn events replay onto remembered facts, rather than replacing a
  whole session with an incomplete reconstruction (`Shuttle.WaitingTracker.replay_events/3`).

  ## Reads

  `slice/3`, `sent_events/1` and `board_records/1` follow the file before they
  answer, so a read sees everything written before the request with no polling
  latency; between ticks that costs two `stat`s. They are the only way into the
  projections: nothing else reads the stream, so a stream that is down makes
  its readers fail loudly rather than quietly re-reading tens of megabytes.

  `session_activity/1` never enters this process's mailbox: the stream
  publishes compact phase and open-turn maps to a protected ETS table named
  after the server whenever a poll, catch-up read or seed settles.
  Readers copy only the projection they need, without its retained event history.
  The poller calls it inside the owner-feed request, which must
  wait neither on the filesystem nor behind a full reseed of a shrunken file.
  It is as fresh as the last poll, catch-up read or seed to complete.
  """

  use GenServer

  require Logger

  alias Shuttle.{Activity, Board, FileTail, SentFiles, WaitingTracker, SessionBinding}

  @poll_interval_ms 1_000
  # A catch-up read that lands during a reseed waits for it; the seed of a
  # full 64 MB pair takes a few seconds on a loaded host.
  @read_timeout_ms 30_000

  defmodule State do
    @moduledoc false
    # `offset` and `inode` describe how far into which live file the
    # projections have read. `sent_rotated` and `sent_live` hold the sent-file
    # events of `.1` and of the live file, each newest-first so that ingest is
    # a prepend. `seed_hook` runs between reading the live file and reading the
    # rotated one — the window a racing rotation lands in. Tests rotate there.
    # `clock` returns epoch ms; the waiting projection prunes and reads by it.
    # `table` holds compact reader projections; `published` tracks which
    # waiting and binding maps produced them.
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
      board_rotated: %{},
      board_live: %{},
      waiting: %{},
      seed_events: nil,
      binding: SessionBinding.new()
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
  `~/.shuttle/events.jsonl`. `internal/shuttlecli/events.go` mirrors this resolver
  exactly; `internal/shuttlecli/hook_event.go` writes the lines.
  """
  @spec default_events_file() :: Path.t()
  def default_events_file do
    Shuttle.state_path("SHUTTLE_EVENTS_FILE", "events.jsonl")
  end

  @doc "The rotated sibling of `live`, named exactly as the writer names it."
  @spec rotated(Path.t()) :: Path.t()
  def rotated(live), do: live <> ".1"

  @doc "The activity buckets for the canonical window of `from_ms..to_ms`, after catching up."
  @spec slice(GenServer.server(), integer(), integer()) :: [Activity.bucket()]
  def slice(server \\ __MODULE__, from_ms, to_ms),
    do: call(server, {:slice, from_ms, to_ms})

  @doc "The sent-file events of both files, oldest first, after catching up."
  @spec sent_events(GenServer.server()) :: [SentFiles.event()]
  def sent_events(server \\ __MODULE__),
    do: call(server, :sent_events)

  @doc "The retained board records, after catching up."
  @spec board_records(GenServer.server()) :: %{optional(String.t()) => map()}
  def board_records(server \\ __MODULE__),
    do: call(server, :board_records)

  @doc """
  The published phase map: `session => %{last_event_at: ms, phase: phase}` over every
  tracked harness session UUID. An ETS read, never a call, so it answers at once
  even while the stream is mid-reseed. A stream that is not running is `%{}`.
  """
  @spec session_activity(atom()) ::
          %{optional(String.t()) => %{last_event_at: integer(), phase: String.t()}}
  def session_activity(server \\ __MODULE__) when is_atom(server) do
    case :ets.lookup(server, :activity) do
      [{:activity, phases}] -> phases
      [] -> %{}
    end
  rescue
    # No table: the stream is not running under this name.
    ArgumentError -> %{}
  end

  @doc "Catch up from the durable hook stream before reading one session's turn phase."
  @spec catch_up_session_phase(String.t(), atom()) :: String.t() | nil
  def catch_up_session_phase(session_id, server \\ __MODULE__) when is_binary(session_id) do
    call(server, {:session_phase, session_id})
  catch
    :exit, _ -> nil
  end

  @doc """
  The sessions whose turn is open, as `session => %{at: ms, harness: name}`.
  An ETS read like `session_activity/1`; a stream that is not running is `%{}`.
  """
  @spec open_turns(atom()) :: %{
          optional(String.t()) => %{at: integer(), harness: String.t() | nil}
        }
  def open_turns(server \\ __MODULE__) when is_atom(server) do
    case :ets.lookup(server, :open_turns) do
      [{:open_turns, turns}] -> turns
      [] -> %{}
    end
  rescue
    ArgumentError -> %{}
  end

  @doc "Receiver succession projection, read without entering the stream mailbox."
  def session_bindings(server \\ __MODULE__) do
    case :ets.lookup(server, :binding) do
      [{:binding, binding}] -> binding
      [] -> SessionBinding.new()
    end
  rescue
    ArgumentError -> SessionBinding.new()
  end

  # A test may run its own stream in place of the application's.
  defp call(server, request),
    do: GenServer.call(Shuttle.Env.server(server), request, @read_timeout_ms)

  @doc "One line decoded, or `nil` for a blank, malformed or non-object line."
  @spec decode(String.t()) :: map() | nil
  def decode(line) do
    case Jason.decode(line) do
      {:ok, event} when is_map(event) -> event
      _ -> nil
    end
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
  def handle_call({:slice, from_ms, to_ms}, _from, state) do
    state = state |> follow() |> publish()
    {:reply, Activity.slice(state.activity, from_ms, to_ms), state}
  end

  def handle_call(:sent_events, _from, state) do
    state = state |> follow() |> publish()
    {:reply, Enum.reverse(state.sent_rotated, Enum.reverse(state.sent_live)), state}
  end

  def handle_call(:board_records, _from, state) do
    state = state |> follow() |> publish()
    records = state.board_rotated |> Map.merge(state.board_live) |> Board.prune(state.clock.())
    {:reply, records, state}
  end

  def handle_call({:session_phase, session_id}, _from, state) do
    state = state |> follow() |> publish()
    phases = WaitingTracker.phases(state.waiting, state.clock.())

    phase =
      if WaitingTracker.cut_off?(state.waiting, session_id),
        do: "working",
        else: Map.get(phases, session_id, %{})[:phase]

    {:reply, phase, state}
  end

  @impl true
  def handle_info(:poll, state) do
    state = follow(state)

    state = %{
      state
      | board_rotated: Board.prune(state.board_rotated, state.clock.()),
        board_live: Board.prune(state.board_live, state.clock.()),
        waiting: WaitingTracker.prune(state.waiting, state.clock.()),
        binding: SessionBinding.prune(state.binding, state.clock.())
    }

    schedule_poll(state.poll_interval_ms)
    {:noreply, publish(state)}
  end

  def handle_info(_msg, state), do: {:noreply, state}

  # ── Following the file ──

  # Read a consistent pair, rebuilding file projections while turn events
  # replay onto known facts. See the moduledoc's "Seed, then follow".
  defp seed(%State{events_file: path} = state, binding \\ SessionBinding.new(), known \\ %{}) do
    {lines, offset, inode} = FileTail.snapshot(path)
    state.seed_hook.()
    now = state.clock.()

    empty = %{
      state
      | activity: Activity.new_acc(),
        sent_rotated: [],
        sent_live: [],
        board_rotated: %{},
        board_live: %{},
        waiting: known,
        seed_events: [],
        binding: binding
    }

    from_rotated = fold_file(empty, rotated(path), &ingest_event(&2, &1, now))

    if inode != nil and FileTail.inode(rotated(path)) == inode do
      seed(state, binding, known)
    else
      state =
        ingest(
          %{
            from_rotated
            | sent_rotated: from_rotated.sent_live,
              sent_live: [],
              board_rotated: from_rotated.board_live,
              board_live: %{}
          },
          lines
        )

      waiting =
        known
        |> WaitingTracker.replay_events(Enum.reverse(state.seed_events), now)
        |> WaitingTracker.prune(now)

      settle(%{
        state
        | offset: offset,
          inode: inode,
          waiting: waiting,
          seed_events: nil,
          binding: SessionBinding.prune(state.binding, now),
          board_rotated: Board.prune(state.board_rotated, now),
          board_live: Board.prune(state.board_live, now)
      })
    end
  end

  # Every event of `path`, folded in file order and streamed rather than slurped.
  defp fold_file(acc, path, fun) do
    if Shuttle.FS.regular?(path) do
      path
      |> Shuttle.FS.stream!()
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

  # A rebuild from the two files that keeps what the waiting map already knew.
  defp reseed(%State{waiting: known, binding: binding} = state) do
    seed(state, binding, known)
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
          sent_live: [],
          board_rotated: state.board_live,
          board_live: %{}
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
    binding = SessionBinding.apply_event(state.binding, event, now)

    state =
      if SessionBinding.accept_event?(binding, event) do
        case state.seed_events do
          nil -> %{state | waiting: WaitingTracker.apply_event(state.waiting, event, now)}
          events -> %{state | seed_events: [event | events]}
        end
      else
        state
      end

    %{
      state
      | activity: Activity.fold_event(state.activity, event),
        sent_live: Enum.reverse(SentFiles.project(event), state.sent_live),
        board_live: Board.fold(state.board_live, event),
        binding: binding
    }
  end

  # A seed or a rotation reads a whole file into one binary; collect now rather
  # than carry it until the heap next fills.
  defp settle(state) do
    :erlang.garbage_collect()
    state
  end

  defp schedule_poll(ms), do: Process.send_after(self(), :poll, ms)

  # Publish reader-sized projections only when the underlying maps change.
  # Event histories stay in this process, rather than being copied out of ETS
  # on every poller and interrupt-watcher read.
  defp publish(%State{waiting: waiting, binding: binding, published: {waiting, binding}} = state),
    do: state

  defp publish(%State{table: table, waiting: waiting, binding: binding, clock: clock} = state) do
    phases = WaitingTracker.phases(waiting, clock.())

    turns =
      for {id, %{turn: :open} = session} <- waiting,
          into: %{},
          do: {id, %{at: session.at, harness: session.harness}}

    :ets.insert(table, [{:activity, phases}, {:open_turns, turns}, {:binding, binding}])
    %{state | published: {waiting, binding}}
  end
end
