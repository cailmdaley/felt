defmodule Shuttle.Speaker do
  @moduledoc """
  Speaks lines on this host, one at a time in arrival order, each in the voice of
  its fiber's role. Rendering is pocket-tts; playback is afplay.

  Playback holds while Cail is talking (hark's live voice has pending words
  beyond an echo of the line being spoken) or while the speaker is muted, and resumes from just before where it stopped.
  afplay keeps its clock running under SIGSTOP, so a hold stops the player and a
  resume plays the rest of the file from the held offset.
  """
  use GenServer
  require Logger

  @default_voice "dylan_thomas"
  @tts "http://127.0.0.1:8321"
  @bank "http://127.0.0.1:8322"
  @poll_ms 250
  @rewind_ms 500
  @partial_stale_seconds 10

  def start_link(opts \\ []),
    do: GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))

  def show(opts \\ []), do: GenServer.call(server(opts), :show)
  def mute(muted, opts \\ []), do: GenServer.call(server(opts), {:mute, muted})

  @doc "Queue `text` from `fiber_id`, in `voice` when given, else its role's voice."
  def speak(params, opts \\ []) do
    case params do
      %{"text" => text} when is_binary(text) ->
        text = String.trim(text)
        fiber_id = params["fiber_id"]

        voice =
          case params["voice"] do
            voice when is_binary(voice) and voice != "" -> voice
            _ -> voice_for(fiber_id, opts)
          end

        if text == "",
          do: {:error, "text is empty"},
          else:
            GenServer.call(
              server(opts),
              {:speak, %{fiber_id: fiber_id, text: text, voice: voice}}
            )

      _ ->
        {:error, "text is required"}
    end
  end

  def available?, do: not is_nil(Shuttle.Env.find_executable("afplay"))

  @doc "The voice of the fiber's role: the charter's `voice:`, else #{@default_voice}."
  def voice_for(fiber_id, opts \\ []) do
    fibers = Keyword.get(opts, :fibers, &Shuttle.Meeting.served_fibers/0)
    stores = Keyword.get(opts, :stores, &Shuttle.FeltStores.configured_stores/0)

    role =
      is_binary(fiber_id) &&
        Enum.find_value(fibers.(), fn fiber ->
          if is_map(fiber) and fiber_id in [fiber["uid"], fiber["id"], fiber["slug"]],
            do: get_in(fiber, ["shuttle", "role"])
        end)

    (is_binary(role) && charter_voice(role, stores.())) || @default_voice
  end

  @builtins ~w(alba azelma cosette eponine fantine javert jean marius)

  @doc """
  Every voice this host can speak in, the bank's then pocket-tts's built-ins,
  each with the role whose charter names it (nil when unclaimed).
  """
  def voices(opts \\ []) do
    bank = Keyword.get_lazy(opts, :bank, fn -> Shuttle.Env.expand("~/.claude/voices") end)
    stores = Keyword.get(opts, :stores, &Shuttle.FeltStores.configured_stores/0).()

    claims =
      for store <- stores,
          {:ok, roles} <- [Shuttle.FS.ls(Path.join([store, ".felt", "roles"]))],
          role <- Enum.sort(roles),
          voice = charter_voice(role, [store]),
          into: %{},
          do: {voice, role}

    banked =
      case Shuttle.FS.ls(bank) do
        {:ok, files} ->
          for f <- Enum.sort(files), Path.extname(f) == ".safetensors", do: Path.rootname(f)

        _ ->
          []
      end

    Enum.map(banked, &%{name: &1, kind: "bank", role: claims[&1]}) ++
      Enum.map(@builtins, &%{name: &1, kind: "builtin", role: claims[&1]})
  end

  defp charter_voice(role, stores) do
    Enum.find_value(stores, fn store ->
      case Shuttle.FiberDoc.read_path(Path.join([store, ".felt", "roles", role, role <> ".md"])) do
        {:ok, _path, _raw, %{"voice" => voice}, _body} when is_binary(voice) and voice != "" ->
          voice

        _ ->
          nil
      end
    end)
  end

  defp server(opts), do: Keyword.get(opts, :server, Shuttle.Env.server(__MODULE__))

  @impl true
  def init(opts) do
    Process.flag(:trap_exit, true)

    {:ok,
     %{
       queue: :queue.new(),
       current: nil,
       render: nil,
       muted: false,
       error: nil,
       timer: nil,
       clock: Keyword.get(opts, :clock, fn -> System.monotonic_time(:millisecond) end),
       poll_ms: Keyword.get(opts, :poll_ms, @poll_ms),
       partial: Keyword.get(opts, :partial, &partial/0),
       render_fun: Keyword.get(opts, :render, &render/2),
       play: Keyword.get(opts, :play, &play/1),
       stop: Keyword.get(opts, :stop, &stop/1),
       slice: Keyword.get(opts, :slice, &slice/2)
     }}
  end

  @impl true
  def handle_call(:show, _from, state), do: {:reply, snapshot(state), state}

  def handle_call({:mute, muted}, _from, state) when is_boolean(muted) do
    state = hold_or_play(%{state | muted: muted})
    {:reply, {:ok, snapshot(state)}, state}
  end

  def handle_call({:mute, _}, _from, state),
    do: {:reply, {:error, "muted must be a boolean"}, state}

  def handle_call({:speak, item}, _from, state) do
    ahead = :queue.len(state.queue) + if(state.current || state.render, do: 1, else: 0)
    state = advance(%{state | queue: :queue.in(item, state.queue)})
    {:reply, {:ok, %{voice: item.voice, ahead: ahead}}, state}
  end

  @impl true
  def handle_info({ref, result}, %{render: {%Task{ref: ref}, item}} = state) do
    Process.demonitor(ref, [:flush])
    rendered(state, item, result)
  end

  def handle_info(
        {:DOWN, ref, :process, _pid, reason},
        %{render: {%Task{ref: ref}, item}} = state
      ),
      do: rendered(state, item, {:error, "render exited: #{inspect(reason)}"})

  def handle_info(
        {handle, {:exit_status, status}},
        %{current: %{handle: handle} = current} = state
      ) do
    Logger.info("speaker: afplay exited #{status} for #{current.item.fiber_id || "?"}")
    cleanup(current)
    error = if status == 0, do: state.error, else: "afplay exited #{status}"
    {:noreply, advance(%{state | current: nil, error: error})}
  end

  def handle_info(:poll, state),
    do: {:noreply, hold_or_play(%{state | timer: nil}) |> schedule()}

  def handle_info(_message, state), do: {:noreply, state}

  @impl true
  def terminate(_reason, %{current: %{handle: handle}} = state) when not is_nil(handle),
    do: state.stop.(handle)

  def terminate(_reason, _state), do: :ok

  defp advance(%{current: nil, render: nil} = state) do
    case :queue.out(state.queue) do
      {{:value, item}, queue} ->
        render = state.render_fun

        task =
          Task.Supervisor.async_nolink(Shuttle.TaskSupervisor, fn ->
            render.(item.text, item.voice)
          end)

        %{state | queue: queue, render: {task, item}}

      {:empty, _} ->
        state
    end
  end

  defp advance(state), do: state

  defp rendered(state, item, {:ok, wav}) do
    Logger.info("speaker: rendered #{inspect(item.voice)} for #{item.fiber_id || "?"} to #{wav}")
    current = %{item: item, wav: wav, segment: nil, handle: nil, offset: 0, started: nil}

    {:noreply,
     %{state | render: nil, current: current, error: nil} |> hold_or_play() |> schedule()}
  end

  defp rendered(state, item, {:error, reason}) do
    Logger.warning("speaker: render failed for #{item.fiber_id || "?"}: #{reason}")
    {:noreply, advance(%{state | render: nil, error: reason})}
  end

  # Held: stop the player and keep the offset. Free: play from the offset.
  defp hold_or_play(%{current: nil} = state), do: state

  defp hold_or_play(%{current: current} = state) do
    held = state.muted or talking?(state.partial.(), current.item.text)

    cond do
      held and current.handle ->
        state.stop.(current.handle)
        offset = current.offset + state.clock.() - current.started
        %{state | current: %{current | handle: nil, offset: offset}}

      not held and is_nil(current.handle) ->
        start(state, current)

      true ->
        state
    end
  end

  defp start(state, current) do
    from = if current.offset == 0, do: 0, else: max(current.offset - @rewind_ms, 0)

    segment =
      if from == 0,
        do: {:ok, current.wav},
        else: state.slice.(current.wav, from)

    case segment do
      {:ok, path} ->
        if current.segment, do: Shuttle.FS.rm(current.segment)

        %{
          state
          | current: %{
              current
              | handle: state.play.(path),
                segment: if(path != current.wav, do: path),
                offset: from,
                started: state.clock.()
            }
        }

      {:error, reason} ->
        cleanup(current)
        advance(%{state | current: nil, error: reason})
    end
  end

  defp schedule(%{current: nil} = state), do: state
  defp schedule(%{timer: timer} = state) when not is_nil(timer), do: state

  defp schedule(state),
    do: %{state | timer: Process.send_after(self(), :poll, state.poll_ms)}

  defp cleanup(current) do
    Shuttle.FS.rm(current.wav)
    if current.segment, do: Shuttle.FS.rm(current.segment)
  end

  defp snapshot(state) do
    speaking =
      case state.current || (state.render && elem(state.render, 1)) do
        nil -> nil
        %{item: item} -> Map.take(item, [:fiber_id, :voice, :text])
        item -> Map.take(item, [:fiber_id, :voice, :text])
      end

    %{
      available: available?(),
      speaking: speaking,
      queued: :queue.len(state.queue),
      paused: not is_nil(state.current) and is_nil(state.current.handle),
      muted: state.muted,
      error: state.error
    }
  end

  @doc """
  Whether hark's pending words say Cail is talking over `line`. Live voice hears
  the speaker too, so words of the line itself are its echo; two other words
  are Cail.
  """
  def talking?(nil, _line), do: false

  def talking?(partial, line) do
    spoken = MapSet.new(words(line))
    Enum.count(words(partial), &(not MapSet.member?(spoken, &1))) >= 2
  end

  defp words(text),
    do: text |> String.downcase() |> String.split(~r/[^\p{L}\p{N}']+/u, trim: true)

  # The pending words of hark's live voice line, when one is under way.
  defp partial do
    with {:ok, %{path: path}} <- Shuttle.Meeting.voice_transcript(),
         partial = Path.rootname(path) <> ".partial",
         {:ok, %{mtime: mtime}} <- Shuttle.FS.stat(partial, time: :posix),
         true <- System.os_time(:second) - mtime < @partial_stale_seconds,
         {:ok, text} <- Shuttle.FS.read(partial) do
      text
    else
      _ -> nil
    end
  end

  # pocket-tts renders to a raw wav; ffmpeg normalises loudness, since raw
  # output varies by voice.
  defp render(text, voice) do
    dir = Path.join(Shuttle.data_dir(), "speaker")
    stem = Path.join(dir, "#{System.os_time(:millisecond)}-#{System.unique_integer([:positive])}")
    raw = stem <> ".raw.wav"
    wav = stem <> ".wav"

    with :ok <- Shuttle.FS.mkdir_p(dir),
         :ok <- ensure_servers(dir),
         {_, 0} <-
           Shuttle.Env.cmd(
             "curl",
             ["-fsS", "-m", "120", "#{@tts}/tts", "--form-string", "text=#{text}"] ++
               ["--form-string", "voice_url=#{voice_url(voice)}", "-o", raw],
             stderr_to_stdout: true
           ),
         {_, 0} <-
           Shuttle.Env.cmd(
             "ffmpeg",
             ["-y", "-loglevel", "error", "-i", raw, "-af", "loudnorm=I=-16:TP=-1.5:LRA=11"] ++
               ["-ar", "24000", wav],
             stderr_to_stdout: true
           ) do
      Shuttle.FS.rm(raw)
      {:ok, wav}
    else
      {:error, reason} ->
        Shuttle.FS.rm(raw)
        {:error, reason}

      {output, status} ->
        Shuttle.FS.rm(raw)
        {:error, "render failed (#{status}): #{String.trim(output)}"}
    end
  end

  defp voice_url(voice) do
    bank = Shuttle.Env.expand("~/.claude/voices")

    if match?({:ok, _}, Shuttle.FS.stat(Path.join(bank, voice <> ".safetensors"))),
      do: "#{@bank}/#{voice}.safetensors",
      else: voice
  end

  defp ensure_servers(dir) do
    bank = Shuttle.Env.expand("~/.claude/voices")

    with :ok <-
           ensure_server(
             "#{@tts}/health",
             ["pocket-tts", "serve", "--host", "127.0.0.1", "--port", "8321"],
             dir,
             Path.join(dir, "pocket-tts.log")
           ) do
      ensure_server(
        "#{@bank}/",
        ["python3", "-m", "http.server", "8322", "--bind", "127.0.0.1"],
        bank,
        Path.join(dir, "voices-http.log")
      )
    end
  end

  defp ensure_server(url, command, cwd, log) do
    if healthy?(url) do
      :ok
    else
      Logger.info("speaker: starting #{Path.basename(hd(command))} (#{url} unhealthy)")
      line = Enum.map_join(command, " ", &shell_quote/1)
      Shuttle.Env.cmd("/bin/sh", ["-c", "nohup #{line} >#{shell_quote(log)} 2>&1 &"], cd: cwd)
      wait_healthy(url, 120)
    end
  end

  defp wait_healthy(url, 0), do: {:error, "#{url} did not come up"}

  defp wait_healthy(url, tries) do
    Process.sleep(1_000)
    if healthy?(url), do: :ok, else: wait_healthy(url, tries - 1)
  end

  defp healthy?(url),
    do: match?({_, 0}, Shuttle.Env.cmd("curl", ["-fsS", "-m", "2", "-o", "/dev/null", url]))

  defp shell_quote(value), do: "'" <> String.replace(value, "'", "'\\''") <> "'"

  defp exe(name), do: Shuttle.Env.find_executable(name) || name

  defp play(path),
    do: Port.open({:spawn_executable, exe("afplay")}, [:exit_status, args: [path]])

  defp stop(port) do
    case Port.info(port, :os_pid) do
      {:os_pid, pid} -> Shuttle.Env.cmd("kill", ["-TERM", Integer.to_string(pid)])
      nil -> :ok
    end

    :ok
  end

  defp slice(wav, from_ms) do
    out = Path.rootname(wav) <> "-from#{from_ms}.wav"

    case Shuttle.Env.cmd(
           "ffmpeg",
           ["-y", "-loglevel", "error", "-ss", "#{from_ms / 1000}", "-i", wav, out],
           stderr_to_stdout: true
         ) do
      {_, 0} -> {:ok, out}
      {output, status} -> {:error, "slice failed (#{status}): #{String.trim(output)}"}
    end
  end
end
