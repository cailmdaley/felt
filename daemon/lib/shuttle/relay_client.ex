defmodule Shuttle.RelayClient do
  @moduledoc """
  Deadline-limited owner relays around the existing transport callbacks.

  Injected callbacks execute in their caller, preserving their process context.
  The real Default transport runs its entire setup, submission and receive in
  a monitored worker. The gate kills that worker and cancels its registered
  async httpc request on owner death or deadline. No task wait or retry occurs.
  """
  alias Shuttle.RelayGate

  @context {__MODULE__, :context}

  def run(remote, client, timeout, opts, callback) do
    gate = Keyword.get(opts, :relay_gate, configured_gate())
    token = make_ref()
    deadline = now() + timeout
    # Transport identity isolates injected callback modules from the real
    # transport's failures; changing a remote's URL always changes its key.
    key = Shuttle.Env.scope_key({remote.url, client})

    case RelayGate.acquire(gate, key, token, deadline) do
      :ok ->
        previous = Process.put(@context, {gate, token, deadline})

        try do
          result = callback.()
          RelayGate.finish(gate, token, result)
          result
        after
          restore_context(previous)
          RelayGate.finish(gate, token, :abandoned)
        end

      {:error, _} = error ->
        # A timed-out call can still be in the gate's mailbox. This cast
        # follows it from the same sender and releases any late admission.
        RelayGate.finish(gate, token, :abandoned)
        error
    end
  end

  @doc false
  def transport(timeout, callback) do
    context = Process.get(@context)
    {gate, token, deadline} = context || {configured_gate(), make_ref(), now() + timeout}
    receiver = :erlang.alias()
    owner = self()

    {:ok, worker} =
      Task.Supervisor.start_child(Shuttle.Env.server(Shuttle.TaskSupervisor), fn ->
        Process.put(:"$callers", [owner])
        owner_monitor = Process.monitor(owner)

        receive do
          :start ->
            Process.demonitor(owner_monitor, [:flush])
            Process.put(@context, {gate, token, deadline})
            result = callback.()
            send(receiver, {receiver, result})

          {:DOWN, ^owner_monitor, :process, ^owner, _reason} ->
            :ok
        after
          max(deadline - now(), 0) -> :ok
        end
      end)

    monitor = Process.monitor(worker)

    try do
      admission =
        if context,
          do: RelayGate.attach_worker(gate, token, worker),
          else: RelayGate.watch(gate, token, worker, deadline)

      with :ok <- admission do
        send(worker, :start)

        receive do
          {^receiver, result} ->
            result

          {:DOWN, ^monitor, :process, ^worker, reason} ->
            if now() >= deadline, do: {:error, :timeout}, else: {:error, {:exit, reason}}
        after
          max(deadline - now(), 0) -> {:error, :timeout}
        end
      end
    after
      :erlang.unalias(receiver)
      Process.exit(worker, :kill)
      Process.demonitor(monitor, [:flush])
      if is_nil(context), do: RelayGate.finish(gate, token, :abandoned)
    end
  end

  @doc false
  def request(method, request, http_opts, profile) do
    {gate, token, deadline} = Process.get(@context)
    # Using a receiver alias drops replies that race with cancellation.
    receiver = :erlang.alias()

    try do
      with {:ok, id} <-
             :httpc.request(
               method,
               request,
               http_opts,
               [sync: false, receiver: receiver],
               profile
             ) do
        try do
          with :ok <- RelayGate.attach(gate, token, id, profile) do
            receive do
              {:http, {^id, {:error, _} = error}} -> error
              {:http, {^id, result}} -> {:ok, result}
            after
              max(deadline - now(), 0) -> {:error, :timeout}
            end
          end
        after
          # Name the selected profile, including private dial profiles.
          :httpc.cancel_request(id, profile)
        end
      end
    after
      :erlang.unalias(receiver)
    end
  end

  defp restore_context(nil), do: Process.delete(@context)
  defp restore_context(previous), do: Process.put(@context, previous)
  defp configured_gate, do: Shuttle.Env.app(:relay_gate, Shuttle.Env.server(RelayGate))
  defp now, do: System.monotonic_time(:millisecond)
end
