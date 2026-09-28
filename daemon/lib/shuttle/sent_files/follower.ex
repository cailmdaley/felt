defmodule Shuttle.SentFiles.Follower do
  @moduledoc """
  Holds this host's projected sent-file events in memory and follows
  `events.jsonl` forward, so `Shuttle.SentFiles` never rescans a 50 MB stream to
  answer a poll. See that module's "No PERSISTED index" section for why an
  in-memory projection is sound where a written index would not be.

  Seed the whole file once at boot, then read only the bytes appended since —
  on a timer, and again on each read. The mechanics are `Shuttle.FileTail`'s,
  shared with `Shuttle.WaitingTracker`.
  The projection is the parsed events in **file order**; `Shuttle.SentFiles`
  applies the fiber match, the ledger `uid` join, the dedupe and the window at
  read time, because those depend on inputs that change independently of this
  file.

  ## Truncation rebuilds; rotation is not followed

  Only the live file is ever read. On a shrink the projection is rebuilt from
  the live file alone, which reproduces the old full-scan behavior exactly: a
  trail that rolled over to `events.jsonl.1` is gone. Retaining across rotation
  is now *possible* — the events are in memory — but it would be a behavior
  change, and it is not this module's to make.

  ## Reads are a plain `GenServer.call`, and they catch up first

  A read follows the file before it answers, so it sees everything written
  before the request — exactly as fresh as the rescan it replaces, with no
  polling latency between a `send-file` and the board showing it. Between ticks
  that costs one `stat`. A dozen calls a minute returning a couple hundred
  entries does not need concurrent reads. If reads ever do get hot, the escape
  hatch is an ETS table owned by this process (`read_concurrency: true`) that
  callers read directly, leaving this GenServer as the writer only.

  `events/2` answers only for the path it is actually following; any other path
  is a `:miss` and the caller reads that file itself. That is what keeps an
  injected fixture — or a crashed follower — correct rather than silently served
  stale.
  """

  use GenServer

  alias Shuttle.{FileTail, SentFiles}

  @poll_interval_ms 1_000

  defmodule State do
    @moduledoc false
    # `events` is the projection in REVERSE file order (newest first) so that
    # ingesting appended lines is a prepend; `events/2` reverses on the way out.
    defstruct [:events_file, :poll_interval_ms, offset: 0, events: []]
  end

  # ── Client ──

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @doc """
  The projected events for `path`, oldest-first — or `:miss` if this follower
  is following a different file or is not running.
  """
  @spec events(GenServer.server(), Path.t()) :: {:ok, [SentFiles.event()]} | :miss
  def events(server \\ __MODULE__, path) do
    GenServer.call(server, {:events, path})
  catch
    :exit, _ -> :miss
  end

  @doc "The file this follower is following — for tests and diagnostics."
  @spec events_file(GenServer.server()) :: Path.t() | nil
  def events_file(server \\ __MODULE__) do
    GenServer.call(server, :events_file)
  catch
    :exit, _ -> nil
  end

  # ── Server ──

  @impl true
  def init(opts) do
    events_file = Keyword.get(opts, :events_file, SentFiles.default_events_file())
    poll_interval_ms = Keyword.get(opts, :poll_interval_ms, @poll_interval_ms)

    {events, offset} = seed(events_file)
    schedule_poll(poll_interval_ms)

    {:ok,
     %State{
       events_file: events_file,
       poll_interval_ms: poll_interval_ms,
       offset: offset,
       events: events
     }}
  end

  @impl true
  def handle_call({:events, path}, _from, %State{events_file: path} = state) do
    # Catch up BEFORE replying, so a read is exactly as fresh as a rescan was:
    # everything written before the request is in the answer, with no wait for
    # the next tick. Costs one `stat` when nothing was appended, which is the
    # usual case between ticks.
    state = follow(state)
    {:reply, {:ok, Enum.reverse(state.events)}, state}
  end

  def handle_call({:events, _other}, _from, state), do: {:reply, :miss, state}

  def handle_call(:events_file, _from, state), do: {:reply, state.events_file, state}

  @impl true
  def handle_info(:poll, state) do
    state = follow(state)
    schedule_poll(state.poll_interval_ms)
    {:noreply, state}
  end

  def handle_info(_msg, state), do: {:noreply, state}

  # Read whatever has been appended since the last offset. A shrink means
  # truncation or rotation: rebuild from the live file, which is exactly what
  # the old full rescan would have seen — the rolled-over trail is gone.
  defp follow(%State{events_file: path, offset: offset} = state) do
    case FileTail.advance(path, offset) do
      {:append, lines, new_offset} ->
        %{state | offset: new_offset, events: prepend(lines, state.events)}

      {:reset, _size} ->
        {events, new_offset} = seed(path)
        %{state | offset: new_offset, events: events}

      :noop ->
        state
    end
  end

  # Whole-file pass, returning the projection in reverse file order plus the
  # offset to resume from. A missing or unreadable file seeds empty and is
  # picked up by a later poll — it must never fail the boot.
  defp seed(path) do
    {lines, offset} = FileTail.seed(path)
    {prepend(lines, []), offset}
  end

  # Fold lines (in file order) onto a reverse-order projection.
  defp prepend(lines, events) do
    Enum.reduce(lines, events, fn line, acc ->
      case SentFiles.parse_line(line) do
        [] -> acc
        parsed -> Enum.reduce(parsed, acc, &[&1 | &2])
      end
    end)
  end

  defp schedule_poll(ms), do: Process.send_after(self(), :poll, ms)
end
