defmodule Shuttle.RexFocus do
  @moduledoc """
  Routes the Rex view into the spoken-time voice journal.

  macOS accessibility window titles identify the app's selected worker across
  sessions, read through `~/.local/bin/shuttle-rex-title`, which holds the
  Accessibility grant so deploys can't invalidate it. Other hosts, and macOS
  without that grant, use Rex's per-session active-window events.
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
      poll_ms: Keyword.get(opts, :poll_ms, 1_000),
      active?: Keyword.get(opts, :active?, &following?/0),
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
      if state.active?.() do
        state = poll_title(state)
        if state.title_ready, do: stop_stream(state), else: ensure_stream(state)
      else
        state
        |> stop_stream()
        |> warning(nil)
        |> Map.merge(%{last_title: nil, last_bindings: nil, last_target: nil, title_ready: false})
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
           true <- state.active?.(),
           {:ok, bindings} <- state.bindings.(),
           target when not is_nil(target) <- target(event, bindings, state.fibers.()) do
        state.target.(Map.put(target, "source", "rex"))
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

  @doc false
  def title_target(title, %{"bindings" => bindings}, fibers) do
    alias Shuttle.Terminal.RexTree

    matches =
      bindings
      |> Enum.flat_map(fn
        {_, %{"fiber" => fiber, "family" => family} = binding}
        when is_binary(fiber) and is_binary(family) ->
          [%{fiber: fiber, family: family, depth: binding["depth"] || 0}]

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
      [%{fiber: id}] -> fiber_target(id, fibers)
      _ -> nil
    end
  end

  defp normalize_title(title), do: title |> String.replace("\u2060", "") |> String.trim()

  defp fiber_target(id, fibers) do
    case Enum.find(fibers, &(id in [&1["id"], &1["uid"], &1["slug"]])) do
      %{"shuttle" => shuttle} = fiber when is_map(shuttle) and map_size(shuttle) > 0 ->
        %{"fiber_id" => id, "origin" => shuttle["host"], "name" => fiber["name"]}

      _ ->
        nil
    end
  end

  defp poll_title(%{title: nil} = state), do: state

  defp poll_title(state) do
    case state.title.() do
      {:ok, title} ->
        state = state |> warning(nil) |> Map.put(:title_ready, true)

        if String.trim(title) == "" do
          state
        else
          case state.bindings.() do
            {:ok, bindings} ->
              if title != state.last_title or bindings != state.last_bindings or
                   is_nil(state.last_target) do
                target = title_target(title, bindings, state.fibers.())
                identity = target_identity(target)

                if target && (title != state.last_title or identity != state.last_target),
                  do: state.target.(Map.put(target, "source", "rex"))

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

  defp title_helper, do: Path.join(Shuttle.Env.home(), ".local/bin/shuttle-rex-title")

  defp following? do
    Shuttle.Terminal.primary() == Shuttle.Terminal.Rex and
      case Shuttle.Voice.show() do
        %{enabled: true, state: state} when state != "yielded" -> true
        _ -> false
      end
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
