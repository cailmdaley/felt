defmodule Shuttle.TmuxServer do
  @moduledoc """
  On macOS, the daemon must never be the process that ROOTS the tmux server.

  `tmux new-session` forks a server when none is running, and that server
  inherits its position in the process tree from whoever ran the command. When
  the daemon dispatches the first worker of the day, the server it forks is a
  descendant of the daemon's beam — and macOS privacy (TCC) charges every file
  access in a process tree to the tree's *responsible process*. For a
  launchd-spawned chain that responsible process is the daemon's own executable
  (surfaced to the human as "erlexec"). So every worker under that server —
  Claude Code, its shells, every tool it runs — raises "erlexec wants to access
  data from other apps" / Documents / Downloads prompts, and the daemon binary
  cannot hold the grants (FDA does not inherit under launchd; the launchd plist
  header documents this).

  The fix is not to route dispatch through something else — `tmux new-session`'s
  exit status is the dispatch's ground truth and must stay so. The fix is to
  make sure a tmux server ALREADY EXISTS, forked from the user's own terminal,
  before the daemon ever runs `new-session`. The daemon already remote-controls
  kitty (`Shuttle.Kitty`), so it asks kitty to fork the server: `kitty @ launch
  --type=background` runs a command as a child of the kitty app, with no window,
  and TCC then charges kitty — an app the human can grant once.

  Three outcomes, and the middle one is the point:

    * a server is present (or its presence can't be determined) → `:ok`,
      dispatch proceeds untouched
    * no server, kitty reachable → kitty forks an anchor session, we wait for
      the socket, disarm `exit-empty`, then `:ok`
    * no server, kitty unreachable → dispatch is **REFUSED** with an
      operator-facing message. The daemon never quietly starts the server
      itself; a silent success here is exactly the state that poisons a whole
      day of workers with permission prompts.

  Non-darwin hosts (every remote in the fleet is Linux, where no such
  attribution exists) are unaffected: `ensure_available/1` returns `:ok`
  unconditionally.

  ## Attribution

  Whether a *running* server is daemon-rooted is answered by the Go CLI, not
  here, and it asks the kernel rather than guessing: `launchctl print
  pid/<server pid>` (no privileges needed, unlike `launchctl procinfo`, which
  requires root) prints the process's resource coalition, whose `name` is the
  launchd label or app bundle that rooted the tree — exactly the attribution TCC
  charges file access to. A coalition of `io.shuttle.daemon` is a daemon-born
  server; anything else is user-born. See `cmd/shuttle_tmux_origin.go`; nothing
  in this module needs to stamp or read a marker.
  """

  require Logger

  @type presence :: :present | :absent | :unknown

  # The session kitty starts to hold a fresh server alive. It deliberately does
  # NOT end in `-shuttle`, so every "is this a worker?" predicate in the system
  # (`Shuttle.Dispatcher.shuttle_session?/1`, the poller's
  # `list_shuttle_sessions/1`, Go's `isShuttleTmuxSessionName`) ignores it.
  @anchor "shuttle-anchor"

  # Poll budget for the server appearing after kitty forks it. Generous enough
  # for a cold `kitty @ launch` round trip, short enough that a dispatch tick
  # never stalls on it.
  @await_budget_ms 3_000
  @await_interval_ms 100

  @doc """
  Ensures this host has a tmux server the daemon did not fork.

  `:ok` on every non-darwin host, and on darwin whenever a server is present or
  its presence is uncertain. Otherwise asks kitty to fork one; a kitty failure
  or a server that never appears is `{:error, {:tmux_server_unavailable,
  message}}`, and the message is rendered verbatim on every failure surface.
  """
  @spec ensure_available(module()) :: :ok | {:error, {:tmux_server_unavailable, String.t()}}
  def ensure_available(runner) do
    case os_type() do
      {:unix, :darwin} -> ensure_darwin(runner)
      _ -> :ok
    end
  end

  defp ensure_darwin(runner) do
    case presence(runner) do
      # A server we did not fork is exactly what we want — and while we have it,
      # harden it against dying out from under the `new-session` that follows.
      :present ->
        disarm_exit_empty(runner)

      # Uncertainty never blocks — the same doctrine as `Shuttle.Tmux.present?/2`.
      # A `tmux ls` that fails for an environmental reason must not refuse a
      # dispatch that would have worked. Nothing to harden either: there may be
      # no server there at all.
      :unknown ->
        :ok

      :absent ->
        start_server(runner)
    end
  end

  defp start_server(runner) do
    with :ok <- start_via_kitty(),
         :ok <- await_server(runner, @await_budget_ms) do
      disarm_exit_empty(runner)
      Logger.info("Started a tmux server via kitty (anchor session #{@anchor})")
      :ok
    else
      {:error, reason} -> refuse(reason)
      :timeout -> refuse("kitty accepted the command but no tmux server appeared")
    end
  end

  @doc """
  Whether a tmux server is running on this host.

  `:present` on exit 0; `:absent` only on a non-zero exit whose output is one of
  tmux's own absence messages (positive evidence — shared with
  `Shuttle.Tmux`); `:unknown` for every other failure, including a timeout.
  """
  @spec presence(module()) :: presence()
  def presence(runner) do
    case runner.cmd("tmux", ["ls", "-F", "\#{session_name}"], stderr_to_stdout: true) do
      {_output, 0} -> :present
      {_output, :timeout} -> :unknown
      {output, _status} -> if Shuttle.Tmux.absence_message?(output), do: :absent, else: :unknown
    end
  end

  @doc """
  Asks kitty to fork a tmux server holding an anchor session.

  `tmux start-server` alone is useless here: it exits 0 and the server
  immediately dies to `exit-empty` (verified). The server needs one session to
  hold it up, and the anchor's payload is an effectively-infinite sleep rather
  than a shell, so nothing is attached to it and nothing can wander off.
  """
  @spec start_via_kitty() :: :ok | {:error, String.t()}
  def start_via_kitty do
    kitty_impl().run_background([
      "tmux",
      "new-session",
      "-d",
      "-s",
      @anchor,
      "--",
      "sh",
      "-c",
      "exec sleep 2147483647"
    ])
  end

  @doc """
  Polls `presence/1` until a server answers, or `budget_ms` elapses.
  """
  @spec await_server(module(), non_neg_integer()) :: :ok | :timeout
  def await_server(runner, budget_ms) do
    deadline = System.monotonic_time(:millisecond) + budget_ms
    do_await(runner, deadline)
  end

  defp do_await(runner, deadline) do
    case presence(runner) do
      :present ->
        :ok

      _ ->
        if System.monotonic_time(:millisecond) + @await_interval_ms > deadline do
          :timeout
        else
          Process.sleep(@await_interval_ms)
          do_await(runner, deadline)
        end
    end
  end

  @doc """
  Turns `exit-empty` off on this host's tmux server.

  A server with no sessions exits by default, and the window between
  `presence/1` answering `:present` and the dispatcher's `tmux new-session` is
  real: a human who detaches and closes their last session in it loses the
  server, and `new-session` then forks a fresh one — rooted at the daemon,
  which is the entire state this module exists to prevent. Disarming
  `exit-empty` makes an anchor-less, human-started server survive that window.

  Server-scoped and idempotent (`set-option -s`), and — unlike `new-session` —
  it never forks a server of its own: with no server running it just fails
  ("error connecting to /tmp/tmux-<uid>/default", verified). It is called only
  with a server present or just started anyway, and a failure is deliberately
  ignored: losing the hardening must not refuse a dispatch that would have
  worked.
  """
  @spec disarm_exit_empty(module()) :: :ok
  def disarm_exit_empty(runner) do
    runner.cmd("tmux", ["set-option", "-s", "exit-empty", "off"], stderr_to_stdout: true)
    :ok
  end

  @doc """
  The operator-facing refusal, rendered verbatim on the board, the 422, and the
  daemon log. It has to carry the whole story: the human's only visible symptom
  is a stream of "erlexec" permission prompts, which names nothing they own.
  """
  @spec refusal_message(String.t()) :: String.t()
  def refusal_message(kitty_error) do
    "No tmux server is running on this machine, and Shuttle could not ask kitty to start one " <>
      "(#{kitty_error}). On macOS the daemon must never start the tmux server itself: every " <>
      "process under it — the worker, its shells, its tools — would be charged to the daemon's " <>
      "binary by macOS privacy (TCC), so each one raises an \"erlexec wants to access data from " <>
      "other apps\" prompt and the daemon cannot hold those grants. Start a tmux server from " <>
      "your kitty terminal (`tmux new-session -d -s #{@anchor}`) or open kitty with remote " <>
      "control enabled, then dispatch again."
  end

  defp refuse(reason) do
    {:error, {:tmux_server_unavailable, refusal_message(to_string(reason))}}
  end

  defp kitty_impl, do: Application.get_env(:shuttle, :kitty_impl, Shuttle.Kitty)

  # The single darwin gate, injectable so the branch is exercised on Linux CI
  # (and the Linux passthrough on a macOS laptop).
  defp os_type, do: Application.get_env(:shuttle, :os_type) || :os.type()
end
