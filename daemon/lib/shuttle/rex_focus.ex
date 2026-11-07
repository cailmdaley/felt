defmodule Shuttle.RexFocus do
  @moduledoc """
  Follows the worker on Rex's screen: it streams to the board through
  `subscribe/0`, and routes the spoken-time voice journal while voice follows.
  The watch runs while either wants it.

  macOS accessibility window titles identify the app's selected worker across
  sessions, read through `~/.local/bin/shuttle-rex-title`, which holds the
  Accessibility grant so deploys can't invalidate it. Titles route only while
  Rex is the frontmost app, and Rex coming to the front re-asserts the worker
  its title names; `lsappinfo` reports the frontmost app without a grant.
  Other hosts, and macOS without that grant, use Rex's per-session
  active-window events.

  The stream carries only what Rex itself chooses, so a selection the board
  makes behind its own window never comes back to it. A daemon starting up, or
  a board connecting, learns where Rex stands without announcing it.

  `reveal/2` moves Rex's selection behind whatever has the keyboard, for a
  caller that sets the voice target itself. Selecting never activates the app.
  """
  use GenServer

  # The stdin reader owns the CLI's lifetime even if the BEAM exits without
  # running terminate/2. Rex events exits on server disconnect; wait then reaps
  # the reader too. This wrapper never starts or stops the Rex server.
  @stream """
  exec 2>/dev/null 3<&0
  "$@" 3<&- &
  child=$!
  (while read -r line; do :; done; kill -TERM "$child" 2>/dev/null) <&3 3<&- &
  guard=$!
  exec 3<&-
  trap 'kill -TERM "$child" "$guard" 2>/dev/null; wait' EXIT
  wait "$child"
  """

  def start_link(opts \\ []),
    do: GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))

  @impl true
  def init(opts) do
    Process.flag(:trap_exit, true)

    state = %{
      port: nil,
      discard: false,
      title: Keyword.get(opts, :title, if(Shuttle.Rex.macos?(), do: &read_title/0)),
      front?: Keyword.get(opts, :front?, &rex_front?/0),
      last_front: nil,
      last_title: nil,
      last_bindings: nil,
      last_target: nil,
      title_ready: false,
      warning: :unset,
      warning_receiver:
        Keyword.get(opts, :warning_receiver, fn ->
          GenServer.whereis(Shuttle.Env.server(Shuttle.Voice))
        end),
      warn: Keyword.get(opts, :warn, &Shuttle.Voice.focus_error/1),
      poll_ms: Keyword.get(opts, :poll_ms, 250),
      active?: Keyword.get(opts, :active?, &following?/0),
      watched?: Keyword.get(opts, :watched?, &watched?/0),
      publish: Keyword.get(opts, :publish, &publish/1),
      command: Keyword.get(opts, :command, &command/0),
      bindings: Keyword.get(opts, :bindings, &Shuttle.Terminal.RexBindings.read/0),
      fibers: Keyword.get(opts, :fibers, &Shuttle.Meeting.served_fibers/0),
      target: Keyword.get(opts, :target, &Shuttle.Voice.target/1)
    }

    send(self(), :tick)
    {:ok, warning(state, nil)}
  end

  @impl true
  def handle_info(:tick, state) do
    state =
      if state.active?.() or state.watched?.() do
        state = poll_title(state)
        if state.title_ready, do: stop_stream(state), else: ensure_stream(state)
      else
        state
        |> stop_stream()
        |> warning(nil)
        |> Map.merge(%{
          last_front: nil,
          last_title: nil,
          last_bindings: nil,
          last_target: nil,
          title_ready: false
        })
      end

    Process.send_after(self(), :tick, state.poll_ms)
    {:noreply, state}
  end

  def handle_info({port, {:data, {:noeol, _}}}, %{port: port} = state),
    do: {:noreply, %{state | discard: true}}

  def handle_info({port, {:data, {:eol, line}}}, %{port: port} = state) do
    if not state.discard and not state.title_ready do
      with {:ok, %{"payload" => %{"event" => %{"type" => "active_window_changed"}}} = event} <-
             Jason.decode(line),
           true <- state.active?.() or state.watched?.(),
           {:ok, bindings} <- state.bindings.(),
           target when not is_nil(target) <- target(event, bindings, state.fibers.()) do
        state.publish.(target)
        route(state, target)
      end
    end

    {:noreply, %{state | discard: false}}
  end

  def handle_info({port, {:exit_status, _}}, %{port: port} = state),
    do: {:noreply, %{state | port: nil, discard: false}}

  def handle_info({:EXIT, port, _}, %{port: port} = state),
    do: {:noreply, %{state | port: nil, discard: false}}

  # Closing a port can leave its exit receipt already queued.
  def handle_info({port, _}, state) when is_port(port), do: {:noreply, state}
  def handle_info({:EXIT, port, _}, state) when is_port(port), do: {:noreply, state}

  @impl true
  def terminate(_reason, state), do: state |> stop_stream() |> warning(nil)

  @doc "Delivers `{:rex_focus, target}` to the calling process each time Rex's worker is chosen."
  def subscribe, do: Registry.register(Shuttle.Voice.Streams, :rex_focus, nil)

  @doc "Tells every subscriber that `target` is now the worker in view."
  def publish(target) do
    Registry.dispatch(Shuttle.Voice.Streams, :rex_focus, fn entries ->
      for {pid, _} <- entries, do: send(pid, {:rex_focus, target})
    end)
  end

  @doc false
  def target(
        %{
          "type" => "session_event",
          "payload" => %{
            "session_id" => sid,
            "event" => %{"type" => "active_window_changed", "payload" => %{"window_id" => wid}}
          }
        },
        %{"bindings" => bindings},
        fibers
      ) do
    case Enum.find(bindings, fn {_, b} -> b["session_id"] == sid and b["window_id"] == wid end) do
      {_, %{"fiber" => id}} -> fiber_target(id, fibers)
      _ -> nil
    end
  end

  def target(_, _, _), do: nil

  @doc """
  Selects the Rex worker for `fiber_id` and `origin`, leaving the frontmost app
  in front.
  A local worker is found by its binding; a worker on another host by its
  window and session labels on that host's Rex server, which the app shows
  under the host's name. Returns `:ok` when Rex was asked to show it,
  otherwise `{:skip, reason}`: `:off` when voice is off or a meeting holds the
  mic, `:unbound` when no worker window is found, `:shown` when Rex's front
  window already shows it.
  """
  def reveal(params, opts \\ []) do
    following? = Keyword.get(opts, :active?, &following?/0)
    own = Keyword.get_lazy(opts, :own_host, &Shuttle.MeetingRouter.own_host/0)

    cond do
      not following?.() -> {:skip, :off}
      params["origin"] in [nil, "", own] -> reveal_local(params, opts)
      true -> reveal_remote(params, opts)
    end
  end

  defp reveal_local(params, opts) do
    bindings = Keyword.get(opts, :bindings, &Shuttle.Terminal.RexBindings.read/0)
    fibers = Keyword.get(opts, :fibers, &Shuttle.Meeting.served_fibers/0)
    title = Keyword.get(opts, :title, &read_title/0)
    select = Keyword.get(opts, :select, &select/3)

    with {:ok, doc} <- bindings.(),
         {:bound, %{"session_id" => sid, "window_id" => wid}} <-
           {:bound, binding_for(params, doc, fibers.())},
         {:shown, false} <- {:shown, shows?(title.(), doc, wid)} do
      select.(nil, sid, wid)
      :ok
    else
      {:bound, _} -> {:skip, :unbound}
      {:shown, _} -> {:skip, :shown}
      {:error, _} -> {:skip, :unbound}
    end
  end

  defp reveal_remote(%{"fiber_id" => id, "origin" => host}, opts) do
    fibers = Keyword.get(opts, :fibers, &Shuttle.Meeting.served_fibers/0).()
    title = Keyword.get(opts, :title, &read_title/0)
    locate = Keyword.get(opts, :locate, &locate/3)
    select = Keyword.get(opts, :select, &select/3)

    with %{} = fiber <-
           Enum.find(fibers, fn f ->
             id in [f["id"], f["uid"], f["slug"]] and get_in(f, ["shuttle", "host"]) == host
           end),
         {window, session} = remote_labels(fiber, fibers),
         {:shown, false} <- {:shown, shown_title?(title.(), window <> " - " <> session)},
         {:ok, sid, wid} <- locate.(host, session, window) do
      select.(host, sid, wid)
      :ok
    else
      {:shown, true} -> {:skip, :shown}
      _ -> {:skip, :unbound}
    end
  end

  defp reveal_remote(_, _), do: {:skip, :unbound}

  defp shown_title?({:ok, title}, expected), do: normalize_title(title) == expected
  defp shown_title?(_, _), do: false

  # The one window labelled `window` in the session labelled `session` on
  # `host`'s Rex server.
  defp locate(host, session, window) do
    runner = Shuttle.Runner.Default

    with {:ok, sessions} <- Shuttle.Rex.sessions(runner, server: host),
         [%{"session_id" => sid}] <-
           Enum.filter(sessions, &(normalize_title(&1["label"] || "") == session)),
         {:ok, windows} <- Shuttle.Rex.windows(runner, sid, server: host),
         [%{"window_id" => wid}] <-
           Enum.filter(windows, &(normalize_title(&1["label"] || "") == window)) do
      {:ok, sid, wid}
    else
      _ -> nil
    end
  end

  defp binding_for(%{"fiber_id" => id} = params, %{"bindings" => bindings}, fibers) do
    origin = params["origin"] || Shuttle.MeetingRouter.own_host()

    with %{} = fiber <-
           Enum.find(fibers, fn f ->
             id in [f["id"], f["uid"], f["slug"]] and get_in(f, ["shuttle", "host"]) == origin
           end),
         ids = Enum.reject([fiber["id"], fiber["uid"], fiber["slug"]], &is_nil/1),
         [binding] <-
           Enum.filter(
             Map.values(bindings),
             &(&1["fiber"] in ids and is_binary(&1["session_id"]) and is_binary(&1["window_id"]))
           ) do
      binding
    else
      _ -> nil
    end
  end

  defp binding_for(_, _, _), do: nil

  defp shows?({:ok, title}, doc, wid), do: match?(%{window_id: ^wid}, title_binding(title, doc))
  defp shows?(_, _, _), do: false

  # `host` nil is this host's Rex server; another host's is addressed by name.
  defp select(host, sid, wid) do
    runner = Shuttle.Env.app(:rex_runner, Shuttle.Runner.Default)
    server = if host, do: [server: host], else: []

    with {:ok, client} <- Shuttle.Rex.app_client(runner, server),
         do: Shuttle.Rex.select(runner, client, sid, wid, server)
  end

  @doc """
  The worker a Rex window title names. A local binding names it exactly; a
  worker on another host, whose Rex server the app also shows, is found by
  the labels its own daemon projects from the fiber tree, which the served
  fibers carry with their `shuttle.host`.
  """
  def title_target(title, bindings, fibers, own_host \\ Shuttle.MeetingRouter.own_host()) do
    case title_binding(title, bindings) do
      %{fiber: id} -> fiber_target(id, fibers)
      nil -> remote_title_target(title, fibers, own_host)
    end
  end

  defp remote_title_target(title, fibers, own_host) do
    alias Shuttle.Terminal.RexTree
    title = normalize_title(title)

    matches =
      fibers
      |> Enum.filter(fn fiber ->
        host = get_in(fiber, ["shuttle", "host"])
        path = fiber["slug"] || fiber["id"]

        is_binary(host) and host != own_host and is_binary(path) and
          String.contains?(
            title,
            path |> String.split("/") |> List.last() |> String.slice(0, 100)
          )
      end)
      |> Enum.uniq_by(&{&1["uid"] || &1["id"], &1["shuttle"]["host"]})
      |> Enum.filter(fn fiber ->
        {window, session} = remote_labels(fiber, fibers)
        window <> " - " <> session == title
      end)

    # Copies of one fiber on two hosts share a title; its live copy is the worker.
    case matches do
      [fiber] ->
        fiber_target(fiber["uid"] || fiber["id"], [fiber])

      many ->
        case Enum.filter(many, &(&1["status"] == "active")) do
          [fiber] -> fiber_target(fiber["uid"] || fiber["id"], [fiber])
          _ -> nil
        end
    end
  end

  defp title_binding(title, %{"bindings" => bindings}) do
    alias Shuttle.Terminal.RexTree

    matches =
      bindings
      |> Enum.flat_map(fn
        {_, %{"fiber" => fiber, "family" => family} = binding}
        when is_binary(fiber) and is_binary(family) ->
          [
            %{
              fiber: fiber,
              family: family,
              depth: binding["depth"] || 0,
              window_id: binding["window_id"]
            }
          ]

        _ ->
          []
      end)
      |> RexTree.layout()
      |> Enum.filter(fn entry ->
        window = RexTree.display_label(entry.label)
        session = RexTree.display_label(RexTree.session_label(entry.family))
        normalize_title(title) == normalize_title(window <> " - " <> session)
      end)

    case matches do
      [match] -> match
      _ -> nil
    end
  end

  # The window and session labels a worker's own daemon projects for it,
  # normalized as titles are.
  defp remote_labels(fiber, fibers) do
    alias Shuttle.Terminal.RexTree
    family = RexTree.family(fiber["slug"] || fiber["id"], fibers)
    [%{label: label}] = RexTree.layout([family])

    {normalize_title(RexTree.display_label(label)),
     normalize_title(RexTree.display_label(RexTree.session_label(family.family)))}
  end

  defp normalize_title(title), do: title |> String.replace("\u2060", "") |> String.trim()

  defp fiber_target(id, fibers) do
    case Enum.find(fibers, &(id in [&1["id"], &1["uid"], &1["slug"]])) do
      %{"shuttle" => shuttle} = fiber when is_map(shuttle) and map_size(shuttle) > 0 ->
        %{"fiber_id" => fiber["uid"] || id, "origin" => shuttle["host"], "name" => fiber["name"]}

      _ ->
        nil
    end
  end

  defp poll_title(%{title: nil} = state), do: state

  defp poll_title(state) do
    case state.title.() do
      {:ok, title} ->
        state = state |> warning(nil) |> Map.put(:title_ready, true)

        front = state.front?.()
        raised = front and state.last_front != true
        arrived = not is_nil(state.last_front)
        state = %{state | last_front: front}

        if not front or String.trim(title) == "" do
          state
        else
          case state.bindings.() do
            {:ok, bindings} ->
              if raised or title != state.last_title or bindings != state.last_bindings or
                   is_nil(state.last_target) do
                target = title_target(title, bindings, state.fibers.())
                identity = target_identity(target)

                if target &&
                     (raised or title != state.last_title or identity != state.last_target) do
                  if arrived, do: state.publish.(target)
                  route(state, target)
                end

                %{state | last_title: title, last_bindings: bindings, last_target: identity}
              else
                state
              end

            {:error, _} ->
              state
          end
        end

      {:error, reason} ->
        message =
          case reason do
            :accessibility ->
              "Rex session following needs macOS Accessibility: run ~/.local/bin/shuttle-rex-title --prompt and allow it. Following tab changes only."

            :no_helper ->
              "Rex session following needs ~/.local/bin/shuttle-rex-title; run make cli-install in a felt checkout. Following tab changes only."

            :unavailable ->
              "Rex window title unavailable; following tab changes only."
          end

        state
        |> warning(message)
        |> Map.put(:title_ready, false)
    end
  end

  defp route(state, target), do: if(state.active?.(), do: state.target.(target))

  defp target_identity(nil), do: nil
  defp target_identity(target), do: {target["fiber_id"], target["origin"]}

  defp warning(state, message) do
    delivery = {message, state.warning_receiver.()}

    if delivery == state.warning do
      state
    else
      state.warn.(message)
      %{state | warning: delivery}
    end
  end

  @doc false
  def read_title(runner \\ Shuttle.Runner.Default, helper \\ title_helper()) do
    if Shuttle.FS.exists?(helper) do
      case runner.cmd(helper, [], timeout_ms: 1_500, max_output_bytes: 4_096) do
        {title, 0} -> {:ok, String.trim_trailing(title, "\n")}
        {_, 3} -> {:error, :accessibility}
        _ -> {:error, :unavailable}
      end
    else
      {:error, :no_helper}
    end
  end

  # An unreadable frontmost app counts as Rex, so routing falls back to title changes.
  @doc false
  def rex_front?(runner \\ Shuttle.Runner.Default) do
    case runner.cmd("sh", ["-c", ~s{lsappinfo info -only bundleid "$(lsappinfo front)"}],
           timeout_ms: 1_500,
           max_output_bytes: 4_096
         ) do
      {out, 0} -> out =~ ~s{bundleID="com.superlogical.rex}
      _ -> true
    end
  end

  defp title_helper, do: Path.join(Shuttle.Env.home(), ".local/bin/shuttle-rex-title")

  defp following? do
    Shuttle.Terminal.primary() == Shuttle.Terminal.Rex and
      case Shuttle.Voice.snapshot() do
        %{enabled: true, state: state} when state != "yielded" -> true
        _ -> false
      end
  end

  defp watched? do
    Shuttle.Terminal.primary() == Shuttle.Terminal.Rex and
      Registry.lookup(Shuttle.Voice.Streams, :rex_focus) != []
  end

  defp command do
    case Shuttle.Rex.bin() do
      nil -> nil
      bin -> {bin, Shuttle.Rex.flags() ++ ["events", "--all", "--json"]}
    end
  end

  defp ensure_stream(%{port: port} = state) when is_port(port), do: state
  defp ensure_stream(state), do: start_stream(state)

  defp start_stream(state) do
    case state.command.() do
      nil ->
        state

      {bin, args} ->
        port =
          Port.open({:spawn_executable, Shuttle.Env.find_executable("sh")}, [
            :binary,
            :exit_status,
            :use_stdio,
            :hide,
            {:line, 65_536},
            {:args, ["-c", @stream, "sh", bin | args]}
          ])

        %{state | port: port, discard: false}
    end
  end

  defp stop_stream(%{port: nil} = state), do: state

  defp stop_stream(state) do
    if Port.info(state.port), do: Port.close(state.port)
    %{state | port: nil, discard: false}
  end
end
