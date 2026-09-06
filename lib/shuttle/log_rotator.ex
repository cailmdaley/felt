defmodule Shuttle.LogRotator do
  @moduledoc """
  Caps the daemon's own log and the autossh tunnel logs, in place, on a slow
  timer.

  Nothing else ever truncates these files. The daemon's stdout+stderr are
  redirected to one file by whichever supervisor started it (launchd's
  `StandardOutPath`, systemd's `StandardOutput=append:`, or the tmux respawn
  loop's `>>`), and `felt shuttle tunnels` points each autossh job's log at
  `~/.local/state/shuttle/tunnel-<remote>.log`. A long-lived daemon writes to
  both forever: the hub's `shuttle.log` reached 343MB before this module
  existed, one tunnel log 22MB.

  Two shell paths already rotate the daemon log — `bin/shuttle-launch`'s
  respawn loop, and the systemd unit's `ExecStartPre` — but both only fire *at
  restart*, and both use `mv`. That is safe for them precisely because they run
  while nothing holds the file open. It is exactly what this module must not
  do.

  ## Why copytruncate, not rename

  The supervisor holds the log open on an append-mode fd for the daemon's whole
  lifetime. Renaming the file does not disturb that fd — it follows the inode,
  so the *renamed* file keeps receiving every subsequent write and the new
  `shuttle.log` stays empty forever. The log would appear to have rotated and
  then to have gone silent, which is worse than not rotating at all.

  So: copy `<file>` to `<file>.1` (replacing any previous generation), then
  truncate `<file>` to zero length **in place**, keeping the inode. The
  holder's fd is unaffected; because it is in append mode, its next write lands
  at the file's new EOF rather than at its stale offset. The cost of
  copytruncate is a small window between copy and truncate in which a write can
  be lost. For a diagnostic log that is a fair trade for not silently losing
  every write afterwards.

  One generation is kept, matching the two shell paths. The point is a bound on
  disk, not an archive.

  ## Finding the daemon's log

  The daemon does not otherwise know where its own stdout goes — the path is
  the supervisor's business, baked into the rendered plist/unit as `__LOG__`.
  So `install-agent` now also exports it as `SHUTTLE_LOG` in the rendered job's
  environment, and this module reads that. When it is unset we fall back to the
  same per-platform default `bin/shuttle` uses, which covers the tmux respawn
  loop: `bin/shuttle-launch` starts the daemon with no baked environment at all
  (it reads `$SHUTTLE_LOG` itself, with the same fallback, but does not export
  it).

  ## Configuration

  All defaults are overridable through `start_link/1`, mostly so tests can
  drive a pass deterministically against tiny files:

    * `:max_bytes` — rotate a file once it exceeds this. Default 64MB.
    * `:interval_ms` — how often to check. Default 1 hour.
    * `:paths` — explicit list of plain log files, replacing the resolved
      daemon log.
    * `:tunnel_log_dir` — where to glob `tunnel-*.log`. Default
      `~/.local/state/shuttle`. A missing directory is a silent no-op: only
      the hub runs tunnels.
    * `:name` — GenServer name. Defaults to `__MODULE__`.

  A pass runs at startup as well as on the timer, so a daemon restarting onto
  an already-huge log caps it immediately instead of an hour later.
  """

  use GenServer
  require Logger

  @default_max_bytes 64 * 1024 * 1024
  @default_interval_ms :timer.hours(1)
  @tunnel_log_glob "tunnel-*.log"

  defmodule State do
    @moduledoc false
    defstruct [:max_bytes, :interval_ms, :paths, :tunnel_log_dir, :tick_timer_ref]
  end

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  @doc """
  Runs one rotation pass synchronously and returns the paths that were
  actually rotated. Tests drive the rotator with this rather than waiting on
  the timer, mirroring `Shuttle.RemoteRegistry.poll_now/1`.
  """
  @spec rotate_now() :: [String.t()]
  def rotate_now, do: rotate_now(__MODULE__)

  @spec rotate_now(GenServer.server()) :: [String.t()]
  def rotate_now(server) do
    GenServer.call(server, :rotate_now)
  end

  @impl true
  def init(opts) do
    state = %State{
      max_bytes: Keyword.get(opts, :max_bytes, @default_max_bytes),
      interval_ms: Keyword.get(opts, :interval_ms, @default_interval_ms),
      paths: Keyword.get(opts, :paths, [daemon_log_path()]),
      tunnel_log_dir: Keyword.get(opts, :tunnel_log_dir, default_tunnel_log_dir())
    }

    # The startup pass runs in a continue, not here: copying a multi-hundred-MB
    # log is seconds of IO, and the supervisor should not block on it. A
    # continue still runs before any call, so `rotate_now/1` from a test is
    # ordered after it.
    {:ok, state, {:continue, :initial_pass}}
  end

  @impl true
  def handle_continue(:initial_pass, state) do
    pass(state)
    {:noreply, schedule_tick(state)}
  end

  @impl true
  def handle_call(:rotate_now, _from, state) do
    {:reply, pass(state), state}
  end

  @impl true
  def handle_info(:tick, state) do
    pass(state)
    {:noreply, schedule_tick(state)}
  end

  def handle_info(_msg, state), do: {:noreply, state}

  defp schedule_tick(%State{} = state) do
    if is_reference(state.tick_timer_ref), do: Process.cancel_timer(state.tick_timer_ref)
    %{state | tick_timer_ref: Process.send_after(self(), :tick, state.interval_ms)}
  end

  # ── The pass ──

  # Deliberately silent when nothing needed rotating: this runs hourly for the
  # daemon's whole life, and a heartbeat line in the very log it is bounding is
  # a poor trade.
  defp pass(%State{} = state) do
    (state.paths ++ tunnel_logs(state.tunnel_log_dir))
    |> Enum.filter(&rotate_if_oversized(&1, state.max_bytes))
  end

  defp tunnel_logs(nil), do: []

  defp tunnel_logs(dir) do
    # Globbed every pass rather than resolved once at boot, so a remote added
    # with `felt shuttle remotes add` (and its new tunnel log) is picked up
    # without a daemon bounce. Path.wildcard on a missing directory returns [],
    # which is the silent no-op non-hub hosts need.
    dir |> Path.join(@tunnel_log_glob) |> Path.wildcard()
  rescue
    error ->
      warn("could not list tunnel logs in #{dir}", error)
      []
  end

  # Returns true iff the file was rotated. Every failure mode — a vanished
  # file, a permissions wall, an unreadable directory — is a warning and a
  # `false`, never a raise: this process must not be able to take the daemon
  # down, and one bad file must not skip the rest of the pass.
  defp rotate_if_oversized(path, max_bytes) do
    case File.stat(path) do
      {:ok, %File.Stat{type: :regular, size: size}} when size > max_bytes ->
        copytruncate(path, size)

      {:ok, _stat} ->
        false

      {:error, :enoent} ->
        false

      {:error, reason} ->
        Logger.warning("LogRotator: cannot stat #{path}: #{:file.format_error(reason)}")
        false
    end
  rescue
    error ->
      warn("failed rotating #{path}", error)
      false
  catch
    kind, reason ->
      warn("failed rotating #{path}", {kind, reason})
      false
  end

  defp copytruncate(path, size) do
    previous = path <> ".1"

    # :file.copy/2 opens the destination for writing, which truncates it — so
    # an existing .1 is replaced, not appended to.
    with {:ok, _bytes} <- :file.copy(path, previous),
         :ok <- truncate(path) do
      Logger.info("LogRotator: rotated #{path} → #{previous}, reclaimed #{human_bytes(size)}")
      true
    else
      {:error, reason} ->
        Logger.warning("LogRotator: cannot rotate #{path}: #{:file.format_error(reason)}")
        false
    end
  end

  # In place, keeping the inode — see the moduledoc. Opened :read + :write so
  # the open itself doesn't truncate (a plain :write open would, but then a
  # failure to open leaves ambiguity about whether the file was already
  # emptied); position 0 then truncate is explicit about what happened.
  defp truncate(path) do
    case :file.open(path, [:read, :write, :binary]) do
      {:ok, fd} ->
        try do
          case :file.position(fd, 0) do
            {:ok, 0} -> :file.truncate(fd)
            {:ok, _other} -> {:error, :eio}
            {:error, reason} -> {:error, reason}
          end
        after
          :file.close(fd)
        end

      {:error, reason} ->
        {:error, reason}
    end
  end

  # ── Paths ──

  # SHUTTLE_LOG is exported by the rendered launchd plist / systemd unit
  # (share/*.template), from the same value their stdout redirection uses. The
  # fallbacks mirror `bin/shuttle`'s AGENT_LOG_DEFAULT verbatim, which is what
  # the tmux respawn loop lands on when it starts the daemon with no baked
  # environment.
  defp daemon_log_path do
    case System.get_env("SHUTTLE_LOG") do
      path when is_binary(path) and path != "" ->
        path

      _ ->
        case :os.type() do
          {:unix, :darwin} -> Path.join([System.user_home!(), "Library", "Logs", "shuttle.log"])
          _ -> Path.join([System.user_home!(), ".shuttle", "shuttle.log"])
        end
    end
  end

  # The directory and `tunnel-<remote>.log` naming are the felt CLI's
  # convention (cmd/shuttle_tunnels.go). Mirrored here as a convention, not
  # imported: the daemon never reaches into felt internals.
  defp default_tunnel_log_dir do
    Path.join([System.user_home!(), ".local", "state", "shuttle"])
  end

  # ── Reporting ──

  defp warn(context, detail) do
    Logger.warning("LogRotator: #{context}: #{inspect(detail)}")
  end

  defp human_bytes(bytes) when bytes >= 1024 * 1024,
    do: "#{Float.round(bytes / (1024 * 1024), 1)}MB"

  defp human_bytes(bytes), do: "#{bytes}B"
end
