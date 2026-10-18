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
        turn.harness in ["claude-code", "codex"] and now - turn.at >= state.quiet_ms
      end)
      |> Enum.reduce(Map.take(state.seen, Map.keys(open)), fn {id, turn}, seen ->
        Map.put(seen, id, check(state, id, turn, Map.get(seen, id, %{})))
      end)

    %{state | seen: seen}
  end

  defp check(state, id, turn, memo) do
    path = memo[:path] || state.path.(id)
    memo = Map.merge(%{size: nil, emitted: nil}, memo) |> Map.put(:path, path)

    case is_binary(path) && File.stat(path) do
      {:ok, %{size: size}} when size != memo.size ->
        memo = %{memo | size: size}

        case interrupt(tail(path, size), turn.harness) do
          {record, at} when at >= turn.at and record != memo.emitted ->
            state.emit.(id, turn.harness, {record, at})
            %{memo | emitted: record}

          _ ->
            memo
        end

      _ ->
        memo
    end
  end

  defp tail(path, size) do
    offset = max(size - @tail_bytes, 0)

    case File.open(path, [:read, :binary], &:file.pread(&1, offset, size - offset)) do
      {:ok, {:ok, bytes}} -> bytes
      _ -> ""
    end
  end

  @doc """
  The interrupt that ends a transcript tail, as `{record_id, at_ms}`, or `nil`
  when its last turn record is anything else. `harness` is the stream's
  harness name, `"claude-code"` or `"codex"`.
  """
  @spec interrupt(binary(), String.t()) :: {String.t(), integer()} | nil
  def interrupt(bytes, harness) do
    bytes
    |> String.split("\n")
    |> Enum.reverse()
    |> Enum.find_value(:none, fn line ->
      case Jason.decode(line) do
        {:ok, %{} = record} -> turn_record(record, harness)
        _ -> nil
      end
    end)
    |> case do
      {:interrupted, record, at} -> {record, at}
      _ -> nil
    end
  end

  # A record that moves the turn: `{:interrupted, id, at}` or `:other`. Anything
  # else (metadata, attachments, side chains) is nil and the search continues.
  defp turn_record(%{"isSidechain" => true}, "claude-code"), do: nil

  defp turn_record(
         %{"type" => "user", "message" => %{"content" => content}} = record,
         "claude-code"
       ) do
    if interrupt_text?(content) and is_binary(record["uuid"]),
      do: interrupted(record["uuid"], record["timestamp"]),
      else: :other
  end

  defp turn_record(%{"type" => "assistant"}, "claude-code"), do: :other

  defp turn_record(
         %{"type" => "event_msg", "payload" => %{"type" => type} = payload} = record,
         "codex"
       ) do
    cond do
      type == "turn_aborted" ->
        interrupted("#{payload["turn_id"]}@#{record["timestamp"]}", record["timestamp"])

      type in ["task_started", "task_complete", "user_message", "agent_message"] ->
        :other

      true ->
        nil
    end
  end

  defp turn_record(_record, _harness), do: nil

  defp interrupt_text?(content) when is_binary(content),
    do: String.starts_with?(content, "[Request interrupted by user")

  defp interrupt_text?([%{"type" => "text", "text" => text} | _]), do: interrupt_text?(text)
  defp interrupt_text?(_content), do: false

  defp interrupted(record, timestamp) when is_binary(timestamp) do
    case DateTime.from_iso8601(timestamp) do
      {:ok, at, _offset} -> {:interrupted, record, DateTime.to_unix(at, :millisecond)}
      _ -> :other
    end
  end

  defp interrupted(_record, _timestamp), do: :other

  defp emit(session, harness, {record, at}) do
    args = [
      "hook",
      "interrupted",
      "--session",
      session,
      "--harness",
      if(harness == "codex", do: "codex", else: "claude"),
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
    end
  end

  defp schedule(ms), do: Process.send_after(self(), :tick, ms)
end
