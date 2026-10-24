defmodule Shuttle.StoreSync do
  @moduledoc """
  Bounded pull-on-miss recovery, shared across fibers and requests.

  Each store is attempted at most once per 30 seconds, including failed attempts.
  Concurrent requests share the attempt. The Poller serializes Git changes with
  lifecycle writes; this process owns only the cooldown, never the slow I/O.
  """
  use GenServer

  def start_link(opts \\ []),
    do: GenServer.start_link(__MODULE__, :ok, name: Keyword.get(opts, :name, __MODULE__))

  def sync(stores) do
    stores
    |> Enum.uniq()
    |> Enum.flat_map(fn store ->
      result = Shuttle.SingleFlight.run({:store_sync, store}, fn -> sync_store(store) end)

      case result do
        {:ok, _} -> []
        error -> [{store, error}]
      end
    end)
  end

  defp sync_store(store) do
    server = Shuttle.Env.server(__MODULE__)
    key = Shuttle.Env.scope_key(store)

    case GenServer.call(server, {:cached, key}) do
      {:cached, result} ->
        result

      :miss ->
        result = Shuttle.Felt.run(["-C", store, "sync"], timeout_ms: 5_000)
        GenServer.call(server, {:remember, key, result})
        result
    end
  end

  @impl true
  def init(:ok), do: {:ok, %{}}

  @impl true
  def handle_call({:cached, key}, _from, state) do
    now = System.monotonic_time(:millisecond)

    result =
      case Map.get(state, key) do
        {at, result} when now - at < 30_000 -> {:cached, result}
        _ -> :miss
      end

    {:reply, result, state}
  end

  def handle_call({:remember, key, result}, _from, state) do
    now = System.monotonic_time(:millisecond)
    {:reply, :ok, Map.put(state, key, {now, result})}
  end
end
