defmodule Shuttle.ClaudeMailRecovery do
  @moduledoc """
  Schedules durable Claude mailbox recovery at boot and on queued receipts.

  Only one CLI pass runs at a time. Pending mail gets a one-second follow-up;
  a slow sweep also recovers receipts lost across process or daemon crashes.
  The CLI owns queue age, transport claims, retries and failure notices.
  """
  use GenServer
  require Logger

  @sweep_ms 60_000

  def start_link(opts \\ []),
    do: GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))

  def queued(server \\ Shuttle.Env.server(__MODULE__)) do
    if is_pid(server) or Process.whereis(server), do: GenServer.cast(server, :queued)
    :ok
  end

  @impl true
  def init(opts) do
    send(self(), :recover)
    Process.send_after(self(), :sweep, Keyword.get(opts, :sweep_ms, @sweep_ms))

    {:ok,
     %{
       runner: Keyword.get(opts, :runner, Shuttle.CLI),
       interval_ms: Keyword.get(opts, :interval_ms, 1_000),
       sweep_ms: Keyword.get(opts, :sweep_ms, @sweep_ms),
       task: nil,
       timer: nil,
       queued: false
     }}
  end

  @impl true
  def handle_cast(:queued, state) do
    send(self(), :recover)
    {:noreply, %{state | queued: true}}
  end

  @impl true
  def handle_info(:sweep, state) do
    send(self(), :recover)
    Process.send_after(self(), :sweep, state.sweep_ms)
    {:noreply, state}
  end

  def handle_info(:recover, %{task: nil} = state) do
    if state.timer, do: Process.cancel_timer(state.timer)
    runner = state.runner

    task =
      Task.Supervisor.async_nolink(Shuttle.TaskSupervisor, fn ->
        runner.run(["claude-mail-recover"], timeout_ms: 32_000)
      end)

    {:noreply, %{state | task: task.ref, timer: nil, queued: false}}
  end

  def handle_info(:recover, state), do: {:noreply, state}

  def handle_info({ref, result}, %{task: ref} = state) do
    Process.demonitor(ref, [:flush])
    pending = pending?(result)
    {:noreply, follow_up(%{state | task: nil}, pending or state.queued)}
  end

  def handle_info({:DOWN, ref, :process, _pid, reason}, %{task: ref} = state) do
    Logger.warning("Claude mail recovery task exited: #{inspect(reason)}")
    {:noreply, follow_up(%{state | task: nil}, true)}
  end

  defp follow_up(state, true) do
    timer = Process.send_after(self(), :recover, state.interval_ms)
    %{state | timer: timer, queued: false}
  end

  defp follow_up(state, false), do: state

  defp pending?({:ok, output}) do
    case Jason.decode(output) do
      {:ok, %{"pending" => pending} = result} when is_boolean(pending) ->
        if error = result["error"], do: Logger.warning("Claude mail recovery: #{error}")
        pending

      _ ->
        true
    end
  end

  defp pending?(error) do
    Logger.warning("Claude mail recovery: #{inspect(error)}")
    true
  end
end
