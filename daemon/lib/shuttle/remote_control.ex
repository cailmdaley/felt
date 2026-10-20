defmodule Shuttle.RemoteControl do
  @moduledoc """
  Reconciles one host-local Claude Remote Control environment in tmux.

  tmux owns the process across daemon restarts. Its script digest identifies
  the desired launch, and session creation / pane death timestamps measure
  lifetime even when a fresh daemon adopts a dead pane. Uncertain observations
  hold the session rather than authorizing another host.
  """
  use GenServer

  alias Shuttle.{Dispatcher, Host, Tmux, TmuxServer, WorkerProcess}

  @session "shuttle-remote-control"
  @target "=" <> @session <> ":"
  @format Enum.join(
            [
              "\#{@shuttle_rc_script_sha}",
              "\#{pane_dead}",
              "\#{pane_dead_status}",
              "\#{pane_pid}",
              "\#{session_created}",
              "\#{pane_dead_time}"
            ],
            "|"
          )
  @interval 30_000

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  def status(server \\ Shuttle.Env.server(__MODULE__)), do: GenServer.call(server, :status)
  def reconcile(server), do: GenServer.call(server, :reconcile, :infinity)

  @impl true
  def init(opts) do
    state = %{
      runner: Keyword.get(opts, :runner, Shuttle.Runner.Default),
      config: Keyword.get(opts, :config, &Host.remote_control/0),
      clock: Keyword.get(opts, :clock, fn -> System.system_time(:second) end),
      interval: Keyword.get(opts, :interval_ms, @interval),
      timer: nil,
      digest: nil,
      observed: nil,
      failures: 0,
      status: %{
        state: :starting,
        dir: nil,
        args: [],
        pid: nil,
        started_at: nil,
        restarts: 0,
        last_exit: nil,
        next_attempt_at: nil,
        message: nil
      }
    }

    {:ok, state, {:continue, :reconcile}}
  end

  @impl true
  def handle_continue(:reconcile, state), do: {:noreply, tick(state) |> schedule()}

  @impl true
  def handle_call(:status, _from, state), do: {:reply, state.status, state}

  def handle_call(:reconcile, _from, state) do
    if state.timer, do: Process.cancel_timer(state.timer)
    state = tick(state) |> schedule()
    {:reply, state.status, state}
  end

  @impl true
  def handle_info(:reconcile, state), do: {:noreply, tick(state) |> schedule()}

  defp schedule(%{interval: :infinity} = state), do: state

  defp schedule(state) do
    delay =
      case state.status.next_attempt_at do
        nil -> state.interval
        at -> min(state.interval, max(DateTime.to_unix(at) - state.clock.(), 1) * 1_000)
      end

    %{state | timer: Process.send_after(self(), :reconcile, delay)}
  end

  defp tick(state) do
    desired = state.config.()
    now = state.clock.()

    case observe(state.runner) do
      {:error, message} ->
        update(state, state: :error, message: message)

      observation ->
        reconcile_desired(state, desired, observation, now)
    end
  end

  defp reconcile_desired(state, nil, :gone, _now) do
    %{
      update(state,
        state: :disabled,
        dir: nil,
        args: [],
        pid: nil,
        started_at: nil,
        next_attempt_at: nil,
        message: nil
      )
      | digest: nil,
        observed: nil,
        failures: 0
    }
  end

  defp reconcile_desired(state, nil, {:ok, _pane}, now) do
    case stop(state) do
      :ok -> reconcile_desired(state, nil, :gone, now)
      {:error, message} -> update(state, state: :error, message: message)
    end
  end

  defp reconcile_desired(state, {:ok, config}, observation, now) do
    script = script(config)
    digest = :crypto.hash(:sha256, script) |> Base.encode16(case: :lower)
    changed = state.digest != nil and state.digest != digest
    state = %{state | digest: digest}
    state = update(state, dir: config.dir, args: config.args)
    state = if changed, do: reset_backoff(state), else: state

    case observation do
      {:ok, %{digest: ^digest, dead: false} = pane} ->
        running(state, pane)

      {:ok, %{digest: ^digest, dead: true} = pane} ->
        state |> record_exit(pane, now) |> maybe_spawn(config, script, now, true)

      {:ok, different} ->
        state = if different.dead, do: record_exit(state, different, now), else: state

        case stop(state) do
          :ok -> reset_backoff(state) |> maybe_spawn(config, script, now, false)
          {:error, message} -> update(state, state: :error, message: message)
        end

      :gone ->
        state =
          if state.observed do
            record_exit(state, %{created: state.observed, ended: nil, exit_status: nil}, now)
          else
            state
          end

        maybe_spawn(state, config, script, now, false)
    end
  end

  defp running(state, pane) do
    %{
      update(state,
        state: :running,
        pid: pane.pid,
        started_at: timestamp(pane.created),
        next_attempt_at: nil,
        message: nil
      )
      | observed: pane.created
    }
  end

  defp record_exit(state, pane, now) do
    # A dead pane remains in tmux during backoff. Count it only once.
    if state.status.next_attempt_at do
      state
    else
      screen = Map.get(pane, :screen, [])
      # A disappeared session has no death timestamp; a delayed poll must not
      # turn an unobserved short failure into a healthy lifetime.
      lifetime = if pane.ended, do: max(pane.ended - pane.created, 0), else: 0
      failures = if lifetime >= 60, do: 0, else: state.failures
      delay = min(2 * Integer.pow(2, min(failures, 8)), 300)

      %{
        update(state,
          state: :waiting,
          pid: nil,
          last_exit: %{status: pane.exit_status, at: timestamp(pane.ended || now), screen: screen},
          next_attempt_at: timestamp(now + delay),
          message: "Remote Control exited; retrying"
        )
        | failures: failures + 1,
          observed: nil
      }
    end
  end

  defp maybe_spawn(state, config, script, now, dead?) do
    due = state.status.next_attempt_at

    if due && DateTime.to_unix(due) > now do
      update(state, state: :waiting)
    else
      with :ok <- if(dead?, do: stop(state), else: :ok),
           :ok <- TmuxServer.ensure_available(state.runner),
           :ok <- confirm_server(state.runner),
           :ok <- spawn_host(state, config, script) do
        # The next observation supplies the pane pid and actual creation time.
        %{
          update(state,
            state: :starting,
            pid: nil,
            started_at: timestamp(now),
            restarts: state.status.restarts + 1,
            next_attempt_at: nil,
            message: nil
          )
          | observed: now
        }
      else
        {:error, reason} ->
          message = if is_binary(reason), do: reason, else: inspect(reason)
          # A failed/timeout launch can have created a session. The next tick
          # observes it before considering any retry.
          state =
            record_exit(
              update(state, next_attempt_at: nil),
              %{created: now, ended: now, exit_status: nil},
              now
            )

          update(state, state: :error, message: message)
      end
    end
  end

  defp reset_backoff(state),
    do: %{update(state, next_attempt_at: nil) | failures: 0, observed: nil}

  # TmuxServer permits uncertainty for worker dispatch. This reconciler only
  # launches after definite observations, including the server preflight.
  defp confirm_server(runner) do
    case TmuxServer.presence(runner) do
      :unknown -> {:error, "Remote Control tmux server is uncertain; holding"}
      _present_or_absent -> :ok
    end
  end

  defp stop(state) do
    case Tmux.stop(state.runner, @session) do
      {_, 0} -> :ok
      {output, _} -> {:error, "Cannot stop Remote Control: #{output}"}
    end
  end

  defp observe(runner) do
    case Tmux.session_status(runner, @session) do
      :gone -> :gone
      :unknown -> {:error, "Remote Control tmux session is uncertain; holding"}
      :alive -> pane(runner)
    end
  end

  defp pane(runner) do
    case runner.cmd("tmux", ["display-message", "-p", "-t", @target, @format],
           stderr_to_stdout: true
         ) do
      {output, 0} ->
        with {:ok, pane} <- parse_pane(String.trim_trailing(output, "\n")) do
          if pane.dead do
            with {:ok, screen} <- capture(runner), do: {:ok, Map.put(pane, :screen, screen)}
          else
            {:ok, pane}
          end
        end

      {output, _} ->
        {:error, "Cannot inspect Remote Control pane: #{output}"}
    end
  end

  defp parse_pane(output) do
    with [digest, dead, status, pid, created, ended] <- String.split(output, "|"),
         true <- dead in ["0", "1"],
         {pid, ""} <- Integer.parse(pid),
         {created, ""} <- Integer.parse(created),
         {:ok, ended} <- optional_integer(ended),
         {:ok, status} <- optional_integer(status),
         true <- dead == "0" or is_integer(ended) do
      {:ok,
       %{
         digest: digest,
         dead: dead == "1",
         pid: pid,
         created: created,
         ended: ended,
         exit_status: status
       }}
    else
      _ -> {:error, "Cannot parse Remote Control pane metadata #{inspect(output)}; holding"}
    end
  end

  defp optional_integer(""), do: {:ok, nil}

  defp optional_integer(value) do
    case Integer.parse(value) do
      {n, ""} -> {:ok, n}
      _ -> :error
    end
  end

  defp capture(runner) do
    case runner.cmd("tmux", ["capture-pane", "-p", "-t", @target, "-S", "-100"],
           stderr_to_stdout: true
         ) do
      {screen, 0} ->
        {:ok,
         screen |> String.split("\n") |> Enum.reject(&(String.trim(&1) == "")) |> Enum.take(-20)}

      {output, _} ->
        {:error, "Cannot capture Remote Control screen: #{String.trim(output)}; holding"}
    end
  end

  defp spawn_host(state, config, script) do
    path = WorkerProcess.script_path(@session)

    with :ok <- File.write(path, script),
         :ok <- File.chmod(path, 0o700) do
      # An empty pane cannot race to exit before remain-on-exit and the digest
      # are set. Only respawn-pane starts the login shell / host command.
      args = [
        "new-session",
        "-d",
        "-s",
        @session,
        "-c",
        config.dir,
        "",
        ";",
        "set-option",
        "-w",
        "-t",
        @target,
        "remain-on-exit",
        "on",
        ";",
        "set-option",
        "-t",
        @target,
        "@shuttle_rc_script_sha",
        state.digest,
        ";",
        "respawn-pane",
        "-k",
        "-t",
        @target,
        "-c",
        config.dir,
        "bash",
        "-l",
        path
      ]

      case state.runner.cmd("tmux", args, stderr_to_stdout: true) do
        {_, 0} -> :ok
        {output, _} -> {:error, "Cannot start Remote Control: #{output}"}
      end
    else
      {:error, reason} -> {:error, "Cannot write Remote Control script: #{inspect(reason)}"}
    end
  end

  @doc false
  def script(%{dir: dir, args: args}) do
    """
    #!/bin/bash
    trap 'rm -f "$0"' EXIT
    #{Dispatcher.erts_scrub_block()}
    cd #{shell_quote(dir)} || exit $?
    command claude remote-control #{Enum.map_join(args, " ", &shell_quote/1)}
    exit $?
    """
  end

  defp shell_quote(value), do: "'" <> String.replace(value, "'", "'\\''") <> "'"
  defp timestamp(seconds), do: DateTime.from_unix!(seconds)
  defp update(state, fields), do: %{state | status: Map.merge(state.status, Map.new(fields))}
end
