defmodule Shuttle.InterruptWatcher do
  @moduledoc """
  Writes the `interrupted` events no harness hook reports.

  When the human interrupts a turn, neither Claude Code nor Codex fires a hook,
  so `Shuttle.WaitingTracker` would hold that turn open forever. Each harness
  does record the interrupt in its own transcript: Claude Code as a user entry
  whose text opens `[Request interrupted by user`, Codex as an `event_msg` of
  type `turn_aborted`.

  Every few seconds this process reads the open turns the event stream
  publishes (`Shuttle.EventStream.open_turns/1`). For each one that has been
  silent for a moment, it reads the tail of that session's transcript. If the
  transcript's last turn record is an interrupt no older than the session's
  last event, it shells `shuttle hook interrupted`. That appends the interrupt
  to the stream through the same writer the hooks use, and the tracker folds
  it like any other line. The stream stays the only input to the tracker, and
  a replay of it reaches the same turn.

  A transcript is read again only after it has grown, so an idle host costs
  one `stat` per open turn per tick.
  """

  use GenServer

  require Logger

  alias Shuttle.{EventStream, Transcript}

  @interval_ms 5_000
  @quiet_ms 3_000
  @tail_bytes 256 * 1024

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @impl true
  def init(opts) do
    state = %{
      stream: Keyword.get(opts, :stream, EventStream),
      path: Keyword.get(opts, :path, &Transcript.path/1),
      emit: Keyword.get(opts, :emit, &emit/3),
      clock: Keyword.get(opts, :clock, fn -> System.system_time(:millisecond) end),
      interval_ms: Keyword.get(opts, :interval_ms, @interval_ms),
      quiet_ms: Keyword.get(opts, :quiet_ms, @quiet_ms),
      # session => %{path: path | nil, size: bytes read at, emitted: record id}
      seen: %{}
    }

    schedule(state.interval_ms)
    {:ok, state}
  end

  @impl true
  def handle_info(:tick, state) do
    state = scan(state)
    schedule(state.interval_ms)
    {:noreply, state}
  end

  def handle_info(_msg, state), do: {:noreply, state}

  @doc false
  # One pass over the open turns. Public for tests through `send(pid, :tick)`.
  def scan(state) do
    open = EventStream.open_turns(state.stream)
    now = state.clock.()

    seen =
      open
      |> Enum.filter(fn {_id, turn} ->
        Shuttle.Harness.call(turn.harness, :interrupts?, [], false) and
          now - turn.at >= state.quiet_ms
      end)
      |> Enum.reduce(Map.take(state.seen, Map.keys(open)), fn {id, turn}, seen ->
        Map.put(seen, id, check(state, id, turn, Map.get(seen, id, %{})))
      end)

    %{state | seen: seen}
  end

  defp check(state, id, turn, memo) do
    path = memo[:path] || state.path.(id)
    memo = Map.merge(%{size: nil, emitted: nil}, memo) |> Map.put(:path, path)

    case is_binary(path) && Shuttle.FS.stat(path) do
      {:ok, %{size: size}} when size != memo.size ->
        case interrupt(tail(path, size), turn.harness) do
          {record, at} when at >= turn.at and record != memo.emitted ->
            case state.emit.(id, turn.harness, {record, at}) do
              :ok -> %{memo | size: size, emitted: record}
              {:error, _} -> memo
            end

          _ ->
            %{memo | size: size}
        end

      _ ->
        memo
    end
  end

  defp tail(path, size) do
    offset = max(size - @tail_bytes, 0)

    case Shuttle.FS.open(path, [:read, :binary], &Shuttle.FS.pread(&1, offset, size - offset)) do
      {:ok, {:ok, bytes}} -> bytes
      _ -> ""
    end
  end

  @doc """
  The interrupt that ends a transcript tail, as `{record_id, at_ms}`, or `nil`
  when its last turn record is anything else. `harness` is the stream's
  harness name; its module reads each record (`Shuttle.Harness.turn_record/1`).
  """
  @spec interrupt(binary(), String.t()) :: {String.t(), integer()} | nil
  def interrupt(bytes, harness) do
    bytes
    |> String.split("\n")
    |> Enum.reverse()
    |> Enum.find_value(:none, fn line ->
      case Jason.decode(line) do
        {:ok, %{} = record} -> Shuttle.Harness.call(harness, :turn_record, [record], nil)
        _ -> nil
      end
    end)
    |> case do
      {:interrupted, record, at} -> {record, at}
      _ -> nil
    end
  end

  @doc "A turn record for an interrupt at `timestamp`, or `:other` when the time is unreadable."
  def interrupted(record, timestamp) when is_binary(timestamp) do
    case DateTime.from_iso8601(timestamp) do
      {:ok, at, _offset} -> {:interrupted, record, DateTime.to_unix(at, :millisecond)}
      _ -> :other
    end
  end

  def interrupted(_record, _timestamp), do: :other

  defp emit(session, harness, {record, at}) do
    args = [
      "hook",
      "interrupted",
      "--session",
      session,
      "--harness",
      Shuttle.Harness.normalize(harness),
      "--id",
      record,
      "--at",
      Integer.to_string(at)
    ]

    case Shuttle.CLI.run(args) do
      {:ok, _} ->
        Logger.info("interrupt watcher: #{session} was interrupted; recorded on the stream")

      other ->
        Logger.warning(
          "interrupt watcher: recording #{session}'s interrupt failed: #{inspect(other)}"
        )

        {:error, other}
    end
  end

  defp schedule(ms), do: Process.send_after(self(), :tick, ms)
end
