defmodule Shuttle.Meeting.TranscriptRelay do
  @moduledoc false
  use GenServer

  require Logger

  @poll_ms 5_000
  @batch_lines 30
  @state_file "meeting-transcript-relay.json"

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @doc "Start forwarding transcript batches for a joined meeting."
  def start(row, fiber_id, origin, opts \\ []) do
    server = Keyword.get(opts, :server, __MODULE__)
    GenServer.call(server, {:start, row, fiber_id, origin})
  end

  @impl true
  def init(opts) do
    file = Keyword.get(opts, :file, Path.join(Shuttle.data_dir(), @state_file))

    state = %{
      file: file,
      config: read_config(file),
      poll_ms: Keyword.get(opts, :poll_ms, @poll_ms),
      deliver: Keyword.get(opts, :deliver, &deliver/1),
      observe: Keyword.get(opts, :observe, &observe/0)
    }

    schedule(state.poll_ms)
    {:ok, state}
  end

  @impl true
  def handle_call({:start, row, fiber_id, origin}, _from, state) do
    config = %{
      "launch" => value(row, :launch),
      "fiber_id" => fiber_id,
      "origin" => origin,
      "transcript" => value(row, :transcript),
      "title" =>
        value(row, :title) || Path.basename(value(row, :transcript) || "meeting.txt", ".txt"),
      "offset" => 0
    }

    if Enum.all?(
         [config["launch"], config["fiber_id"], config["transcript"]],
         &(is_binary(&1) and &1 != "")
       ) do
      case write_config(state.file, config) do
        :ok -> {:reply, :ok, %{state | config: config}}
        {:error, reason} -> {:reply, {:error, reason}, state}
      end
    else
      {:reply, {:error, :invalid_meeting}, state}
    end
  end

  @impl true
  def handle_info(:poll, %{config: nil} = state) do
    schedule(state.poll_ms)
    {:noreply, state}
  end

  def handle_info(:poll, state) do
    {state, outcome} = poll(state)

    case outcome do
      :retry -> :ok
      {:sent, count} -> Logger.debug("meeting transcript relay sent #{count} lines")
      :ended -> Logger.info("meeting transcript relay ended")
    end

    schedule(state.poll_ms)
    {:noreply, state}
  end

  defp poll(state) do
    config = state.config

    case config["pending"] do
      pending when is_map(pending) ->
        send_pending(state, config, pending)

      nil ->
        observed = state.observe.()

        case read_batch(config["transcript"], config["offset"]) do
          {:ok, lines, offset, ended} when lines != [] ->
            text =
              "Meeting transcript update (#{config["title"]}):\n" <>
                Enum.join(lines, "\n") <> "\n"

            prepare_batch(state, config, text, offset, ended, length(lines))

          {:ok, [], _offset, false} ->
            case meeting_end(config, observed) do
              :active ->
                {state, :retry}

              {:ended, reason} ->
                text = "Meeting transcript for #{config["title"]} ended#{reason}.\n# ended\n"
                prepare_batch(state, config, text, config["offset"], true, 0)
            end

          {:ok, [], _offset, true} ->
            {finish(state), :ended}

          {:error, :transcript_replaced} ->
            prepare_batch(
              state,
              config,
              "Meeting transcript for #{config["title"]} was interrupted when its file changed.\n# ended\n",
              config["offset"],
              true,
              0
            )

          {:error, _reason} ->
            case meeting_end(config, observed) do
              :active ->
                {state, :retry}

              {:ended, reason} ->
                text = "Meeting transcript for #{config["title"]} ended#{reason}.\n# ended\n"
                prepare_batch(state, config, text, config["offset"], true, 0)
            end
        end
    end
  end

  defp meeting_end(config, {:ok, %{meeting: %{launch: launch, state: phase, error: error}}}) do
    cond do
      launch != config["launch"] ->
        {:ended, " (capture was replaced before completion)"}

      phase in ["failed", "ended"] ->
        detail = if error, do: ": " <> to_string(error), else: ""
        {:ended, " (capture #{phase}#{detail})"}

      true ->
        :active
    end
  end

  defp meeting_end(_config, {:ok, %{meeting: nil}}), do: {:ended, ""}
  defp meeting_end(_config, _observation), do: :active

  defp prepare_batch(state, config, text, offset, ended, count) do
    pending = %{
      "text" => text,
      "offset" => offset,
      "ended" => ended,
      "count" => count,
      "message_id" => message_id(config["launch"], config["offset"], offset, ended)
    }

    next = Map.put(config, "pending", pending)

    case write_config(state.file, next) do
      :ok -> send_pending(%{state | config: next}, next, pending)
      {:error, _reason} -> {state, :retry}
    end
  end

  defp send_pending(state, config, pending) do
    case state.deliver.(%{
           fiber_id: config["fiber_id"],
           text: pending["text"],
           origin: config["origin"],
           message_id: pending["message_id"]
         }) do
      {status, outcome} when status in 200..299 ->
        if confirmed?(outcome) do
          if pending["ended"] do
            {finish(state), :ended}
          else
            next = config |> Map.put("offset", pending["offset"]) |> Map.delete("pending")

            case write_config(state.file, next) do
              :ok -> {%{state | config: next}, {:sent, pending["count"]}}
              {:error, _reason} -> {state, :retry}
            end
          end
        else
          {state, :retry}
        end

      _ ->
        {state, :retry}
    end
  end

  defp read_batch(path, offset) when is_binary(path) and is_integer(offset) and offset >= 0 do
    with {:ok, contents} <- Shuttle.FS.read(path), true <- byte_size(contents) >= offset do
      remaining = binary_part(contents, offset, byte_size(contents) - offset)

      complete =
        case :binary.matches(remaining, "\n") do
          [] ->
            <<>>

          matches ->
            {position, _length} = List.last(matches)
            binary_part(remaining, 0, position)
        end

      lines = if complete == <<>>, do: [], else: String.split(complete, "\n", trim: false)
      batch = Enum.take(lines, @batch_lines)
      consumed = if batch == [], do: offset, else: offset + byte_size(Enum.join(batch, "\n")) + 1
      ended = Enum.any?(batch, &String.starts_with?(&1, "# ended"))
      {:ok, batch, consumed, ended}
    else
      false -> {:error, :transcript_replaced}
      {:error, _reason} = error -> error
    end
  end

  defp read_batch(_path, _offset), do: {:error, :invalid_transcript}

  defp confirmed?(%{delivered: true}), do: true
  defp confirmed?(%{"delivered" => true}), do: true
  defp confirmed?(_outcome), do: false

  defp deliver(%{fiber_id: fiber_id, text: text, origin: origin, message_id: message_id}) do
    ShuttleWeb.DeliverController.route(fiber_id, text, origin, "shuttle", %{
      "daemon_sender" => true,
      "message_id" => message_id
    })
  end

  defp observe, do: Shuttle.Meeting.show()

  defp finish(state) do
    Shuttle.FS.rm(state.file)
    %{state | config: nil}
  end

  defp message_id(launch, offset, next_offset, ended) do
    digest = :crypto.hash(:sha256, "#{launch}:#{offset}:#{next_offset}:#{ended}")
    "meeting-" <> Base.url_encode64(digest, padding: false)
  end

  defp read_config(file) do
    with {:ok, contents} <- Shuttle.FS.read(file),
         {:ok,
          %{
            "launch" => launch,
            "fiber_id" => fiber_id,
            "transcript" => transcript,
            "offset" => offset
          } = config} <- Jason.decode(contents),
         true <-
           is_binary(launch) and is_binary(fiber_id) and is_binary(transcript) and
             is_integer(offset) and offset >= 0 do
      config
    else
      _ -> nil
    end
  end

  defp write_config(file, config) do
    with :ok <- Shuttle.FS.mkdir_p(Path.dirname(file)),
         :ok <- Shuttle.FS.write_atomic(file, Jason.encode!(config) <> "\n"),
         do: :ok
  end

  defp value(row, key), do: Map.get(row, key) || Map.get(row, Atom.to_string(key))
  defp schedule(ms), do: Process.send_after(self(), :poll, ms)
end
