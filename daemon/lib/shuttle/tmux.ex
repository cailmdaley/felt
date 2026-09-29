defmodule Shuttle.Tmux do
  @moduledoc """
  Shared classification of a tmux session's liveness.

  A worker is its processes; tmux is the view humans and the daemon reach them
  through. So `tmux has-session` is asked first and the process table
  (`Shuttle.WorkerProcess`) settles what tmux cannot. The naive read — "exit 0
  means alive, ANY non-zero means dead" — conflates three outcomes: the worker
  genuinely exited; `has-session` failed for an environmental reason (tmux not
  on PATH, a server hiccup, a fork failure under load); or tmux's server lost
  its socket file (`/tmp/tmux-<uid>/default` deleted) and answers "no server
  running" while every worker under it still runs. Reading the second or
  third as death re-dispatches a live worker — a resume onto the transcript it
  still holds.

  So we classify three ways:

    * `:alive`   — exit 0; the session exists.
    * `:gone`    — tmux's own absence message ("can't find session", "no
                   server running", …) AND no live process of this daemon's
                   uid runs the session's run script. A real worker death, and
                   the only result that counts toward declaring a worker dead
                   or frees its name for a fresh dispatch.
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
          "(bash pid #{proc.pid}, parent #{proc.ppid}) — the tmux socket was likely " <>
          "deleted under a live server. Holding it as present; to recover, " <>
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

  Returns the `kill-session` result as-is when the kill fails (including
  tmux's "already gone" messages, which the caller classifies); `{"", 0}`
  once the worker is gone; `{message, 1}` when it survives the ladder.
  """
  @spec stop(module(), String.t()) :: {String.t(), integer()}
  def stop(runner, session) do
    case runner.cmd("tmux", ["kill-session", "-t", session], stderr_to_stdout: true) do
      {_output, 0} -> await_gone(runner, session, stop_ladder())
      failure -> failure
    end
  end

  @stop_ladder [{nil, 3_000}, {"TERM", 2_000}, {"KILL", 1_000}]
  @stop_poll_ms 50

  defp stop_ladder, do: Application.get_env(:shuttle, :worker_stop_ladder, @stop_ladder)

  defp await_gone(_runner, session, []),
    do: {"worker of #{session} is still running after SIGKILL", 1}

  defp await_gone(runner, session, [{signal, wait_ms} | rest]) do
    if signal, do: signal_worker(runner, session, signal)
    deadline = System.monotonic_time(:millisecond) + wait_ms

    if gone_by?(runner, session, deadline),
      do: {"", 0},
      else: await_gone(runner, session, rest)
  end

  defp gone_by?(runner, session, deadline) do
    cond do
      session_status(runner, session) == :gone ->
        true

      System.monotonic_time(:millisecond) >= deadline ->
        false

      true ->
        Process.sleep(@stop_poll_ms)
        gone_by?(runner, session, deadline)
    end
  end

  # The run script is the pane's process and so leads its own process group,
  # which holds the harness; the group and the process are both signalled in
  # case it does not lead one.
  defp signal_worker(runner, session, signal) do
    with {:ok, procs} <- WorkerProcess.scan(runner),
         %{pid: pid} <- WorkerProcess.session_process(procs, session) do
      runner.cmd("kill", ["-#{signal}", "--", "-#{pid}", "#{pid}"], stderr_to_stdout: true)
    end

    :ok
  end

  @doc """
  True when `output` is one of tmux's own absence messages ("no server
  running", "can't find session", …) — POSITIVE evidence that the server or
  session is not there, as opposed to a command that merely failed. Shared by
  every surface that must distinguish absence-evidence from uncertainty (e.g.
  the poller's `list_shuttle_sessions/1`).
  """
  @spec absence_message?(term()) :: boolean()
  def absence_message?(output), do: absent?(output)

  defp absent?(output) do
    down = String.downcase(to_string(output))
    Enum.any?(@absence_markers, &String.contains?(down, &1))
  end
end
