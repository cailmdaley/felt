defmodule Shuttle.ClaudeMailRecovery do
  @moduledoc """
  Gives unoffered automatic Claude messages a native wake path.

  The CLI owns the durable queue, the three-second offer deadline and the
  exclusive choice between hook and native delivery. This process supplies
  recovery ticks, including immediately after a daemon restart. Each pass
  skips messages another pass is observing, so a slow native reply cannot
  delay a newer message's wake.
  """
  use GenServer
  require Logger

  @interval_ms 1_000

  def start_link(opts \\ []),
    do: GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))

  @impl true
  def init(opts) do
    send(self(), :recover)

    {:ok,
     %{
       runner: Keyword.get(opts, :runner, Shuttle.CLI),
       interval_ms: Keyword.get(opts, :interval_ms, @interval_ms)
     }}
  end

  @impl true
  def handle_info(:recover, state) do
    runner = state.runner

    Task.Supervisor.start_child(Shuttle.TaskSupervisor, fn ->
      case runner.run(["claude-mail-recover"], timeout_ms: 32_000) do
        {:ok, _} ->
          :ok

        {:command_error, status, output} ->
          Logger.warning("Claude mail recovery exited #{status}: #{output}")

        {:error, error} ->
          Logger.warning("Claude mail recovery: #{inspect(error)}")
      end
    end)

    Process.send_after(self(), :recover, state.interval_ms)
    {:noreply, state}
  end
end
