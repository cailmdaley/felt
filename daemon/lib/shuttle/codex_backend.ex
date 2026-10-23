defmodule Shuttle.CodexBackend do
  @moduledoc """
  Ensures a host-local Codex App Server without owning its process lifetime.

  Reconciliation runs off the mailbox with bounded I/O. tmux serializes starts
  by endpoint identity and owns the server across manager/daemon restarts.
  No path in this module kills a server, removes a socket, or replaces a live pane.
  """
  use GenServer
  alias Shuttle.{CodexEndpoint, Tmux, TmuxServer, WorkerProcess}

  defmodule BoundedRunner do
    def cmd(command, args, opts),
      do: Shuttle.Runner.Default.cmd(command, args, Keyword.put_new(opts, :timeout_ms, 3_000))
  end

  def start_link(opts \\ []),
    do: GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))

  def status do
    module = Shuttle.Env.app(:codex_backend, __MODULE__)
    if module == __MODULE__, do: status(Shuttle.Env.server(__MODULE__)), else: module.status()
  end

  def status(server) do
    GenServer.call(server, :status, 500)
  catch
    :exit, _ ->
      %{
        state: :waiting,
        endpoint: Shuttle.CodexApp.Transport.default_socket(),
        error: "Codex backend manager unavailable"
      }
  end

  def require_ready do
    case status() do
      %{state: :ready} ->
        :ok

      health ->
        {:error,
         {:backend_not_ready,
          "Codex backend is waiting: #{health[:error] || health.state}. See /api/v1/version codex_backend; no conversation was created."}}
    end
  end

  def reconcile(server), do: GenServer.cast(server, :reconcile)

  @impl true
  def init(opts) do
    {:ok,
     %{
       opts: opts,
       task: nil,
       timer: nil,
       failures: 0,
       next_attempt: 0,
       status: %{state: :starting, endpoint: nil, error: nil, next_attempt_at: nil}
     }, {:continue, :reconcile}}
  end

  @impl true
  def handle_continue(:reconcile, state), do: {:noreply, begin_check(state)}
  @impl true
  def handle_call(:status, _from, state), do: {:reply, state.status, state}
  @impl true
  def handle_cast(:reconcile, state), do: {:noreply, begin_check(state)}
  @impl true
  def handle_info(:reconcile, state), do: {:noreply, begin_check(%{state | timer: nil})}

  def handle_info({ref, result}, %{task: %{ref: ref}} = state) do
    Process.demonitor(ref, [:flush])
    Process.cancel_timer(state.task.deadline)
    now = System.system_time(:millisecond)

    {failures, next} =
      case result.state do
        :ready ->
          {0, 0}

        _ ->
          if now < state.next_attempt,
            do: {state.failures, state.next_attempt},
            else:
              {state.failures + 1,
               now + min(2_000 * Integer.pow(2, min(state.failures, 8)), 300_000)}
      end

    status =
      Map.put(result, :next_attempt_at, if(next > 0, do: DateTime.from_unix!(next, :millisecond)))

    {:noreply,
     schedule(%{state | task: nil, failures: failures, next_attempt: next, status: status})}
  end

  def handle_info({:DOWN, ref, :process, _pid, reason}, %{task: %{ref: ref}} = state) do
    Process.cancel_timer(state.task.deadline)
    {:noreply, failed_check(state, "Codex observation failed: #{inspect(reason)}")}
  end

  def handle_info({:check_timeout, ref}, %{task: %{ref: ref, pid: pid}} = state) do
    Process.exit(pid, :kill)
    Process.demonitor(ref, [:flush])
    {:noreply, failed_check(state, "Codex observation timed out; backend liveness is uncertain")}
  end

  def handle_info(_, state), do: {:noreply, state}

  defp failed_check(state, error) do
    schedule(%{
      state
      | task: nil,
        next_attempt: System.system_time(:millisecond) + 30_000,
        status: Map.merge(state.status, %{state: :waiting, error: error})
    })
  end

  defp begin_check(%{task: task} = state) when task != nil, do: state

  defp begin_check(state) do
    if state.timer, do: Process.cancel_timer(state.timer)

    opts =
      Keyword.put(state.opts, :launch?, System.system_time(:millisecond) >= state.next_attempt)

    task = Task.Supervisor.async_nolink(Shuttle.TaskSupervisor, fn -> check(opts) end)
    deadline = Process.send_after(self(), {:check_timeout, task.ref}, 15_000)
    %{state | task: %{ref: task.ref, pid: task.pid, deadline: deadline}, timer: nil}
  end

  defp schedule(state) do
    case Keyword.get(state.opts, :interval_ms, 5_000) do
      :infinity -> state
      delay -> %{state | timer: Process.send_after(self(), :reconcile, delay)}
    end
  end

  @doc false
  def check(opts) do
    endpoint = Keyword.get_lazy(opts, :endpoint, &CodexEndpoint.current/0)

    case endpoint do
      {:ok, path} ->
        case with :ok <- CodexEndpoint.ensure_root(path), do: CodexEndpoint.verify_socket(path) do
          :ok -> check_endpoint(path, opts)
          {:error, error} -> %{state: :waiting, endpoint: path, error: error}
        end

      {:error, error} ->
        %{state: :waiting, endpoint: nil, error: inspect(error)}
    end
  end

  defp check_endpoint(path, opts) do
    probe = Keyword.get(opts, :probe, &probe/1)

    case probe.(path) do
      :ok ->
        %{state: :ready, endpoint: path, error: nil}

      {:error, reason} ->
        runner = Keyword.get(opts, :runner, BoundedRunner)

        case absent?(path, runner, reason) do
          {:ok, slot} ->
            if Keyword.get(opts, :launch?, true),
              do: launch(path, runner, slot),
              else: %{
                state: :waiting,
                endpoint: path,
                error: "Codex launch backoff: #{inspect(reason)}"
              }

          {:error, error} ->
            %{state: :waiting, endpoint: path, error: error}
        end
    end
  end

  @doc "Initialize a real connection without creating a project, thread or model turn."
  def probe(path) do
    case Shuttle.CodexApp.Transport.start_link(socket_path: path, connect_timeout: 1_000) do
      {:ok, client} ->
        Shuttle.CodexApp.Transport.close(client)
        :ok

      error ->
        error
    end
  end

  defp absent?(path, runner, reason) do
    with {:ok, processes} <- WorkerProcess.scan(runner),
         false <- Enum.any?(processes, &holder?(&1, path)),
         {:ok, slot} <- slot(path, runner),
         :ok <- socket_absent_or_owned_dead(path, slot, reason) do
      {:ok, slot}
    else
      true ->
        {:error, "A live process holds the Codex endpoint; holding without replacement"}

      other ->
        {:error, "Codex backend liveness is uncertain: #{inspect(other)}"}
    end
  end

  defp socket_absent_or_owned_dead(path, slot, reason) do
    case File.lstat(path) do
      {:error, :enoent} ->
        :ok

      {:ok, _}
      when slot == :dead and reason in [{:transport, :econnrefused}, {:transport, :enoent}] ->
        # The retained owned pane proves death. Codex's native per-endpoint
        # lock and connect-before-unlink guard reclaim its stale socket. Doing
        # our own unlink here would race a parallel start or external owner.
        :ok

      _ ->
        {:error, "Codex socket exists but is not ready; holding without replacement"}
    end
  end

  defp slot(path, runner) do
    case Tmux.session_status(runner, session(path)) do
      :gone ->
        {:ok, :new}

      :alive ->
        case runner.cmd(
               "tmux",
               [
                 "display-message",
                 "-p",
                 "-t",
                 "=" <> session(path) <> ":",
                 "\#{pane_dead}|\#{@shuttle_codex_endpoint}"
               ],
               stderr_to_stdout: true
             ) do
          {output, 0} when output == "1|" <> path <> "\n" -> {:ok, :dead}
          other -> {:error, {:existing_pane, other}}
        end

      :unknown ->
        {:error, :tmux_uncertain}
    end
  end

  defp holder?(process, path) do
    args = process.args

    server =
      String.contains?(args, "app-server") and String.contains?(args, "--listen") and
        String.contains?(args, path)

    launch_script = String.contains?(args, "shuttle-run-" <> session(path) <> ".")
    # --remote viewers are clients, not evidence that the dead server lives.
    server or launch_script
  end

  defp launch(path, runner, slot) do
    with :ok <- TmuxServer.ensure_available(runner),
         presence when presence != :unknown <- TmuxServer.presence(runner),
         {:ok, script} <- write_script(path),
         args = launch_args(path, script, slot),
         {_, 0} <- runner.cmd("tmux", args, stderr_to_stdout: true) do
      %{state: :starting, endpoint: path, error: "Waiting for Codex initialization"}
    else
      error -> %{state: :waiting, endpoint: path, error: "Codex launch held: #{inspect(error)}"}
    end
  end

  defp launch_args(path, script, :new),
    do: ["new-session", "-d", "-s", session(path), "-c", Path.dirname(path), "bash", "-l", script]

  # No -k: if a parallel manager already revived this pane, tmux refuses.
  defp launch_args(path, script, :dead),
    do: [
      "respawn-pane",
      "-t",
      "=" <> session(path) <> ":",
      "-c",
      Path.dirname(path),
      "bash",
      "-l",
      script
    ]

  def session(path),
    do:
      "shuttle-codex-" <>
        (Base.encode16(:crypto.hash(:sha256, path), case: :lower) |> binary_part(0, 16))

  defp write_script(path) do
    # Unique scripts let parallel managers race only at tmux's atomic session
    # creation, never by rewriting a live session's launch script.
    script =
      Path.join(
        Path.dirname(path),
        "shuttle-run-" <> session(path) <> ".#{System.unique_integer([:positive])}.sh"
      )

    with :ok <- File.write(script, script(path), [:exclusive]),
         :ok <- File.chmod(script, 0o700),
         do: {:ok, script}
  end

  @doc false
  def script(path) do
    home = Shuttle.Env.home()

    codex_home =
      case Shuttle.Env.get("CODEX_HOME") do
        value when value in [nil, ""] -> Path.join(home, ".codex")
        value -> value
      end

    """
    #!/bin/bash
    trap 'rm -f "$0"' EXIT
    # Retain death evidence before starting Codex, even if it dies hard.
    command tmux set-option -w -t "$TMUX_PANE" remain-on-exit on || exit $?
    command tmux set-option -t "$TMUX_PANE" @shuttle_codex_endpoint #{shell_quote(path)} || exit $?
    #{Shuttle.Dispatcher.erts_scrub_block()}
    for name in $(compgen -e); do
      case "$name" in
        TMUX|TMUX_PANE|CODEX_THREAD_ID|CODEX_SESSION_ID|SHUTTLE_FIBER*|SHUTTLE_SESSION*|SHUTTLE_RUN*|FELT_SESSION*|CLAUDECODE|CLAUDE_CODE_SESSION_ID|CLAUDE_SESSION_ID|PI_SESSION_ID|AI_AGENT) unset "$name" ;;
      esac
    done
    export HOME=#{shell_quote(home)} CODEX_HOME=#{shell_quote(codex_home)}
    umask 077
    mkdir -p "$CODEX_HOME" || exit $?
    cd #{shell_quote(home)} || exit $?
    command codex app-server --listen #{shell_quote("unix://" <> path)}
    exit $?
    """
  end

  defp shell_quote(value), do: "'" <> String.replace(value, "'", "'\\''") <> "'"
end
