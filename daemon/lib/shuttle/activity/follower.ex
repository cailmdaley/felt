defmodule Shuttle.Activity.Follower do
  @moduledoc """
  Holds this host's activity fold (`Shuttle.Activity`) in memory and follows
  `events.jsonl` forward, so `GET /api/v1/activity` never rescans a 50 MB
  stream to answer a poll.

  The fold is seeded once from both files — the rotated `events.jsonl.1`
  first, then the live file — and afterwards advanced by only the bytes
  appended since, on a timer and again on each read. The mechanics are
  `Shuttle.FileTail`'s. Because the fold is window-independent, a read is a
  `Shuttle.Activity.slice/3` of the held state.

  The seed runs in `handle_continue/2`, so a boot does not wait on it. A read
  that arrives first waits in the mailbox until the seed is done.

  ## Rotation continues the fold

  `felt hook event` rotates by renaming the live file to `events.jsonl.1` and
  starting a fresh one. The follower recognizes that by the live path's inode
  moving (`Shuttle.FileTail.inode/1`), not by a shrink: when the rotated file
  carries the inode it was following, it folds that file's bytes past the old
  offset (the lines written just before the rename, `Shuttle.FileTail.drain/2`)
  and then the new live file from its start — keeping the spell and pairing
  state, so a waiting spell or a tool call that straddles the rotation reads
  exactly as if no rename had happened.

  The rename overwrites the previous `events.jsonl.1`, so after a rotation the
  follower drops the buckets whose minute precedes the new rotated file's
  first line, the pending tool calls that began before it, and the interned
  identities nothing left refers to (`Shuttle.Activity.drop_before/2`). What
  it serves is what the two files hold, and what it holds stays bounded by
  them. Spell state is kept: it is a handful of identities, and dropping it
  would re-open a spell that is in fact still open.

  Anything else — the live file shrinking in place, or replaced by a file the
  follower cannot account for — rebuilds the fold from the two files.

  ## Reads are a plain `GenServer.call`, and they catch up first

  A read follows the file before it answers, so it sees everything written
  before the request, with no polling latency. Between ticks that costs two
  `stat`s. The slice is computed here and copied to the caller.

  `slice/4` answers only for the path it is actually following; any other path
  is a `:miss` and the caller folds that file itself. That is what keeps an
  injected fixture — or a crashed follower — correct rather than silently
  served stale.
  """

  use GenServer

  require Logger

  alias Shuttle.{Activity, FileTail}

  @poll_interval_ms 1_000
  # A read that lands during the boot seed waits for it; the seed of a full
  # 64 MB pair takes a few seconds on a loaded host.
  @read_timeout_ms 30_000

  defmodule State do
    @moduledoc false
    # `offset` and `inode` describe how far into which live file `acc` has read.
    # `seed_hook` runs between reading the live file and folding the rotated
    # one — the window a racing rotation lands in. Tests rotate there.
    defstruct [:events_file, :poll_interval_ms, :acc, :inode, :seed_hook, offset: 0]
  end

  # ── Client ──

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @doc """
  The buckets for the canonical window of `from_ms..to_ms` over `path` — or
  `:miss` if this follower is following a different file or is not running.
  """
  @spec slice(GenServer.server(), Path.t(), integer(), integer()) ::
          {:ok, [Activity.bucket()]} | :miss
  def slice(server \\ __MODULE__, path, from_ms, to_ms) do
    GenServer.call(server, {:slice, path, from_ms, to_ms}, @read_timeout_ms)
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
    state = %State{
      events_file: Keyword.get(opts, :events_file, Activity.default_events_file()),
      poll_interval_ms: Keyword.get(opts, :poll_interval_ms, @poll_interval_ms),
      seed_hook: Keyword.get(opts, :seed_hook, fn -> :ok end)
    }

    {:ok, state, {:continue, :seed}}
  end

  @impl true
  def handle_continue(:seed, state) do
    state = seed(state)
    schedule_poll(state.poll_interval_ms)
    {:noreply, state}
  end

  @impl true
  def handle_call({:slice, path, from_ms, to_ms}, _from, %State{events_file: path} = state) do
    state = follow(state)
    {:reply, {:ok, Activity.slice(state.acc, from_ms, to_ms)}, state}
  end

  def handle_call({:slice, _other, _from_ms, _to_ms}, _from, state), do: {:reply, :miss, state}

  def handle_call(:events_file, _from, state), do: {:reply, state.events_file, state}

  @impl true
  def handle_info(:poll, state) do
    state = follow(state)
    schedule_poll(state.poll_interval_ms)
    {:noreply, state}
  end

  def handle_info(_msg, state), do: {:noreply, state}

  # Both files from scratch, as a consistent pair: the live file first — its
  # lines, offset and inode all from one open file — then its predecessor. If
  # `.1` now carries the inode just read, a rotation landed in between and
  # `.1` IS that file; folding both would count it twice, so start over. A
  # rotation after `.1` is folded is an ordinary one, and the next poll
  # follows it.
  defp seed(%State{events_file: path} = state) do
    {lines, offset, inode} = FileTail.snapshot(path)
    state.seed_hook.()
    acc = Activity.fold_file(Activity.new_acc(), rotated(path))

    if inode != nil and FileTail.inode(rotated(path)) == inode do
      seed(state)
    else
      settle(%{state | acc: Activity.fold_lines(acc, lines), offset: offset, inode: inode})
    end
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
        %{state | acc: Activity.fold_lines(state.acc, lines), offset: new_offset}

      {:reset, _size} ->
        Logger.info("activity: #{path} shrank in place; refolding both files")
        seed(state)

      :noop ->
        state
    end
  end

  defp rotate(%State{events_file: path, inode: followed, offset: offset} = state) do
    rotated = rotated(path)

    if FileTail.inode(rotated) == followed do
      acc =
        state.acc
        |> Activity.fold_lines(FileTail.drain(rotated, offset))
        |> Activity.drop_before(Activity.first_timestamp(rotated))

      # The inode comes from the open file, so it names the file these lines
      # came from even if another rotation lands mid-read.
      {lines, new_offset, inode} = FileTail.snapshot(path)

      settle(%{
        state
        | acc: Activity.fold_lines(acc, lines),
          offset: new_offset,
          inode: inode
      })
    else
      Logger.info("activity: #{path} was replaced by a file it cannot follow; refolding")
      seed(state)
    end
  end

  # A seed or a rotation reads a whole file into one binary; collect now rather
  # than carry it until the heap next fills.
  defp settle(state) do
    :erlang.garbage_collect()
    state
  end

  defp rotated(path), do: path <> ".1"

  defp schedule_poll(ms), do: Process.send_after(self(), :poll, ms)
end
