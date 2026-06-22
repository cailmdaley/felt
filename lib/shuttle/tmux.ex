defmodule Shuttle.Tmux do
  @moduledoc """
  Shared classification of a tmux session's liveness from `tmux has-session`.

  The naive read — "exit 0 means alive, ANY non-zero means dead" — conflates two
  very different outcomes: the session is genuinely *gone* (the worker exited),
  versus the `has-session` command *failed for an environmental reason* (tmux
  binary not on PATH, a transient server hiccup, a fork/exec failure under load).
  Treating the second as death is how a *live* worker gets declared dead and then
  re-dispatched — the resume storm this module exists to prevent.

  So we classify three ways:

    * `:alive`   — exit 0; the session exists.
    * `:gone`    — non-zero AND the output is tmux's own absence message
                   ("can't find session", "no server running", …). A real worker
                   death. The only result that should count toward declaring a
                   worker dead or freeing its name for a fresh dispatch.
    * `:unknown` — non-zero for any other reason. Uncertain — treated as
                   still-present everywhere it matters (the watcher holds instead
                   of striking; dispatch refuses-and-adopts instead of resuming),
                   so uncertainty never kills a live worker. A genuinely-dead
                   worker still emits `:gone` on its next check, so this never
                   strands a dead worker for long.
  """

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
  Classifies the named session via `tmux has-session`. `runner` is any module
  exposing `cmd/3` (the `Shuttle.Runner` behaviour); the `=` exact-match prefix
  is applied here so callers pass the bare session name.
  """
  @spec session_status(module(), String.t()) :: status()
  def session_status(runner, session) do
    case runner.cmd("tmux", ["has-session", "-t", "=" <> session], stderr_to_stdout: true) do
      {_, 0} -> :alive
      {output, _} -> if absent?(output), do: :gone, else: :unknown
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

  defp absent?(output) do
    down = String.downcase(to_string(output))
    Enum.any?(@absence_markers, &String.contains?(down, &1))
  end
end
