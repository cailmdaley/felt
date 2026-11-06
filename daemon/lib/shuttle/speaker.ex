defmodule Shuttle.Speaker do
  @moduledoc """
  Speaks lines on this host, one at a time in arrival order, each in the voice of
  its fiber's role. Rendering is pocket-tts; playback is afplay.

  While live voice has a target, only lines from that constitution play; the
  rest wait, per fiber and in order, until it is in view. Without a target
  every line plays.

  Playback holds while the human is talking (hark's live voice has pending
  words beyond an echo of the line being spoken) or while the speaker is muted,
  and resumes from just before where it stopped. afplay keeps its clock running
  under SIGSTOP, so a hold stops the player and a resume plays the rest of the
  file from the held offset. The human is quiet once their pending words have
  not changed for 1.5 s.

  Saying "skip" (or "skip it", "skip that") while a line is current drops the
  rest of it.

  The queue, the current line and its offset are journaled, so a daemon restart
  resumes a held or playing line rather than losing it.
  """
  use GenServer
  require Logger

  @default_voice "dylan_thomas"
  @tts "http://127.0.0.1:8321"
  @bank "http://127.0.0.1:8322"
  @poll_ms 250
  @rewind_ms 500
  @quiet_ms 1_500

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
        fiber = find_fiber(fiber_id, opts)

        voice =
          case params["voice"] do
            voice when is_binary(voice) and voice != "" -> voice
            _ -> role_voice(fiber, opts)
          end

        keys = fiber_keys(fiber_id, fiber)

        if text == "",
          do: {:error, "text is empty"},
          else:
            GenServer.call(
              server(opts),
              {:speak, %{fiber_id: fiber_id, keys: keys, text: text, voice: voice}}
            )

      _ ->
        {:error, "text is required"}
    end
  end

  def available?, do: not is_nil(Shuttle.Env.find_executable("afplay"))

  @doc "The voice of the fiber's role: the charter's `voice:`, else #{@default_voice}."
  def voice_for(fiber_id, opts \\ []), do: role_voice(find_fiber(fiber_id, opts), opts)

  defp find_fiber(fiber_id, opts) when is_binary(fiber_id) do
    fibers = Keyword.get(opts, :fibers, &Shuttle.Meeting.served_fibers/0)

    Enum.find(fibers.(), fn fiber ->
      is_map(fiber) and fiber_id in [fiber["uid"], fiber["id"], fiber["slug"]]
    end)
  end

  defp find_fiber(_fiber_id, _opts), do: nil

  @doc "Every id a fiber answers to: the one given, and its uid, id and slug once found."
  def fiber_keys(fiber_id, opts) when is_list(opts),
    do: fiber_keys(fiber_id, find_fiber(fiber_id, opts))

  def fiber_keys(fiber_id, fiber) do
    [fiber_id | Enum.map(~w(uid id slug), &(fiber && fiber[&1]))]
    |> Enum.filter(&is_binary/1)
    |> Enum.uniq()
  end

  defp role_voice(fiber, opts) do
    stores = Keyword.get(opts, :stores, &Shuttle.FeltStores.configured_stores/0)
    role = fiber && get_in(fiber, ["shuttle", "role"])
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
    journal = Keyword.get_lazy(opts, :journal, &journal_path/0)
    saved = restore(journal)
    if saved.current || saved.queue != [], do: send(self(), :poll)

    {:ok,
     %{
       queue: :queue.from_list(saved.queue),
       current: saved.current,
       render: nil,
       muted: saved.muted,
       journal: journal,
       saved: saved,
       heard: {nil, nil},
       error: nil,
       timer: nil,
       clock: Keyword.get(opts, :clock, fn -> System.monotonic_time(:millisecond) end),
       poll_ms: Keyword.get(opts, :poll_ms, @poll_ms),
       partial: Keyword.get(opts, :partial, &partial/0),
       target: Keyword.get(opts, :target, &target/0),
       render_fun: Keyword.get(opts, :render, &render/2),
       play: Keyword.get(opts, :play, &play/1),
       stop: Keyword.get(opts, :stop, &stop/1),
       slice: Keyword.get(opts, :slice, &slice/2)
     }}
  end

  @impl true
  def handle_call(:show, _from, state), do: {:reply, snapshot(state), state}

  def handle_call({:mute, muted}, _from, state) when is_boolean(muted) do
    state = hold_or_play(%{state | muted: muted}) |> save()
    {:reply, {:ok, snapshot(state)}, state}
  end

  def handle_call({:mute, _}, _from, state),
    do: {:reply, {:error, "muted must be a boolean"}, state}

  def handle_call({:speak, item}, _from, state) do
    ahead = :queue.len(state.queue) + if(state.current || state.render, do: 1, else: 0)
    held = not in_view?(item, state.target.())
    state = advance(%{state | queue: :queue.in(item, state.queue)}) |> schedule() |> save()
    {:reply, {:ok, %{voice: item.voice, ahead: ahead, held: held}}, state}
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
    {:noreply, advance(%{state | current: nil, error: error}) |> save()}
  end

  def handle_info(:poll, state),
    do: {:noreply, %{state | timer: nil} |> hold_or_play() |> advance() |> schedule() |> save()}

  def handle_info(_message, state), do: {:noreply, state}

  @impl true
  def terminate(_reason, %{current: %{handle: handle} = current} = state)
      when not is_nil(handle) do
    state.stop.(handle)
    offset = current.offset + state.clock.() - current.started
    save(%{state | current: %{current | handle: nil, offset: offset}})
  end

  def terminate(_reason, state), do: save(state)

  defp journal_path, do: Path.join([Shuttle.data_dir(), "speaker", "outbox.bin"])

  defp restore(nil), do: %{queue: [], current: nil, muted: false}

  defp restore(path) do
    with {:ok, bytes} <- Shuttle.FS.read(path),
         %{queue: queue, current: current, muted: muted} <- :erlang.binary_to_term(bytes) do
      case current do
        nil ->
          %{queue: queue, current: nil, muted: muted}

        %{wav: wav} = current ->
          if match?({:ok, _}, Shuttle.FS.stat(wav)),
            do: %{queue: queue, current: current, muted: muted},
            else: %{queue: [current.item | queue], current: nil, muted: muted}
      end
    else
      _ -> restore(nil)
    end
  end

  # Write the journal when what it records has changed.
  defp save(%{journal: nil} = state), do: state

  defp save(state) do
    rendering = if state.render, do: [elem(state.render, 1)], else: []

    saved = %{
      queue: rendering ++ :queue.to_list(state.queue),
      current:
        state.current &&
          %{state.current | handle: nil, segment: nil, started: nil},
      muted: state.muted
    }

    if saved == state.saved do
      state
    else
      Shuttle.FS.mkdir_p(Path.dirname(state.journal))
      :ok = Shuttle.FS.write_atomic(state.journal, :erlang.term_to_binary(saved))
      %{state | saved: saved}
    end
  end

  # The first queued line from the constitution in view, or the first of all
  # when nothing is in view.
  defp advance(%{current: nil, render: nil} = state) do
    target = state.target.()

    case Enum.split_while(:queue.to_list(state.queue), &(not in_view?(&1, target))) do
      {_, []} ->
        state

      {before, [item | rest]} ->
        render = state.render_fun

        task =
          Task.Supervisor.async_nolink(Shuttle.TaskSupervisor, fn ->
            render.(item.text, item.voice)
          end)

        %{state | queue: :queue.from_list(before ++ rest), render: {task, item}}
    end
  end

  defp advance(state), do: state

  defp rendered(state, item, {:ok, wav}) do
    Logger.info("speaker: rendered #{inspect(item.voice)} for #{item.fiber_id || "?"} to #{wav}")

    current = %{
      item: item,
      wav: wav,
      segment: nil,
      handle: nil,
      offset: 0,
      started: nil,
      before: state.partial.()
    }

    {:noreply,
     %{state | render: nil, current: current, error: nil}
     |> hold_or_play()
     |> schedule()
     |> save()}
  end

  defp rendered(state, item, {:error, reason}) do
    Logger.warning("speaker: render failed for #{item.fiber_id || "?"}: #{reason}")
    {:noreply, advance(%{state | render: nil, error: reason}) |> save()}
  end

  # Held: stop the player and keep the offset. Free: play from the offset.
  defp hold_or_play(%{current: nil} = state), do: state

  defp hold_or_play(%{current: current} = state) do
    partial = state.partial.()
    now = state.clock.()
    heard = if partial == elem(state.heard, 0), do: state.heard, else: {partial, now}
    state = %{state | heard: heard}

    held =
      state.muted or
        (talking?(partial, current.item.text) and now - elem(heard, 1) < @quiet_ms)

    skip = skip(partial, Map.get(current, :before))

    cond do
      skip == :said or (skip == :trailing and now - elem(heard, 1) >= @quiet_ms) ->
        Logger.info("speaker: skipped for #{current.item.fiber_id || "?"}")
        if current.handle, do: state.stop.(current.handle)
        cleanup(current)
        advance(%{state | current: nil})

      held and current.handle ->
        state.stop.(current.handle)
        offset = current.offset + now - current.started
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

  defp in_view?(_item, nil), do: true
  defp in_view?(item, target), do: Enum.any?(target, &(&1 in item.keys))

  # The ids of the fiber live voice is routed to, while Listening is switched
  # on. The switch is read from its config, since Voice's snapshot reports off
  # until its first reconcile after boot. Both sides resolve ids, since the
  # fiber feed can be unavailable at either moment.
  defp target do
    with {:ok, %{"enabled" => true}} <- Shuttle.Voice.Config.read(),
         %{target: %{"fiber_id" => id}} <- Shuttle.Voice.show() do
      fiber_keys(id, [])
    else
      _ -> nil
    end
  catch
    :exit, _ -> nil
  end

  defp schedule(%{timer: timer} = state) when not is_nil(timer), do: state

  defp schedule(state) do
    if state.current || state.render || not :queue.is_empty(state.queue),
      do: %{state | timer: Process.send_after(self(), :poll, state.poll_ms)},
      else: state
  end

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

    target = state.target.()
    {ready, held} = Enum.split_with(:queue.to_list(state.queue), &in_view?(&1, target))

    %{
      available: available?(),
      speaking: speaking,
      queued: length(ready),
      held: Enum.frequencies_by(held, & &1.fiber_id),
      paused: not is_nil(state.current) and is_nil(state.current.handle),
      muted: state.muted,
      error: state.error
    }
  end

  @doc """
  How the pending words added since the line became current ask to skip it:
  `:said` when they are only "skip", "skip it" or "skip that"; `:trailing` when
  they end with one, not after a negation; else nil. A trailing skip counts
  once the human is quiet, since mid-sentence it may be followed by more.
  """
  def skip(nil, _before), do: nil

  def skip(partial, before) do
    new =
      if is_binary(before) and before != "" and String.starts_with?(partial, before),
        do: String.replace_prefix(partial, before, ""),
        else: partial

    words = words(new)
    {head, tail} = last_skip(words)

    cond do
      tail not in [["skip"], ["skip", "it"], ["skip", "that"]] -> nil
      head == [] -> :said
      List.last(head) in ~w(don't dont not never no) -> nil
      true -> :trailing
    end
  end

  # Split at the last "skip": the words before it and the words from it on.
  defp last_skip(words) do
    case Enum.find_index(Enum.reverse(words), &(&1 == "skip")) do
      nil -> {words, []}
      i -> Enum.split(words, length(words) - 1 - i)
    end
  end

  @doc """
  Whether hark's pending words say the human is talking over `line`. Live voice hears
  the speaker too, so words of the line itself are its echo; two other words
  are the human.
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
