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
  file from the held offset. The pending words are read every 100 ms, so a
  hold follows the human's second word within a poll. The hold lasts until 4 s
  after the human last added a word, whether hark still shows their line or
  has already closed it, so a pause mid-thought does not restart the line.

  Saying "skip" (or "skip it", "skip that") while a line is current drops the
  rest of it.

  Saying "play" (or "play them", "what's waiting") opens the inbox on the card
  whose held line is oldest: live voice is routed to it and Rex reveals it, so
  its lines play, the first opening with the card's name, and the human can
  answer by talking. "next" moves to the next card the same way; "stop" closes
  the inbox and leaves the rest held. The inbox closes itself once nothing is
  held.

  The queue, the current line and its offset are journaled, so a daemon restart
  resumes a held or playing line rather than losing it.

  What was played, and when by the wall clock, is kept for two minutes
  (`played/1`), so live voice can recognise the speaker's own lines when hark
  hears them back, on the system track or through the mic (`echo?/3`).
  """
  use GenServer
  require Logger

  @default_voice "dylan_thomas"
  @tts "http://127.0.0.1:8321"
  @bank "http://127.0.0.1:8322"
  @poll_ms 100
  @rewind_ms 500
  @quiet_ms 1_500
  @hold_ms 4_000
  @played_ms 120_000
  @echo_slack_ms 2_000

  def start_link(opts \\ []),
    do: GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))

  def show(opts \\ []), do: GenServer.call(server(opts), :show)
  def mute(muted, opts \\ []), do: GenServer.call(server(opts), {:mute, muted})

  @doc "Open (`:play`), move on (`:next`) or close (`:stop`) the inbox, as the spoken words do."
  def inbox(action, opts \\ []) when action in [:play, :next, :stop],
    do: GenServer.call(server(opts), {:inbox, action})

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
              {:speak,
               %{
                 fiber_id: fiber_id,
                 name: fiber && fiber["name"],
                 origin: fiber && fiber["origin"],
                 keys: keys,
                 text: text,
                 voice: voice
               }}
            )

      _ ->
        {:error, "text is required"}
    end
  end

  @doc "The lines played in the last two minutes: `%{text, from, to}` in wall ms, `to` nil while playing."
  def played(opts \\ []) do
    GenServer.call(server(opts), :played, 1_000)
  catch
    :exit, _ -> []
  end

  @doc """
  Whether hark's utterance `text`, heard over `{from, to}` (wall ms), is the
  speaker's own voice: some line in `played` overlaps it within #{@echo_slack_ms} ms,
  and at most one word in three (at least one) is not a word of those lines. A
  word cut off mid-way counts when it begins a spoken word.
  """
  def echo?(text, {from, to}, played) do
    spoken =
      for %{text: line, from: start, to: stop} <- played,
          start - @echo_slack_ms <= to,
          is_nil(stop) or stop + @echo_slack_ms >= from,
          word <- words(line),
          into: MapSet.new(),
          do: word

    heard = words(text)
    stray = Enum.count(heard, &(not spoken_word?(&1, spoken)))
    MapSet.size(spoken) > 0 and heard != [] and stray <= max(1, div(length(heard), 3))
  end

  defp spoken_word?(word, spoken),
    do:
      MapSet.member?(spoken, word) or
        (String.length(word) >= 2 and Enum.any?(spoken, &String.starts_with?(&1, word)))

  def available?, do: not is_nil(Shuttle.Env.find_executable("afplay"))

  defp find_fiber(fiber_id, opts) when is_binary(fiber_id) do
    fibers = Keyword.get(opts, :fibers, &Shuttle.ServedFibers.all/0)

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
          {role, charter} <- Enum.sort(charters(store)),
          voice = voice_at(charter),
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
      case charters(store) do
        %{^role => charter} -> voice_at(charter)
        _ -> nil
      end
    end)
  end

  defp voice_at(charter) do
    case Shuttle.FiberDoc.read_path(charter) do
      {:ok, _path, _raw, %{"voice" => voice}, _body} when is_binary(voice) and voice != "" ->
        voice

      _ ->
        nil
    end
  end

  # Role slug => charter file. A role's charter is roles/<slug> at the top of
  # the store, or <mount>/roles/<slug> where <mount> is a top-level entry of
  # its .felt/ that links to a directory. The store's own charter wins a
  # collision, then mounts in name order.
  defp charters(store) do
    felt = Path.join(store, ".felt")

    mounts =
      case Shuttle.FS.ls(felt) do
        {:ok, names} ->
          for name <- Enum.sort(names),
              dir = Path.join(felt, name),
              match?({:ok, %{type: :symlink}}, Shuttle.FS.lstat(dir)),
              Shuttle.FS.dir?(dir),
              do: dir

        _ ->
          []
      end

    for dir <- [felt | mounts],
        {:ok, roles} <- [Shuttle.FS.ls(Path.join(dir, "roles"))],
        role <- Enum.sort(roles),
        charter = Path.join([dir, "roles", role, role <> ".md"]),
        Shuttle.FS.regular?(charter),
        reduce: %{} do
      found -> Map.put_new(found, role, charter)
    end
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
       inbox: saved.inbox,
       card: saved.card,
       announce: saved.announce,
       command_seen: nil,
       journal: journal,
       saved: saved,
       heard: {nil, nil},
       played: [],
       talked: nil,
       error: nil,
       timer: nil,
       clock: Keyword.get(opts, :clock, fn -> System.monotonic_time(:millisecond) end),
       wall: Keyword.get(opts, :wall, fn -> System.system_time(:millisecond) end),
       poll_ms: Keyword.get(opts, :poll_ms, @poll_ms),
       hold_ms: Keyword.get(opts, :hold_ms, @hold_ms),
       partial: Keyword.get(opts, :partial, &partial/0),
       target: Keyword.get(opts, :target, &target/0),
       retarget: Keyword.get(opts, :retarget, &retarget/1),
       fibers: Keyword.get(opts, :fibers, &Shuttle.ServedFibers.all/0),
       render_fun: Keyword.get(opts, :render, &render/2),
       play: Keyword.get(opts, :play, &play/1),
       stop: Keyword.get(opts, :stop, &stop/1),
       slice: Keyword.get(opts, :slice, &slice/2)
     }}
  end

  @impl true
  def handle_call(:show, _from, state), do: {:reply, snapshot(state), state}
  def handle_call(:played, _from, state), do: {:reply, state.played, state}

  def handle_call({:mute, muted}, _from, state) when is_boolean(muted) do
    state = hold_or_play(%{state | muted: muted}) |> save()
    {:reply, {:ok, snapshot(state)}, state}
  end

  def handle_call({:inbox, action}, _from, state) do
    state = state |> command(action) |> advance() |> close_empty() |> schedule() |> save()
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
    {:noreply, advance(%{played_stop(state) | current: nil, error: error}) |> save()}
  end

  def handle_info(:poll, state),
    do:
      {:noreply,
       %{state | timer: nil}
       |> listen()
       |> hold_or_play()
       |> advance()
       |> close_empty()
       |> schedule()
       |> save()}

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

  defp restore(nil),
    do: %{queue: [], current: nil, muted: false, inbox: false, card: nil, announce: nil}

  defp restore(path) do
    with {:ok, bytes} <- Shuttle.FS.read(path),
         %{queue: queue, current: current} = saved <- :erlang.binary_to_term(bytes) do
      saved = Map.merge(restore(nil), saved)

      case current do
        %{wav: wav} = current ->
          if match?({:ok, _}, Shuttle.FS.stat(wav)),
            do: saved,
            else: %{saved | queue: [current.item | queue], current: nil}

        nil ->
          saved
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
      muted: state.muted,
      inbox: state.inbox,
      card: state.card,
      announce: state.announce
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
  # when nothing is in view. The first line of a card the inbox opened opens
  # with the card's name.
  defp advance(%{current: nil, render: nil} = state) do
    target = state.target.()

    case Enum.split_while(:queue.to_list(state.queue), &(not in_view?(&1, target))) do
      {_, []} ->
        state

      {before, [item | rest]} ->
        render = state.render_fun

        said =
          if state.announce && item.fiber_id == state.announce,
            do: "#{name_of(state, item)}: #{item.text}",
            else: item.text

        item = Map.put(item, :said, said)

        task =
          Task.Supervisor.async_nolink(Shuttle.TaskSupervisor, fn ->
            render.(said, item.voice)
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

    state =
      if state.announce && item.fiber_id == state.announce,
        do: %{state | announce: nil},
        else: state

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

  # When hark's pending words last changed.
  defp hear(state, partial, now) do
    if partial == elem(state.heard, 0), do: state, else: %{state | heard: {partial, now}}
  end

  # Held: stop the player and keep the offset. Free: play from the offset.
  defp hold_or_play(%{current: nil} = state), do: state

  defp hold_or_play(%{current: current} = state) do
    partial = state.partial.()
    now = state.clock.()
    state = hear(state, partial, now)
    heard = state.heard

    # When the human last added a word over the line: the latest change of
    # the pending words, if they are the human's.
    state =
      if elem(heard, 1) != state.talked and
           talking?(heard_over(partial, current), Map.get(current.item, :said, current.item.text)),
         do: %{state | talked: elem(heard, 1)},
         else: state

    held = state.muted or (not is_nil(state.talked) and now - state.talked < state.hold_ms)

    skip = skip(partial, Map.get(current, :before))

    cond do
      skip == :said or (skip == :trailing and now - elem(heard, 1) >= @quiet_ms) ->
        Logger.info("speaker: skipped for #{current.item.fiber_id || "?"}")
        if current.handle, do: state.stop.(current.handle)
        cleanup(current)
        advance(%{played_stop(state) | current: nil})

      held and current.handle ->
        state.stop.(current.handle)
        offset = current.offset + now - current.started
        %{played_stop(state) | current: %{current | handle: nil, offset: offset}}

      not held and is_nil(current.handle) ->
        start(state, current)

      true ->
        state
    end
  end

  # The played log: a line opens an entry each time it starts and closes it
  # when it stops; entries closed more than two minutes ago are dropped.
  defp played_start(state, text) do
    now = state.wall.()

    played =
      Enum.filter(state.played, &(is_nil(&1.to) or now - &1.to < @played_ms)) ++
        [%{text: text, from: now, to: nil}]

    %{state | played: played}
  end

  defp played_stop(state) do
    now = state.wall.()
    %{state | played: Enum.map(state.played, &if(is_nil(&1.to), do: %{&1 | to: now}, else: &1))}
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
        state = played_start(state, Map.get(current.item, :said, current.item.text))

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

  # A spoken inbox word, once per change of hark's pending words: the words
  # since the current line began, or all of them between lines.
  defp listen(state) do
    partial = state.partial.()
    state = hear(state, partial, state.clock.())

    if partial == state.command_seen do
      state
    else
      before = state.current && Map.get(state.current, :before)
      state = %{state | command_seen: partial}

      case {inbox_word(partial, before), state.inbox} do
        {:play, false} -> command(state, :play)
        {:next, true} -> command(state, :next)
        {:stop, true} -> command(state, :stop)
        _ -> state
      end
    end
  end

  # Open the inbox on, or move it to, the card with the oldest held line.
  defp command(state, action) when action in [:play, :next] do
    target = state.target.()

    case Enum.find(:queue.to_list(state.queue), &(not in_view?(&1, target))) do
      nil ->
        Logger.info("speaker: inbox has nothing held")
        %{state | inbox: false, card: nil}

      item ->
        card = %{fiber_id: item.fiber_id, name: name_of(state, item)}
        Logger.info("speaker: inbox on #{card.name}")
        state.retarget.(Map.merge(item, card))
        %{state | inbox: true, card: card, announce: item.fiber_id}
    end
  end

  defp command(state, :stop) do
    Logger.info("speaker: inbox closed")
    %{state | inbox: false, card: nil}
  end

  # The inbox closes itself once no line is held.
  defp close_empty(%{inbox: true} = state) do
    target = state.target.()

    if Enum.any?(:queue.to_list(state.queue), &(not in_view?(&1, target))),
      do: state,
      else: %{state | inbox: false, card: nil}
  end

  defp close_empty(state), do: state

  @doc """
  The inbox word in the pending words added since `before`: `:play` for "play",
  "play them" or "what's waiting"; `:next` for "next", "next one" or "next
  card"; `:stop` for "stop", "stop it" or "stop that"; else nil.
  """
  def inbox_word(nil, _before), do: nil

  def inbox_word(partial, before) do
    new = since(partial, before)

    case Enum.join(words(new), " ") do
      words when words in ["play", "play them", "what's waiting", "whats waiting"] -> :play
      words when words in ["next", "next one", "next card"] -> :next
      words when words in ["stop", "stop it", "stop that"] -> :stop
      _ -> nil
    end
  end

  # The card's name; while the fiber feed is unavailable, its id's last part
  # read as words ("loom/tools/hark/holistic-hark" is "holistic hark").
  defp name_of(state, item) do
    item.name ||
      case find_fiber(item.fiber_id, fibers: state.fibers) do
        %{"name" => name} when is_binary(name) ->
          name

        _ when is_binary(item.fiber_id) ->
          item.fiber_id |> Path.basename() |> String.replace(~r/[-_]+/, " ")

        _ ->
          "a session"
      end
  end

  # Route live voice to the card the inbox opened, which brings every board to
  # it wherever this daemon stands, and move Rex to it behind the frontmost
  # app, so all three agree. Rex stays put while Listen is pinned.
  defp retarget(item) do
    params = %{"fiber_id" => item.fiber_id, "name" => item.name, "source" => "inbox"}
    params = if item[:origin], do: Map.put(params, "origin", item.origin), else: params

    case Shuttle.Voice.target(params) do
      {:ok, _} -> :ok
      {:error, reason} -> Logger.warning("speaker: inbox could not route voice: #{reason}")
    end

    case Shuttle.RexFocus.reveal(params) do
      :ok -> :ok
      {:skip, reason} -> Logger.info("speaker: inbox did not reveal in Rex: #{reason}")
    end
  catch
    :exit, reason -> Logger.warning("speaker: inbox could not route voice: #{inspect(reason)}")
  end

  defp in_view?(_item, nil), do: true
  defp in_view?(item, target), do: Enum.any?(target, &(&1 in item.keys))

  # The ids of the fiber live voice is routed to, while Listening is switched
  # on. The switch is read from its config, since Voice's snapshot reports off
  # until its first reconcile after boot. Both sides resolve ids, since the
  # fiber feed can be unavailable at either moment.
  defp target do
    with {:ok, %{"enabled" => true}} <- Shuttle.Voice.Config.read(),
         %{target: %{"fiber_id" => id}} <- Shuttle.Voice.snapshot() do
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
        %{item: item} -> Map.take(item, [:fiber_id, :name, :voice, :text])
        item -> Map.take(item, [:fiber_id, :name, :voice, :text])
      end

    target = state.target.()
    {ready, held} = Enum.split_with(:queue.to_list(state.queue), &in_view?(&1, target))

    %{
      available: available?(),
      speaking: speaking,
      queued: length(ready),
      held: held_by_card(state, held),
      inbox: %{playing: state.inbox, card: state.card},
      paused: not is_nil(state.current) and is_nil(state.current.handle),
      muted: state.muted,
      error: state.error
    }
  end

  # Held lines by fiber, in the order their oldest line arrived.
  defp held_by_card(state, held) do
    held
    |> Enum.group_by(& &1.fiber_id)
    |> Enum.map(fn {fiber_id, [first | _] = lines} ->
      {Enum.find_index(held, &(&1 == first)),
       %{fiber_id: fiber_id, name: name_of(state, first), n: length(lines), first: first.text}}
    end)
    |> Enum.sort_by(&elem(&1, 0))
    |> Enum.map(&elem(&1, 1))
  end

  @doc """
  How the pending words added since the line became current ask to skip it:
  `:said` when they are only "skip", "skip it" or "skip that"; `:trailing` when
  they end with one, not after a negation; else nil. A trailing skip counts
  once the human is quiet, since mid-sentence it may be followed by more.
  """
  def skip(nil, _before), do: nil

  def skip(partial, before) do
    new = since(partial, before)

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

  # The words that can hold a line: all pending words until it first plays,
  # then only those added since it began, so words from before it cannot hold
  # it again each time its own echo changes the pending line.
  defp heard_over(partial, %{started: nil, offset: 0}), do: partial
  defp heard_over(partial, current), do: since(partial, Map.get(current, :before))

  # The pending words added since `before`, the words pending when a line
  # began; hark extends its pending line, so they are its prefix.
  defp since(partial, before) do
    if is_binary(partial) and is_binary(before) and before != "" and
         String.starts_with?(partial, before),
       do: String.replace_prefix(partial, before, ""),
       else: partial
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
    with {:ok, %{path: path}} <- Shuttle.Recorder.current_transcript(),
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
