defmodule Shuttle.SingleFlight do
  @moduledoc """
  Concurrent callers of `run/2` with the same key share one execution.

  The first caller's function runs in a monitored worker process. Callers that
  ask for the same key before it finishes wait for that result instead of
  repeating the work, so a burst of identical requests costs one execution, not
  one per request. Nothing is cached: once the result is delivered, the next
  call runs the function again.

  The worker replies to every waiter itself, so a large result is copied from
  the worker to each caller and never passes through this server. A worker
  that crashes exits every waiter with its reason, as if each had run the
  function and crashed.
  """

  use GenServer

  @doc false
  def start_link(opts \\ []),
    do: GenServer.start_link(__MODULE__, :ok, name: Keyword.get(opts, :name, __MODULE__))

  @doc """
  Run `fun`, or wait for the run already in flight under `key`.

  The caller waits for the shared run without a deadline of its own; `fun` is
  responsible for bounding itself, as every `Shuttle.Runner` call is. Without a
  running server (a test that starts no application) `fun` runs inline.
  """
  @spec run(term(), (-> result)) :: result when result: term()
  def run(key, fun) when is_function(fun, 0) do
    case GenServer.whereis(__MODULE__) do
      nil ->
        fun.()

      server ->
        # A test's flight is its own (`scope_key/1`), and runs with the
        # caller's `$callers` so `fun` reads the caller's scope.
        flight = {:run, Shuttle.Env.scope_key(key), fun, Shuttle.Env.callers()}

        case GenServer.call(server, flight, :infinity) do
          {:ok, result} -> result
          {:exit, reason} -> exit(reason)
        end
    end
  end

  @impl true
  def init(:ok), do: {:ok, %{flights: %{}, keys: %{}}}

  @impl true
  def handle_call({:run, key, fun, callers}, from, state) do
    case state.flights do
      %{^key => {worker, waiters}} ->
        {:noreply, put_in(state.flights[key], {worker, [from | waiters]})}

      _ ->
        server = self()

        {worker, ref} =
          spawn_monitor(fn ->
            Shuttle.Env.adopt_callers(callers)
            fly(server, key, fun)
          end)

        {:noreply,
         %{
           state
           | flights: Map.put(state.flights, key, {worker, [from]}),
             keys: Map.put(state.keys, ref, key)
         }}
    end
  end

  # The worker's result is in hand: hand it the waiters and forget the key, so
  # a caller arriving after this point starts a fresh run.
  def handle_call({:land, key}, {worker, _tag}, state) do
    case state.flights do
      %{^key => {^worker, waiters}} ->
        {:reply, waiters, %{state | flights: Map.delete(state.flights, key)}}

      _ ->
        {:reply, [], state}
    end
  end

  @impl true
  def handle_info({:DOWN, ref, :process, worker, reason}, state) do
    {key, keys} = Map.pop(state.keys, ref)
    state = %{state | keys: keys}

    case state.flights do
      %{^key => {^worker, waiters}} ->
        Enum.each(waiters, &GenServer.reply(&1, {:exit, reason}))
        {:noreply, %{state | flights: Map.delete(state.flights, key)}}

      _ ->
        {:noreply, state}
    end
  end

  defp fly(server, key, fun) do
    result = fun.()
    waiters = GenServer.call(server, {:land, key}, :infinity)
    Enum.each(waiters, &GenServer.reply(&1, {:ok, result}))
  end
end
