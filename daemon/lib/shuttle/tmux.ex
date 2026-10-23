defmodule Shuttle.Tmux do
  @moduledoc """
  Shared classification of a tmux session's liveness.

  A worker is its processes; tmux is the view humans and the daemon reach them
  through. A daemon worker is classified and stopped by the process holding
  its execution (`worker_status/2`, `stop_worker/2`), whatever its session is
  called. The name-based classification below serves sessions classified by
  name alone — helper sessions and viewers the daemon names itself — and asks
  `tmux has-session` first, letting the process table
  (`Shuttle.WorkerProcess`) settle what tmux cannot. The naive read — "exit 0
  means alive, ANY non-zero means dead" — conflates three outcomes: the worker
  genuinely exited; `has-session` failed for an environmental reason (tmux not
  on PATH, a server hiccup, a fork failure under load); or tmux's server lost
  its socket file (`/tmp/tmux-<uid>/default` deleted), or listens under a
  different `TMUX_TMPDIR`, and answers "no server running" while every worker
  under it still runs. Reading the second or
  third as death re-dispatches a live worker — a resume onto the transcript it
  still holds.

  So we classify three ways:

    * `:alive`   — exit 0; the session exists.
    * `:gone`    — tmux's own absence message ("can't find session", "no
                   server running", …) AND no live process of this daemon's
                   uid runs the session's run script. A real worker death, and
                   the only result that counts toward declaring a worker
                   dead.
    * `:unknown` — anything else: a non-zero exit without an absence message,
                   an absence message while the session's run script is still
                   running (the worker is alive but tmux cannot reach it), or
                   an absence message the process scan could not check.
                   Treated as still-present everywhere it matters (the watcher
                   holds instead of striking; dispatch refuses-and-adopts
                   instead of resuming), so uncertainty never kills a live
                   worker. A dead worker has neither tmux session nor process,
                   so it reads `:gone` on its next check — unless `ps` itself
                   cannot run on the host, which holds every absent session as
                   `:unknown`.
  """

  alias Shuttle.WorkerProcess

  @type status :: :alive | :gone | :unknown

  # tmux's own "this session/server isn't here" messages. Matched
  # case-insensitively as substrings so a leading "tmux: " prefix or a trailing
  # session name doesn't defeat the check.
  @absence_markers [
    "can't find session",
    "can’t find session",
    "no such session",
    "session not found",
    "no server running",
    "no current session",
    "error connecting"
  ]

  @doc """
  Classifies the named session via `tmux has-session`, consulting the process
  table when tmux reports it absent. `runner` is any module exposing `cmd/3`
  (the `Shuttle.Runner` behaviour); the `=` exact-match prefix is applied here
  so callers pass the bare session name.
  """
  @spec session_status(module(), String.t()) :: status()
  def session_status(runner, session) do
    case runner.cmd("tmux", ["has-session", "-t", "=" <> session], stderr_to_stdout: true) do
      {_, 0} -> :alive
      {output, _} -> if absent?(output), do: absent_status(runner, session), else: :unknown
    end
  end

  # tmux says the session is not there; the process table says whether its
  # worker is.
  defp absent_status(runner, session) do
    with {:ok, procs} <- WorkerProcess.scan(runner),
         %{} = proc <- WorkerProcess.session_process(procs, session) do
      server = WorkerProcess.tmux_server(procs, proc)

      WorkerProcess.warn_once({:unreachable, session}, fn ->
        "tmux cannot see session #{session}, but its worker is running " <>
          "(bash pid #{proc.pid}, parent #{proc.ppid}) — its tmux server is " <>
          "unreachable from this daemon: either the server listens under a " <>
          "different TMUX_TMPDIR than the daemon's, or its socket was deleted. " <>
          "Holding it as present; if the socket was deleted, " <>
          WorkerProcess.recovery_hint(server)
      end)

      :unknown
    else
      {:error, :unknown} -> :unknown
      nil -> :gone
    end
  end

  @doc """
  True when the session should be treated as PRESENT — `:alive` or `:unknown`.
  This is the predicate for "is a worker running here?" guards (dispatch's
  already-running check, the poller's reconcile): uncertainty counts as present,
  so a transient `has-session` failure never lets a resume spawn over a live
  worker. Only a confirmed `:gone` frees the slot.
  """
  @spec present?(module(), String.t()) :: boolean()
  def present?(runner, session), do: session_status(runner, session) != :gone

  @doc """
  Types `text` into tmux session `session` as the human's next message, then
  submits it.

  The text goes in as one bracketed paste (`paste-buffer -p`), so its
  newlines stay inside the message instead of each submitting a line, and
  then Enter submits it. A pane left in copy mode is returned to its
  application first, so the Enter reaches the harness. The pause before Enter
  lets the harness finish taking the paste.
  """
  @spec paste(module(), String.t(), String.t()) :: :ok | {:error, String.t()}
  def paste(runner, session, text) when is_binary(text) do
    buffer = "shuttle-paste-" <> Integer.to_string(System.unique_integer([:positive]))
    path = Path.join(System.tmp_dir!(), buffer)
    File.write!(path, text)

    try do
      runner.cmd("tmux", ["send-keys", "-t", session, "-X", "cancel"], stderr_to_stdout: true)

      with {_, 0} <-
             runner.cmd("tmux", ["load-buffer", "-b", buffer, path], stderr_to_stdout: true),
           {_, 0} <-
             runner.cmd("tmux", ["paste-buffer", "-p", "-d", "-b", buffer, "-t", session],
               stderr_to_stdout: true
             ),
           :ok <- Process.sleep(Shuttle.Env.app(:paste_submit_delay_ms, 400)),
           {_, 0} <-
             runner.cmd("tmux", ["send-keys", "-t", session, "Enter"], stderr_to_stdout: true) do
        :ok
      else
        {output, _status} -> {:error, "tmux: " <> String.trim(to_string(output))}
      end
    after
      File.rm(path)
    end
  end

  @doc """
  Stops tmux session `session` and returns once its worker is gone.

  `kill-session` removes the session and hangs up its pane; the run script
  and its harness then exit on their own schedule — usually within
  milliseconds, sometimes seconds (a harness flushing its transcript on a
  loaded host). Until they do, `session_status/2` reads the session
  `:unknown`, and a fresh dispatch under the same name is refused as already
  running. So a successful kill waits for `:gone`, walking the stop ladder
  (`:worker_stop_ladder`: `{signal | nil, wait_ms}` steps): each step signals
  the run script's process group, then waits up to `wait_ms` for the worker
  to go. The default hangs up and waits, then escalates to SIGTERM, then
  SIGKILL.

  When tmux answers with one of its absence messages, the session is out of
  this daemon's reach but its worker may not be: a server whose socket was
  deleted, or one listening under a different `TMUX_TMPDIR`, still runs it.
  The worker is its processes, so the stop then walks the ladder's signal
  steps against the run script directly; a worker that is already gone reads
  `:gone` on the first check.

  Returns `{"", 0}` once the worker is gone; `{message, 1}` when it survives
  the ladder; and the `kill-session` result as-is when tmux fails without an
  absence message.
  """
  @spec stop(module(), String.t()) :: {String.t(), integer()}
  def stop(runner, session) do
    status = fn -> session_status(runner, session) end
    signal = fn signal -> signal_session(runner, session, signal) end

    case runner.cmd("tmux", ["kill-session", "-t", session], stderr_to_stdout: true) do
      {_output, 0} ->
        await_gone(session, stop_ladder(), status, signal)

      {output, _} = failure ->
        if absent?(output),
          do: await_gone(session, signal_steps(), status, signal),
          else: failure
    end
  end

  @doc """
  Classifies the execution `handle` — `%{session, uuid, pane}` — by the
  process that holds it (`Shuttle.WorkerProcess.find/3`), never by a tmux
  name: `:alive` while a process holds its conversation UUID or bound pane,
  `:gone` when a successful scan shows none, and `:unknown` when the scan or a
  holder's lifetime cannot be observed. A handle with neither a UUID nor a
  pane is classified by its session name (`session_status/2`).
  """
  @spec worker_status(module(), map()) :: status()
  def worker_status(runner, %{} = handle) do
    if identified?(handle) do
      case WorkerProcess.scan(runner) do
        {:ok, procs} ->
          case WorkerProcess.find(procs, handle, runner) do
            nil -> :gone
            {:error, :unknown} -> :unknown
            _proc -> :alive
          end

        {:error, :unknown} ->
          :unknown
      end
    else
      session_status(runner, handle.session)
    end
  end

  @doc """
  Stops the execution `handle` and returns once no process holds it.

  The holder is found in the process table, and its tmux pane by ancestry;
  that exact pane (`%N`) is killed, whatever its session is now called. The
  ladder then waits, escalating to SIGTERM and SIGKILL on the holder's pane
  process group. A holder tmux cannot show is signalled directly. When the
  process table cannot be read, nothing is signalled and the stop fails: an
  uncertain holder is never a kill target. A handle nothing holds is already
  stopped.
  """
  @spec stop_worker(module(), map()) :: {String.t(), integer()}
  def stop_worker(runner, %{} = handle) do
    if identified?(handle) do
      status = fn -> worker_status(runner, handle) end
      signal = fn signal -> signal_holder(runner, handle, signal) end

      with {:ok, procs} <- WorkerProcess.scan(runner),
           %{} = proc <- WorkerProcess.find(procs, handle, runner) do
        killed? =
          with {:ok, panes} <- WorkerProcess.panes(runner),
               %{pane: pane} <- WorkerProcess.pane_of(procs, panes, proc),
               {_, 0} <- runner.cmd("tmux", ["kill-pane", "-t", pane], stderr_to_stdout: true) do
            true
          else
            _ -> false
          end

        label = handle.session || handle.uuid
        await_gone(label, if(killed?, do: stop_ladder(), else: signal_steps()), status, signal)
      else
        nil ->
          {"", 0}

        {:error, :unknown} ->
          {"the worker's processes could not be observed, so nothing was signalled", 1}
      end
    else
      stop(runner, handle.session)
    end
  end

  defp identified?(handle),
    do: is_binary(Map.get(handle, :uuid)) or is_map(Map.get(handle, :pane))

  @stop_ladder [{nil, 3_000}, {"TERM", 2_000}, {"KILL", 1_000}]
  @stop_poll_ms 50

  defp stop_ladder, do: Shuttle.Env.app(:worker_stop_ladder, @stop_ladder)
  defp signal_steps, do: Enum.filter(stop_ladder(), &elem(&1, 0))

  defp await_gone(label, [], _status, _signal),
    do: {"worker of #{label} is still running after SIGKILL", 1}

  defp await_gone(label, [{signal, wait_ms} | rest], status, signal_fun) do
    if signal, do: signal_fun.(signal)
    deadline = System.monotonic_time(:millisecond) + wait_ms

    if gone_by?(status, deadline),
      do: {"", 0},
      else: await_gone(label, rest, status, signal_fun)
  end

  defp gone_by?(status, deadline) do
    cond do
      status.() == :gone ->
        true

      System.monotonic_time(:millisecond) >= deadline ->
        false

      true ->
        Process.sleep(@stop_poll_ms)
        gone_by?(status, deadline)
    end
  end

  # The run script is the pane's process and so leads its own process group,
  # which holds the harness; the group and the process are both signalled in
  # case it does not lead one.
  defp signal_session(runner, session, signal) do
    with {:ok, procs} <- WorkerProcess.scan(runner),
         %{pid: pid} <- WorkerProcess.session_process(procs, session) do
      kill(runner, signal, pid)
    end

    :ok
  end

  # Re-found on every step: only a process that holds the execution now is
  # signalled, through the outermost process of its pane.
  defp signal_holder(runner, handle, signal) do
    with {:ok, procs} <- WorkerProcess.scan(runner),
         %{} = proc <- WorkerProcess.find(procs, handle, runner) do
      kill(runner, signal, WorkerProcess.signal_root(procs, proc).pid)
    end

    :ok
  end

  defp kill(runner, signal, pid),
    do: runner.cmd("kill", ["-#{signal}", "--", "-#{pid}", "#{pid}"], stderr_to_stdout: true)

  @doc """
  True when `output` is one of tmux's own absence messages ("no server
  running", "can't find session", …) — POSITIVE evidence that the server or
  session is not there, as opposed to a command that merely failed. Shared by
  every surface that must distinguish absence-evidence from uncertainty (e.g.
  `Shuttle.WorkerProcess.panes/1`).
  """
  @spec absence_message?(term()) :: boolean()
  def absence_message?(output), do: absent?(output)

  defp absent?(output) do
    down = String.downcase(to_string(output))
    Enum.any?(@absence_markers, &String.contains?(down, &1))
  end
end
