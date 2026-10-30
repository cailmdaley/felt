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
  make sure a tmux server ALREADY EXISTS, forked by an app the human can grant,
  before the daemon ever runs `new-session`. On tmux-primary hosts kitty forks
  it through a background command. On Rex-primary hosts Rex Server forks it
  through a short-lived block. The server retains that app's resource coalition
  after the launcher exits; the human grants that app access once.

  "Charges kitty" holds only for a kitty that is its own responsible app. TCC
  follows the launchd resource coalition, and a kitty started by another app's
  child process sits in that app's coalition: the Quick Access panel toggled by
  a launcher hotkey is charged to the launcher, so an anchor forked through it
  hands every worker the launcher's grants — an all-zero microphone, for one.
  `Shuttle.Kitty.run_background/2` therefore forks only through a kitty whose
  coalition is kitty's own, and starts one through LaunchServices when none is
  running.

  Three outcomes, and the middle one is the point:

    * a server is present (or its presence can't be determined) → `:ok`,
      dispatch proceeds untouched
    * no server, the selected app reachable or startable → it forks an
      anchor session, we wait for the socket, disarm `exit-empty`, then `:ok`
    * no server, no such app → dispatch is **REFUSED** with an
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
  server; kitty's or Rex Server's is intended. Any other app's is reported as a
  warning by `shuttle doctor`. See `internal/shuttlecli/tmux_origin.go`; nothing
  in this module needs to stamp or read a marker.
  """

  require Logger

  @type presence :: :present | :absent | :unknown

  # The session the terminal app starts to hold a fresh server alive. It does
  # NOT end in `-shuttle`, so every "is this a worker?" predicate in the system
  # (`Shuttle.Dispatcher.shuttle_session?/1`, the poller's
  # `list_shuttle_sessions/1`, Go's `isShuttleTmuxSessionName`) ignores it.
  @anchor "shuttle-anchor"

  # Poll budget for the server appearing after the app forks it. Generous enough
  # for the background launch round trip, short enough that a dispatch tick
  # never stalls on it.
  @await_budget_ms 3_000
  @await_interval_ms 100

  @doc """
  Ensures this host has a tmux server the daemon did not fork.

  `:ok` on every non-darwin host, and on darwin whenever a server is present or
  its presence is uncertain. Otherwise asks the selected app to fork one.
  A launcher failure or a server that never appears is `{:error, {:tmux_server_unavailable,
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

      # Uncertainty never blocks — the same doctrine as `Shuttle.Terminal.present?/2`.
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
    launcher = launcher()

    with :ok <- start_via_app(runner, launcher),
         :ok <- await_server(runner, @await_budget_ms) do
      disarm_exit_empty(runner)
      Logger.info("Started a tmux server via #{launcher} (anchor session #{@anchor})")
      :ok
    else
      {:error, reason} -> refuse(reason)
      :timeout -> refuse("#{launcher} accepted the command but no tmux server appeared")
    end
  end

  @doc """
  Whether a tmux server is running on this host.

  `:present` on exit 0; `:absent` only on a non-zero exit whose output is one of
  tmux's own absence messages (positive evidence — shared with
  `Shuttle.Terminal.Tmux`); `:unknown` for every other failure, including a timeout.
  """
  @spec presence(module()) :: presence()
  def presence(runner) do
    case runner.cmd("tmux", ["ls", "-F", "\#{session_name}"], stderr_to_stdout: true) do
      {_output, 0} ->
        :present

      {_output, :timeout} ->
        :unknown

      {output, _status} ->
        if Shuttle.Terminal.Tmux.absence_message?(output), do: :absent, else: :unknown
    end
  end

  defp launcher do
    if Shuttle.Terminal.primary() == Shuttle.Terminal.Rex, do: :rex, else: :kitty
  end

  defp start_via_app(runner, :rex) do
    case Shuttle.Env.find_executable("tmux") do
      nil ->
        {:error, "tmux executable not found for the Rex anchor"}

      executable ->
        Shuttle.Env.app(:rex_impl, Shuttle.Rex).run_background(anchor_command(executable), runner)
    end
  end

  defp start_via_app(runner, :kitty),
    do: kitty_impl().run_background(anchor_command("tmux"), runner)

  # Asks the terminal app to fork a tmux server holding an anchor session.
  #
  # `tmux start-server` alone is useless here: it exits 0 and the server
  # immediately dies to `exit-empty` (verified). The server needs one session to
  # hold it up, and the anchor's payload is an effectively-infinite sleep rather
  # than a shell, so nothing is attached to it and nothing can wander off.
  defp anchor_command(executable),
    do: [
      executable,
      "new-session",
      "-d",
      "-s",
      @anchor,
      "--",
      "sh",
      "-c",
      "exec sleep 2147483647"
    ]

  # Polls `presence/1` until a server answers, or `budget_ms` elapses.
  @spec await_server(module(), non_neg_integer()) :: :ok | :timeout
  defp await_server(runner, budget_ms) do
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

  # Turns `exit-empty` off on this host's tmux server.
  #
  # A server with no sessions exits by default, and the window between
  # `presence/1` answering `:present` and the dispatcher's `tmux new-session` is
  # real: a human who detaches and closes their last session in it loses the
  # server, and `new-session` then forks a fresh one — rooted at the daemon,
  # which is the entire state this module exists to prevent. Disarming
  # `exit-empty` makes an anchor-less, human-started server survive that window.
  #
  # Server-scoped and idempotent (`set-option -s`), and — unlike `new-session` —
  # it never forks a server of its own: with no server running it just fails
  # ("error connecting to /tmp/tmux-<uid>/default", verified). It is called only
  # with a server present or just started anyway, and a failure is deliberately
  # ignored: losing the hardening must not refuse a dispatch that would have
  # worked.
  @spec disarm_exit_empty(module()) :: :ok
  defp disarm_exit_empty(runner) do
    runner.cmd("tmux", ["set-option", "-s", "exit-empty", "off"], stderr_to_stdout: true)
    :ok
  end

  @doc """
  The operator-facing refusal, rendered verbatim on the board, the 422, and the
  daemon log. It has to carry the whole story: the human's only visible symptom
  is a stream of "erlexec" permission prompts, which names nothing they own.
  """
  @spec refusal_message(String.t()) :: String.t()
  def refusal_message(error) do
    refusal_message(error, launcher())
  end

  defp refusal_message(error, :rex) do
    "No tmux server is running on this machine, and Shuttle could not ask Rex to start one " <>
      "(#{error}). On macOS the daemon must never start the tmux server itself: macOS privacy " <>
      "would charge its processes to the daemon binary and raise erlexec access prompts. " <>
      "Open Rex, grant Rex Server Full Disk Access (and microphone access for meetings), " <>
      "then retry. The auxiliary tmux server must be rooted by Rex Server."
  end

  defp refusal_message(kitty_error, :kitty) do
    "No tmux server is running on this machine, and Shuttle could not ask kitty to start one " <>
      "(#{kitty_error}). On macOS the daemon must never start the tmux server itself: every " <>
      "process under it — the worker, its shells, its tools — would be charged to the daemon's " <>
      "binary by macOS privacy (TCC), so each one raises an \"erlexec wants to access data from " <>
      "other apps\" prompt and the daemon cannot hold those grants. Start a tmux server from " <>
      "a kitty you opened from the Dock or Finder (`tmux new-session -d -s #{@anchor}`) — not " <>
      "from a launcher's hotkey panel, whose privacy grants it would inherit — or enable kitty " <>
      "remote control, then dispatch again."
  end

  defp refuse(reason) do
    {:error, {:tmux_server_unavailable, refusal_message(to_string(reason))}}
  end

  defp kitty_impl, do: Shuttle.Env.app(:kitty_impl, Shuttle.Kitty)

  # The single darwin gate, injectable so the branch is exercised on Linux CI
  # (and the Linux passthrough on a macOS laptop).
  defp os_type, do: Shuttle.Env.app(:os_type) || :os.type()
end
