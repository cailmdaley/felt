defmodule Shuttle.Lock do
  @moduledoc """
  Keyed mutual exclusion among the daemon's processes.

  A caller that finds a key held waits, in arrival order, and runs as soon as
  the holder releases it. A holder that exits releases its keys, and a waiter
  that exits leaves the queue. A process may take a key it already holds.

  The ownership table lives only in this process, so the server never
  restarts: the application supervisor shuts the daemon down when it exits.
  """

  use GenServer

  def start_link(_opts \\ []), do: GenServer.start_link(__MODULE__, nil, name: __MODULE__)

  @doc "Run `fun` while holding `key`, and return its result."
  @spec transaction(term(), (-> result)) :: result when result: term()
  def transaction(key, fun) do
    :ok = GenServer.call(__MODULE__, {:acquire, key}, :infinity)

    try do
      fun.()
    after
      :ok = GenServer.call(__MODULE__, {:release, key}, :infinity)
    end
  end

  # State: `keys` maps a key to its holder `{pid, monitor, depth}` and a queue
  # of waiters `{pid, monitor, from}`; `monitors` maps each monitor to its key.

  @impl true
  def init(nil), do: {:ok, %{keys: %{}, monitors: %{}}}

  @impl true
  def handle_call({:acquire, key}, {pid, _} = from, state) do
    case state.keys do
      %{^key => {{^pid, ref, depth}, waiters}} ->
        {:reply, :ok, put_in(state.keys[key], {{pid, ref, depth + 1}, waiters})}

      %{^key => {holder, waiters}} ->
        ref = Process.monitor(pid)
        state = put_in(state.monitors[ref], key)
        {:noreply, put_in(state.keys[key], {holder, :queue.in({pid, ref, from}, waiters)})}

      _ ->
        ref = Process.monitor(pid)
        state = put_in(state.monitors[ref], key)
        {:reply, :ok, put_in(state.keys[key], {{pid, ref, 1}, :queue.new()})}
    end
  end

  def handle_call({:release, key}, {pid, _}, state) do
    case state.keys do
      %{^key => {{^pid, ref, 1}, waiters}} ->
        Process.demonitor(ref, [:flush])
        {:reply, :ok, grant(%{state | monitors: Map.delete(state.monitors, ref)}, key, waiters)}

      %{^key => {{^pid, ref, depth}, waiters}} ->
        {:reply, :ok, put_in(state.keys[key], {{pid, ref, depth - 1}, waiters})}
    end
  end

  @impl true
  def handle_info({:DOWN, ref, :process, _pid, _reason}, state) do
    {key, monitors} = Map.pop(state.monitors, ref)
    state = %{state | monitors: monitors}

    case state.keys[key] do
      {{_, ^ref, _}, waiters} ->
        {:noreply, grant(state, key, waiters)}

      {holder, waiters} ->
        waiters = :queue.filter(fn {_, waiter, _} -> waiter != ref end, waiters)
        {:noreply, put_in(state.keys[key], {holder, waiters})}
    end
  end

  defp grant(state, key, waiters) do
    case :queue.out(waiters) do
      {{:value, {pid, ref, from}}, rest} ->
        GenServer.reply(from, :ok)
        put_in(state.keys[key], {{pid, ref, 1}, rest})

      {:empty, _} ->
        %{state | keys: Map.delete(state.keys, key)}
    end
  end
end
