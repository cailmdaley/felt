defmodule Shuttle.RexFocus do
  @moduledoc """
  Routes Rex active-window changes into the spoken-time voice journal.

  Rex server events identify the active window within a session, but not which
  session an app is displaying. Switching to an already-active window in a
  different session therefore needs a client selection signal from Rex.
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
      poll_ms: Keyword.get(opts, :poll_ms, 1_000),
      active?: Keyword.get(opts, :active?, &following?/0),
      command: Keyword.get(opts, :command, &command/0),
      bindings: Keyword.get(opts, :bindings, &Shuttle.Terminal.RexBindings.read/0),
      fibers: Keyword.get(opts, :fibers, &Shuttle.Meeting.served_fibers/0),
      target: Keyword.get(opts, :target, &Shuttle.Voice.target/1)
    }

    send(self(), :tick)
    {:ok, state}
  end

  @impl true
  def handle_info(:tick, state) do
    Process.send_after(self(), :tick, state.poll_ms)

    state =
      case {state.active?.(), state.port} do
        {true, nil} -> start_stream(state)
        {false, port} when is_port(port) -> stop_stream(state)
        _ -> state
      end

    {:noreply, state}
  end

  def handle_info({port, {:data, {:noeol, _}}}, %{port: port} = state),
    do: {:noreply, %{state | discard: true}}

  def handle_info({port, {:data, {:eol, line}}}, %{port: port} = state) do
    if not state.discard do
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
  def terminate(_reason, state), do: stop_stream(state)

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
    with {_, %{"fiber" => id}} <-
           Enum.find(bindings, fn {_, b} -> b["session_id"] == sid and b["window_id"] == wid end),
         %{"shuttle" => shuttle} = fiber when is_map(shuttle) and map_size(shuttle) > 0 <-
           Enum.find(fibers, &(id in [&1["id"], &1["uid"], &1["slug"]])) do
      %{"fiber_id" => id, "origin" => shuttle["host"], "name" => fiber["name"]}
    else
      _ -> nil
    end
  end

  def target(_, _, _), do: nil

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
