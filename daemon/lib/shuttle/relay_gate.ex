defmodule Shuttle.RelayGate do
  @moduledoc """
  Fail-fast admission for owner relays, keyed by the remote's configured URL.

  Four callers may relay to one URL at a time; callers never wait for a slot.
  Leases monitor the caller and cancel its registered async httpc request on
  death or deadline. A transport failure pauses admission for five seconds;
  any successful HTTP response clears that pause, including an HTTP error.
  No network work runs in this process.
  """
  use GenServer

  @call_timeout 100

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  def acquire(server, key, token, deadline) do
    call(server, {:acquire, key, token, self(), deadline})
  end

  def watch(server, token, worker, deadline) do
    call(server, {:watch, token, self(), worker, deadline})
  end

  def attach_worker(server, token, worker) do
    call(server, {:attach_worker, token, worker})
  end

  def attach(server, token, request_id, profile) do
    call(server, {:attach, token, request_id, profile})
  end

  def finish(server, token, result) do
    GenServer.cast(server, {:finish, token, result})
  end

  defp call(server, message) do
    GenServer.call(server, message, @call_timeout)
  catch
    :exit, _ -> {:error, :relay_unavailable}
  end

  @impl true
  def init(opts) do
    Process.flag(:trap_exit, true)

    {:ok,
     %{
       limit: Keyword.get(opts, :limit, 4),
       cooldown_ms: Keyword.get(opts, :cooldown_ms, 5_000),
       leases: %{},
       monitors: %{},
       counts: %{},
       failures: %{}
     }}
  end

  @impl true
  def handle_call({:acquire, key, token, caller, deadline}, _from, state) do
    now = now()

    cond do
      now >= deadline ->
        {:reply, {:error, :timeout}, state}

      Map.get(state.failures, key, now) > now ->
        {:reply, {:error, :relay_cooldown}, state}

      Map.get(state.counts, key, 0) >= state.limit ->
        {:reply, {:error, :relay_busy}, state}

      true ->
        monitor = Process.monitor(caller)
        timer = Process.send_after(self(), {:deadline, token}, deadline - now)

        lease = %{
          key: key,
          caller: caller,
          monitor: monitor,
          timer: timer,
          deadline: deadline,
          request: nil,
          worker: nil
        }

        state = %{
          state
          | leases: Map.put(state.leases, token, lease),
            monitors: Map.put(state.monitors, monitor, token),
            counts: Map.update(state.counts, key, 1, &(&1 + 1))
        }

        {:reply, :ok, state}
    end
  end

  def handle_call({:watch, token, caller, worker, deadline}, _from, state) do
    if deadline > now() do
      monitor = Process.monitor(caller)
      timer = Process.send_after(self(), {:deadline, token}, deadline - now())

      lease = %{
        key: nil,
        caller: caller,
        monitor: monitor,
        timer: timer,
        deadline: deadline,
        request: nil,
        worker: worker
      }

      {:reply, :ok,
       %{
         state
         | leases: Map.put(state.leases, token, lease),
           monitors: Map.put(state.monitors, monitor, token)
       }}
    else
      stop_worker(worker)
      {:reply, {:error, :timeout}, state}
    end
  end

  def handle_call({:attach_worker, token, worker}, _from, state) do
    case state.leases[token] do
      %{deadline: deadline} = lease ->
        if deadline > now() do
          {:reply, :ok, put_in(state.leases[token], %{lease | worker: worker})}
        else
          stop_worker(worker)
          {:reply, {:error, :timeout}, state}
        end

      nil ->
        stop_worker(worker)
        {:reply, {:error, :timeout}, state}
    end
  end

  def handle_call({:attach, token, id, profile}, _from, state) do
    case state.leases[token] do
      %{deadline: deadline} = lease ->
        if deadline > now() do
          {:reply, :ok, put_in(state.leases[token], %{lease | request: {id, profile}})}
        else
          cancel({id, profile})
          {:reply, {:error, :timeout}, state}
        end

      nil ->
        cancel({id, profile})
        {:reply, {:error, :timeout}, state}
    end
  end

  @impl true
  def handle_cast({:finish, token, result}, state) do
    state =
      case state.leases[token] do
        nil ->
          state

        lease ->
          state = record_result(state, lease.key, result)
          release(state, token)
      end

    {:noreply, state}
  end

  @impl true
  def handle_info({:DOWN, monitor, :process, _pid, _reason}, state) do
    case state.monitors[monitor] do
      nil -> {:noreply, state}
      token -> {:noreply, release(state, token)}
    end
  end

  def handle_info({:deadline, token}, state) do
    case state.leases[token] do
      nil ->
        {:noreply, state}

      lease ->
        cancel(lease.request)
        stop_worker(lease.worker)
        # Keep the slot until the caller finishes or dies. A callback that
        # ignores its timeout cannot let more callers through behind it.
        {:noreply, record_result(state, lease.key, {:error, :timeout})}
    end
  end

  def handle_info({:expire_failure, key, expires}, state) do
    failures =
      if state.failures[key] == expires, do: Map.delete(state.failures, key), else: state.failures

    {:noreply, %{state | failures: failures}}
  end

  @impl true
  def terminate(_reason, state) do
    Enum.each(state.leases, fn {_token, lease} ->
      cancel(lease.request)
      stop_worker(lease.worker)
    end)
  end

  defp record_result(state, nil, _result), do: state

  defp record_result(state, key, {:error, _}) do
    expires = now() + state.cooldown_ms
    Process.send_after(self(), {:expire_failure, key, expires}, state.cooldown_ms)
    %{state | failures: Map.put(state.failures, key, expires)}
  end

  defp record_result(state, key, success) when is_tuple(success) and elem(success, 0) == :ok,
    do: %{state | failures: Map.delete(state.failures, key)}

  defp record_result(state, _key, _abandoned), do: state

  defp release(state, token) do
    {lease, leases} = Map.pop(state.leases, token)
    cancel(lease.request)
    stop_worker(lease.worker)
    Process.cancel_timer(lease.timer)
    Process.demonitor(lease.monitor, [:flush])

    counts =
      case lease.key do
        nil ->
          state.counts

        key ->
          count = state.counts[key] - 1

          if count == 0,
            do: Map.delete(state.counts, key),
            else: Map.put(state.counts, key, count)
      end

    %{state | leases: leases, monitors: Map.delete(state.monitors, lease.monitor), counts: counts}
  end

  defp stop_worker(nil), do: :ok
  defp stop_worker(pid), do: Process.exit(pid, :kill)

  defp cancel(nil), do: :ok

  defp cancel({id, profile}) do
    :httpc.cancel_request(id, profile)
  catch
    :exit, _ -> :ok
  end

  defp now, do: System.monotonic_time(:millisecond)
end
