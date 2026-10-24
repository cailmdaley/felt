defmodule Shuttle.TranscriptIndexer do
  @moduledoc """
  Host-local transcript catch-up, independent of dispatch and boot quarantine.

  Startup only schedules work. A supervised, unlinked task reads host config
  and runs the CLI at reduced OS priority; neither I/O nor indexing occupies
  this server's mailbox. A completed pass schedules the next one, so even a
  first full scan longer than the interval never overlaps another pass.
  """
  use GenServer
  require Logger

  @boot_delay_ms 5_000
  @interval_ms 300_000
  @timeout_ms 1_800_000

  def start_link(opts \\ []),
    do: GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))

  def status(server \\ Shuttle.Env.server(__MODULE__)) do
    GenServer.call(server, :status, 500)
  catch
    :exit, _ -> %{state: :unavailable, last_run_at: nil, duration_ms: nil, ok: nil, error: nil}
  end

  @impl true
  def init(opts) do
    state = %{
      opts: opts,
      task: nil,
      timer: nil,
      started: nil,
      status: %{state: :scheduled, last_run_at: nil, duration_ms: nil, ok: nil, error: nil}
    }

    {:ok, schedule(state, Keyword.get(opts, :boot_delay_ms, @boot_delay_ms))}
  end

  @impl true
  def handle_call(:status, _from, state), do: {:reply, state.status, state}

  @impl true
  def handle_info(:index, %{task: nil} = state) do
    if state.timer, do: Process.cancel_timer(state.timer)
    owner = self()
    opts = state.opts
    timeout = Keyword.get(opts, :timeout_ms, @timeout_ms)
    task = Task.Supervisor.async_nolink(Shuttle.TaskSupervisor, fn -> run(opts, timeout) end)
    watch_owner(owner, task.pid)
    deadline = Process.send_after(self(), {:index_timeout, task.ref}, timeout + 5_000)

    {:noreply,
     %{
       state
       | task: %{pid: task.pid, ref: task.ref, deadline: deadline},
         timer: nil,
         started: System.monotonic_time(:millisecond),
         status: %{state.status | state: :running}
     }}
  end

  # Ticks arriving during a pass do not queue another full scan.
  def handle_info(:index, state), do: {:noreply, state}

  def handle_info({ref, result}, %{task: %{ref: ref}} = state) do
    Process.demonitor(ref, [:flush])
    {:noreply, finish(state, result)}
  end

  def handle_info({:DOWN, ref, :process, _pid, reason}, %{task: %{ref: ref}} = state),
    do: {:noreply, finish(state, {:error, "index task exited: #{inspect(reason)}"})}

  def handle_info({:index_timeout, ref}, %{task: %{ref: ref, pid: pid}} = state) do
    Process.exit(pid, :kill)
    Process.demonitor(ref, [:flush])
    {:noreply, finish(state, {:error, "index task exceeded its deadline"})}
  end

  def handle_info(_, state), do: {:noreply, state}

  defp run(opts, timeout) do
    if Shuttle.Host.transcript_index?() do
      runner = Keyword.get(opts, :runner, Shuttle.Runner.Default)

      case runner.cmd("nice", ["-n", "10", "shuttle", "transcript", "index", "--json"],
             timeout_ms: timeout,
             stderr_to_stdout: true
           ) do
        {output, 0} -> decode_result(output)
        {output, status} -> {:error, "shuttle transcript index exited #{status}: #{output}"}
      end
    else
      :disabled
    end
  end

  defp decode_result(output) do
    case Jason.decode(output) do
      {:ok, %{"index" => index, "errors" => []}} when is_map(index) ->
        :ok

      {:ok, %{"errors" => errors}} when is_list(errors) and errors != [] ->
        {:error, "transcript indexing incomplete: #{Enum.join(errors, "; ")}"}

      _ ->
        {:error, "shuttle transcript index returned an invalid receipt: #{output}"}
    end
  end

  defp finish(state, result) do
    Process.cancel_timer(state.task.deadline)
    duration = System.monotonic_time(:millisecond) - state.started

    status =
      case result do
        :disabled ->
          %{state.status | state: :disabled}

        :ok ->
          %{
            state: :idle,
            last_run_at: DateTime.utc_now(),
            duration_ms: duration,
            ok: true,
            error: nil
          }

        {:error, error} ->
          error = error |> String.trim() |> String.slice(0, 2_000)
          Logger.warning("Transcript indexer: #{error}")

          %{
            state: :idle,
            last_run_at: DateTime.utc_now(),
            duration_ms: duration,
            ok: false,
            error: error
          }
      end

    schedule(
      %{state | task: nil, started: nil, status: status},
      Keyword.get(state.opts, :interval_ms, @interval_ms)
    )
  end

  defp schedule(state, :infinity), do: %{state | timer: nil}
  defp schedule(state, delay), do: %{state | timer: Process.send_after(self(), :index, delay)}

  # An unlinked task must not outlive its owner and overlap a restarted
  # indexer. Killing the task also lets Runner's OS-process guard reap the CLI.
  defp watch_owner(owner, task) do
    spawn(fn ->
      owner_ref = Process.monitor(owner)
      task_ref = Process.monitor(task)

      receive do
        {:DOWN, ^owner_ref, :process, _, _} -> Process.exit(task, :kill)
        {:DOWN, ^task_ref, :process, _, _} -> :ok
      end
    end)
  end
end
