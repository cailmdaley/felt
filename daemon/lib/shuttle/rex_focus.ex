defmodule Shuttle.RexFocus do
  @moduledoc """
  Follows Rex's focused tab and routes the spoken-time voice target
  (`Shuttle.Voice.target/1`) while voice listens.

  macOS accessibility window titles identify the app's selected tab across
  sessions, read through `~/.local/bin/shuttle-rex-title`, which holds the
  Accessibility grant so deploys can't invalidate it. Titles route while Rex or
  RexWeb (`dev.coey.rexweb`) is frontmost, and returning to the front
  re-asserts the focused fiber. `lsappinfo` tracks the frontmost app without a
  grant: one read when the watch begins, then its `listen` stream of frontmost
  changes. Other hosts, and macOS without that grant, use Rex's per-session
  active-window events.

  Windows map through `rex.json` (`bindings`, `places`, `views`, `desk`):
  worker and thread tabs target their fiber, a family Tab 1 view targets the
  family root, and the `Desk` session leaves the voice target unchanged.
  """
  use GenServer

  # The stdin reader owns a streaming CLI's lifetime (Rex events, the frontmost
  # listener) even if the BEAM exits without running terminate/2. Rex events
  # exits on server disconnect; wait then reaps the reader too. This wrapper
  # never starts or stops the Rex server.
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
      front_events: Keyword.get(opts, :front_events, &front_events/0),
      front: nil,
      front_port: nil,
      ticks: 0,
      slow_every: Keyword.get(opts, :slow_every, 8),
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
      active?: Keyword.get(opts, :active?, &listening?/0),
      command: Keyword.get(opts, :command, &command/0),
      bindings: Keyword.get(opts, :bindings, &Shuttle.Terminal.RexBindings.read/0),
      fibers: Keyword.get(opts, :fibers, &Shuttle.ServedFibers.all/0),
      target: Keyword.get(opts, :target, &Shuttle.Voice.target/1)
    }

    send(self(), :tick)
    {:ok, warning(state, nil)}
  end

  @impl true
  def handle_info(:tick, state) do
    state = %{state | ticks: state.ticks + 1}

    state =
      if state.active?.() do
        state = poll_title(state)
        if state.title_ready, do: stop_stream(state), else: ensure_stream(state)
      else
        state
        |> stop_stream()
        |> stop_front()
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

  def handle_info({port, {:data, {:eol, line}}}, %{front_port: port} = state) do
    if String.contains?(line, "kLSNotifyBecameFrontmost"),
      do: {:noreply, %{state | front: rex_front_line?(line)}},
      else: {:noreply, state}
  end

  def handle_info({port, {:exit_status, _}}, %{front_port: port} = state),
    do: {:noreply, %{state | front_port: nil, front: nil}}

  def handle_info({:EXIT, port, _}, %{front_port: port} = state),
    do: {:noreply, %{state | front_port: nil, front: nil}}

  def handle_info({port, {:data, {:noeol, _}}}, %{port: port} = state),
    do: {:noreply, %{state | discard: true}}

  def handle_info({port, {:data, {:eol, line}}}, %{port: port} = state) do
    if not state.discard and not state.title_ready do
      with {:ok, %{"payload" => %{"event" => %{"type" => "active_window_changed"}}} = event} <-
             Jason.decode(line),
           true <- state.active?.(),
           {:ok, bindings} <- state.bindings.(),
           target when not is_nil(target) <- target(event, bindings, state.fibers.()) do
        state.target.(target)
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
  def terminate(_reason, state), do: state |> stop_stream() |> stop_front() |> warning(nil)

  @doc false
  def target(
        %{
          "type" => "session_event",
          "payload" => %{
            "session_id" => sid,
            "event" => %{"type" => "active_window_changed", "payload" => %{"window_id" => wid}}
          }
        },
        doc,
        fibers
      )
      when is_map(doc) do
    if get_in(doc, ["desk", "session_id"]) == sid do
      nil
    else
      binding_target(doc["bindings"], sid, wid, fibers) ||
        place_target(doc["places"], sid, wid, fibers) ||
        view_target(doc["views"], sid, wid, fibers)
    end
  end

  def target(_, _, _), do: nil

  defp binding_target(bindings, sid, wid, fibers) when is_map(bindings) do
    case Enum.find(bindings, fn {_, b} -> b["session_id"] == sid and b["window_id"] == wid end) do
      {_, %{"fiber" => id}} -> fiber_target(id, fibers)
      _ -> nil
    end
  end

  defp binding_target(_, _, _, _), do: nil

  defp place_target(places, sid, wid, fibers) when is_map(places) do
    case Enum.find(places, fn {_, p} -> p["session_id"] == sid and p["window_id"] == wid end) do
      {uid, place} ->
        fiber_target(uid, fibers) || (place["fiber"] && fiber_target(place["fiber"], fibers))

      _ ->
        nil
    end
  end

  defp place_target(_, _, _, _), do: nil

  defp view_target(views, sid, wid, fibers) when is_map(views) do
    case Enum.find(views, fn {_, v} -> v["session_id"] == sid and v["window_id"] == wid end) do
      {root, view} ->
        (view["uid"] && fiber_target(view["uid"], fibers)) ||
          fiber_target(view["fiber"] || root, fibers)

      _ ->
        nil
    end
  end

  defp view_target(_, _, _, _), do: nil

  @doc """
  The constitution a Rex window title names. Local `bindings`, `places` and
  `views` from `rex.json` map worker tabs, thread places and family Tab 1 views
  to their fibers; the `Desk` session leaves the target unchanged. A worker on
  another host is matched by the labels its own daemon projects from the fiber
  tree, which the served fibers carry with their `shuttle.host`.
  """
  def title_target(title, doc, fibers, own_host \\ Shuttle.Poller.own_host_id()) do
    if desk_title?(title) do
      nil
    else
      # Several windows or records on one fiber share a title and name the same constitution.
      case title_entries(title, doc, fibers) |> Enum.uniq_by(& &1.fiber) do
        [entry] -> fiber_target(entry.id, fibers) || fiber_target(entry.fiber, fibers)
        _ -> remote_title_target(title, fibers, own_host)
      end
    end
  end

  defp desk_title?(title) do
    norm = normalize_title(title)
    norm == "Desk - Desk" or String.ends_with?(norm, " - Desk")
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

  defp title_entries(title, doc, fibers) when is_map(doc) do
    alias Shuttle.Terminal.RexTree
    norm = normalize_title(title)

    binding_entries =
      for {_, %{"fiber" => fiber, "family" => family} = b} <- doc["bindings"] || %{},
          is_binary(fiber) and is_binary(family) do
        %{id: fiber, fiber: fiber, family: family, depth: b["depth"] || 0}
      end

    place_entries =
      for {uid, %{"family" => family} = p} <- doc["places"] || %{},
          is_binary(family),
          fiber = p["fiber"] || fiber_path(uid, fibers),
          is_binary(fiber) do
        depth = p["depth"] || RexTree.family(fiber, fibers).depth
        %{id: uid, fiber: fiber, family: family, depth: depth}
      end

    view_entries =
      for {root, v} <- doc["views"] || %{},
          is_binary(root) and is_map(v) do
        family = v["family"] || root
        fiber = v["fiber"] || root
        %{id: v["uid"] || fiber, fiber: fiber, family: family, depth: 0}
      end

    (binding_entries ++ place_entries ++ view_entries)
    |> RexTree.layout()
    |> Enum.filter(fn entry ->
      window = RexTree.display_label(entry.label)
      session = RexTree.display_label(RexTree.session_label(entry.family))
      norm == normalize_title(window <> " - " <> session)
    end)
  end

  defp title_entries(_, _, _), do: []

  defp fiber_path(uid, fibers) do
    case Enum.find(fibers, &(uid in [&1["uid"], &1["id"], &1["slug"]])) do
      %{} = f -> f["slug"] || f["id"]
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

  defp normalize_title(title) do
    title
    |> String.replace("\u2060", "")
    |> String.trim()
    |> strip_session_mark()
  end

  defp strip_session_mark("● " <> rest), do: rest
  defp strip_session_mark(title), do: String.replace(title, " - ● ", " - ")

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
    state = track_front(state)
    front = state.front

    if state.title_ready and not front,
      do: %{state | last_front: false},
      else: observe_title(state, front)
  end

  defp observe_title(state, front) do
    case state.title.() do
      {:ok, title} ->
        raised = front and state.last_front != true
        state = state |> warning(nil) |> Map.merge(%{title_ready: true, last_front: front})

        if not front or String.trim(title) == "" do
          state
        else
          case state.bindings.() do
            {:ok, bindings} ->
              retry = is_nil(state.last_target) and rem(state.ticks, state.slow_every) == 0

              if raised or title != state.last_title or bindings != state.last_bindings or retry do
                target = title_target(title, bindings, state.fibers.())
                identity = target_identity(target)

                if target &&
                     (raised or title != state.last_title or identity != state.last_target) do
                  state.target.(target)
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
    lsappinfo = &runner.cmd("/usr/bin/lsappinfo", &1, timeout_ms: 1_500, max_output_bytes: 4_096)

    with {front, 0} <- lsappinfo.(["front"]),
         {out, 0} <- lsappinfo.(["info", "-only", "bundleid", String.trim(front)]) do
      out =~ ~s{bundleID="com.superlogical.rex} or out =~ ~s{bundleID="dev.coey.rexweb}
    else
      _ -> true
    end
  end

  defp rex_front_line?(line) do
    line =~ ~s("CFBundleIdentifier"="com.superlogical.rex) or
      line =~ ~s("CFBundleIdentifier"="dev.coey.rexweb)
  end

  defp title_helper, do: Path.join(Shuttle.Env.home(), ".local/bin/shuttle-rex-title")

  defp listening? do
    Shuttle.Terminal.primary() == Shuttle.Terminal.Rex and Shuttle.Voice.snapshot().enabled
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
      nil -> state
      {bin, args} -> %{state | port: open_stream(bin, args), discard: false}
    end
  end

  defp stop_stream(%{port: nil} = state), do: state

  defp stop_stream(state) do
    close(state.port)
    %{state | port: nil, discard: false}
  end

  # The frontmost app is read once as its listener starts, then follows the
  # listener's lines. Without a listener it is read on every tick.
  defp track_front(%{front_port: port} = state) when is_port(port), do: state

  defp track_front(state) do
    case state.front_events.() do
      nil -> %{state | front: state.front?.()}
      {bin, args} -> %{state | front_port: open_stream(bin, args), front: state.front?.()}
    end
  end

  defp stop_front(%{front_port: nil} = state), do: %{state | front: nil}

  defp stop_front(state) do
    close(state.front_port)
    %{state | front_port: nil, front: nil}
  end

  defp front_events, do: {"/usr/bin/lsappinfo", ["listen", "+becameFrontmost", "forever"]}

  defp open_stream(bin, args) do
    Port.open({:spawn_executable, Shuttle.Env.find_executable("sh")}, [
      :binary,
      :exit_status,
      :use_stdio,
      :hide,
      {:line, 65_536},
      {:args, ["-c", @stream, "sh", bin | args]}
    ])
  end

  defp close(port), do: if(Port.info(port), do: Port.close(port))
end
