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
      the socket, stamp the origin marker, then `:ok`
    * no server, kitty unreachable → dispatch is **REFUSED** with an
      operator-facing message. The daemon never quietly starts the server
      itself; a silent success here is exactly the state that poisons a whole
      day of workers with permission prompts.

  Non-darwin hosts (every remote in the fleet is Linux, where no such
  attribution exists) are unaffected: `ensure_available/1` returns `:ok`
  unconditionally.

  ## Attribution

  `launchctl procinfo <pid>` would name the responsible process directly, but it
  requires root — verified on macOS 25.5, `rc=1 "This subcommand requires root
  privileges: procinfo"`. So origin is read two ways instead:

    * the marker `SHUTTLE_TMUX_ORIGIN`, a server-scoped tmux environment
      variable we set right after starting a server through kitty
    * failing that, the server's own argv: a daemon-born server was forked by
      `tmux new-session -d -s <name>-shuttle … bash -l /…/shuttle-run-<n>.sh`,
      which is self-describing

  A server with neither (a human's own `tmux` from before this machinery) is
  `:unknown`, never `:daemon_born` — we do not punish a server we cannot
  attribute.
  """

  require Logger

  @type presence :: :present | :absent | :unknown
  @type origin :: :kitty_born | :daemon_born | :unknown | :absent

  @anchor "shuttle-anchor"
  @marker "SHUTTLE_TMUX_ORIGIN"

  # Poll budget for the server appearing after kitty forks it. Generous enough
  # for a cold `kitty @ launch` round trip, short enough that a dispatch tick
  # never stalls on it.
  @await_budget_ms 3_000
  @await_interval_ms 100

  @doc """
  The session name of the anchor kitty starts to hold the server alive.

  It deliberately does NOT end in `-shuttle`, so every "is this a worker?"
  predicate in the system (`Shuttle.Dispatcher.shuttle_session?/1`, the poller's
  `list_shuttle_sessions/1`, Go's `isShuttleTmuxSessionName`) ignores it.
  """
  @spec anchor_session() :: String.t()
  def anchor_session, do: @anchor

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
      # Uncertainty never blocks — the same doctrine as `Shuttle.Tmux.present?/2`.
      # A `tmux ls` that fails for an environmental reason must not refuse a
      # dispatch that would have worked.
      :present ->
        :ok

      :unknown ->
        :ok

      :absent ->
        start_server(runner)
    end
  end

  defp start_server(runner) do
    with :ok <- start_via_kitty(),
         :ok <- await_server(runner, @await_budget_ms) do
      mark_origin(runner)
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
  Stamps the kitty-born marker into the server's global tmux environment.

  Server-scoped (`set-environment -g`), so it lives exactly as long as the
  server it describes — no file to go stale, nothing to clean up when the human
  kills the server by hand.
  """
  @spec mark_origin(module()) :: :ok
  def mark_origin(runner) do
    stamp = "kitty:" <> DateTime.to_iso8601(DateTime.utc_now())
    runner.cmd("tmux", ["set-environment", "-g", @marker, stamp], stderr_to_stdout: true)
    :ok
  end

  @doc """
  Attributes the running tmux server: marker, then pid, then argv.

  Returns `%{origin:, server_pid:, argv:}` — the shape `felt setup receipt` and
  `felt shuttle status` report, so a human sees "restart your tmux server from
  kitty" as a one-line remedy instead of diagnosing TCC prompts.
  """
  @spec origin(module()) :: %{
          origin: origin(),
          server_pid: String.t() | nil,
          argv: String.t() | nil
        }
  def origin(runner) do
    marker =
      case runner.cmd("tmux", ["show-environment", "-g", @marker], stderr_to_stdout: true) do
        {output, 0} -> String.trim(output)
        _ -> nil
      end

    pid =
      case runner.cmd("tmux", ["display-message", "-p", "\#{pid}"], stderr_to_stdout: true) do
        {output, 0} -> output |> String.trim() |> presence_or_nil()
        _ -> nil
      end

    argv =
      case pid do
        nil ->
          nil

        pid ->
          case runner.cmd("ps", ["-o", "args=", "-p", pid], stderr_to_stdout: true) do
            {output, 0} -> output |> String.trim() |> presence_or_nil()
            _ -> nil
          end
      end

    %{origin: classify_origin(marker, argv), server_pid: pid, argv: argv}
  end

  defp presence_or_nil(""), do: nil
  defp presence_or_nil(value), do: value

  # A daemon-forked server's argv is self-describing: the run script it was
  # handed (`shuttle-run-<n>.sh`) and/or the worker session name it created.
  @daemon_argv_patterns [
    ~r/shuttle-run-/,
    ~r/-s\s+\S+-shuttle\b/
  ]

  @doc """
  Classifies a tmux server's origin from its marker and argv. Pure.

    * a marker at all → `:kitty_born` (we only ever stamp one after starting
      a server through kitty)
    * no marker, daemon-shaped argv → `:daemon_born`
    * no marker, some other argv → `:unknown` (a human's own server, or one
      predating the marker — never punished)
    * no argv → `:absent`
  """
  @spec classify_origin(String.t() | nil, String.t() | nil) :: origin()
  def classify_origin(marker, argv) do
    cond do
      is_binary(marker) and String.trim(marker) != "" -> :kitty_born
      not is_binary(argv) or String.trim(argv) == "" -> :absent
      Enum.any?(@daemon_argv_patterns, &Regex.match?(&1, argv)) -> :daemon_born
      true -> :unknown
    end
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
