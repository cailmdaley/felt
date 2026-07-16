defmodule Shuttle.Kitty do
  @moduledoc """
  Open a worker's tmux session in a kitty tab on THIS machine.

  The standalone Shuttle UI is a browser app, so — unlike Portolan's native
  shell — it can't open a terminal itself. The daemon does it instead, via
  kitty's remote-control CLI (`kitty @ launch`). This is deliberately **not**
  owner-routed: the tab must appear where the human's browser is (the machine
  serving the UI), never on a headless cluster. A local-owned worker attaches
  directly; a remote-owned worker opens a *local* tab that `ssh -tt`es to the
  owning host and attaches there.

  Re-opening focuses the existing tab (matched by exact title) instead of
  spawning a duplicate — the same idempotent focus-then-launch Portolan's
  server uses. macOS in practice (kitty + `osascript` to raise the window);
  a host without kitty, or a kitty without remote control enabled, fails
  cleanly with `{:error, reason}` and the board surfaces a toast.

  Requires kitty's remote control to be reachable from outside a kitty window —
  i.e. `allow_remote_control yes` + a `listen_on unix:/tmp/kitty` in kitty.conf
  (or a `--listen-on` launch). The daemon isn't itself a kitty window, so it
  discovers the most-recently-touched `/tmp/kitty-*` socket (falling back to
  `$KITTY_LISTEN_ON` when the daemon *was* launched inside kitty).
  """

  @kitty_candidates [
    "/opt/homebrew/bin/kitty",
    "/usr/local/bin/kitty",
    "/Applications/kitty.app/Contents/MacOS/kitty"
  ]

  @doc """
  Open (or focus) `session` in a kitty tab. `host` is the fiber's
  `shuttle.host`: nil / "" / this daemon's own host id → a local
  `tmux attach`; any other value → a local tab that `ssh -tt`es to `host`.
  Returns `:ok` or `{:error, reason}`.
  """
  @spec open(String.t(), String.t() | nil) :: :ok | {:error, String.t()}
  def open(session, host \\ nil)

  def open(session, host) when is_binary(session) and session != "" do
    with {:ok, kitty} <- kitty_bin() do
      remote? = remote_host?(host)
      title = if remote?, do: "#{session}@#{host}", else: session

      result =
        case kitty_socket() do
          # No live kitty to remote-control (only stale/dead socket files, or
          # nothing). Spawn a fresh standalone kitty window running the attach
          # directly — reliable without any control socket, and the new window
          # registers its own listen socket so the NEXT click can focus-dedupe.
          nil ->
            spawn_window(kitty, title, session, host, remote?)

          # A live socket — a Quick-Access panel (preferred: it's the user's
          # quick terminal surface) or a normal window. Put the worker tab on
          # it, then reveal: a panel is hide-on-focus-loss so it must be toggled
          # visible; a normal window just gets raised.
          {socket, kind} ->
            placed =
              case focus_tab(kitty, socket, title) do
                :ok -> :ok
                :miss -> launch_tab(kitty, socket, title, session, host, remote?)
              end

            with :ok <- placed do
              reveal(kitty, socket, kind)
            end
        end

      result
    end
  end

  def open(_session, _host), do: {:error, "tmux_session is required"}

  # ── kitty remote-control plumbing ──────────────────────────────────────────

  # Focus an existing tab whose title matches exactly. `:ok` when one was
  # focused; `:miss` when none matched (or remote control was unreachable —
  # the launch path then surfaces the real error).
  defp focus_tab(kitty, socket, title) do
    args = ["@"] ++ to_opt(socket) ++ ["focus-tab", "--match", "title:^#{title}$"]

    case run(kitty, args) do
      {_out, 0} -> :ok
      _ -> :miss
    end
  end

  # Launch a fresh tab running the attach command. Local: `tmux attach -t
  # =<session>`. Remote: `ssh -tt <host> tmux attach -t =<session>`, carrying
  # the daemon's SSH_AUTH_SOCK into the tab so agent auth works.
  defp launch_tab(kitty, socket, title, session, host, remote?) do
    attach = attach_command(session, host, remote?)

    env =
      if remote? do
        case System.get_env("SSH_AUTH_SOCK") do
          s when is_binary(s) and s != "" -> ["--env", "SSH_AUTH_SOCK=" <> s]
          _ -> []
        end
      else
        []
      end

    args =
      ["@"] ++
        to_opt(socket) ++ ["launch", "--type=tab"] ++ env ++ ["--title", title] ++ attach

    case run(kitty, args) do
      {_out, 0} ->
        :ok

      {out, code} ->
        {:error, "kitty launch exited #{code}: #{out |> String.trim() |> String.slice(0, 240)}"}
    end
  end

  # Spawn a fresh standalone kitty OS window running the attach command, with no
  # remote control involved. The fallback when no live normal control socket
  # exists — invoking the `kitty` binary directly always opens a real window
  # (the GUI process daemonizes its own window), and that window registers its
  # own `listen_on` socket, so subsequent clicks find a normal socket and
  # focus-dedupe via `launch_tab`. SSH_AUTH_SOCK is inherited from the daemon's
  # env (so a remote `ssh -tt` attach authenticates) — no `--env` needed, unlike
  # the `kitty @ launch` path which runs in a *different* kitty's env.
  #
  # Run detached in a throwaway process: invoking the kitty binary blocks until
  # the window closes, so `open/2` must not wait on it. A spawn failure is
  # swallowed (best-effort) — `kitty_bin/0` already validated the binary, so the
  # realistic failure modes are gone by here.
  defp spawn_window(kitty, title, session, host, remote?) do
    attach = attach_command(session, host, remote?)
    args = ["--title", title] ++ attach
    spawn(fn -> run(kitty, args) end)
    :ok
  end

  @doc """
  The inner attach command kitty runs in the new tab. Local → `tmux attach -t
  =<session>` (the leading `=` forces an exact session match); remote → the same
  wrapped in `ssh -tt <host>`. Pure, so the local/remote shape is unit-testable
  without spawning kitty.
  """
  @spec attach_command(String.t(), String.t() | nil) :: [String.t()]
  def attach_command(session, host), do: attach_command(session, host, remote_host?(host))

  defp attach_command(session, host, remote?) do
    target = "=" <> session

    if remote? do
      ["ssh", "-tt", host, "tmux", "attach", "-t", target]
    else
      ["tmux", "attach", "-t", target]
    end
  end

  # Bring the worker terminal into view after its tab is placed.
  #   :panel  → reveal the Quick-Access dropdown (hide-on-focus-loss, so a
  #             focused tab isn't enough — the OS window must be toggled visible)
  #   :normal → raise the kitty app to the front
  defp reveal(_kitty, socket, :panel) do
    # The quick-access-terminal kitten brings the panel to the front with focus
    # on its own. Do NOT also `activate` the main kitty app — the panel is a
    # SEPARATE app (kitty-quick-access), so raising the main app would steal
    # focus and the hide-on-focus-loss panel would immediately hide again.
    show_panel(socket)
    :ok
  end

  defp reveal(kitty, _socket, :normal) do
    activate(kitty)
    :ok
  end

  # Reveal the Quick-Access panel iff it is currently hidden. Its
  # `quick-access-terminal` kitten TOGGLES visibility, so blindly invoking it
  # on an already-visible panel would hide it — guard on the panel window's
  # `is_focused` (a visible, focused panel needs no toggle).
  defp show_panel(socket) do
    unless panel_focused?(socket) do
      case kitten_bin() do
        {:ok, kitten} -> run(kitten, ["quick-access-terminal"])
        _ -> :noop
      end
    end

    :ok
  end

  # Whether the panel's OS window is currently focused (visible + frontmost),
  # read from `kitty @ ls`. Any failure → false, so show_panel errs toward
  # revealing rather than leaving it hidden.
  defp panel_focused?(socket) do
    case run_kitty_ls(socket) do
      {:ok, windows} -> Enum.any?(windows, &(&1["is_focused"] == true))
      _ -> false
    end
  end

  defp run_kitty_ls(socket) do
    with {:ok, kitty} <- kitty_bin(),
         {out, 0} <- run(kitty, ["@"] ++ to_opt(socket) ++ ["ls"]),
         {:ok, windows} <- Jason.decode(out) do
      {:ok, windows}
    else
      _ -> :error
    end
  end

  # Raise kitty to the front (best-effort, macOS).
  defp activate(_kitty) do
    run("osascript", ["-e", ~s(tell application "kitty" to activate)])
    :ok
  end

  @kitten_candidates [
    "/opt/homebrew/bin/kitten",
    "/usr/local/bin/kitten",
    "/Applications/kitty.app/Contents/MacOS/kitten"
  ]

  defp kitten_bin do
    case System.find_executable("kitten") || Enum.find(@kitten_candidates, &File.exists?/1) do
      nil -> {:error, "kitten not found on this host"}
      path -> {:ok, path}
    end
  end

  defp to_opt(nil), do: []
  defp to_opt(socket), do: ["--to", socket]

  # The `--to` target as `{socket, kind}`, or nil when no live kitty exists
  # (`open/2` then spawns a fresh window).
  #
  # Candidates are the `/tmp/kitty-*` sockets PLUS `$KITTY_LISTEN_ON` (the kitty
  # the daemon was launched inside, if any). `$KITTY_LISTEN_ON` is a *candidate*,
  # not an override: the daemon typically runs inside the dev-stack's tmux, which
  # inherits a `KITTY_LISTEN_ON` pointing at whatever kitty opened it — often a
  # window that has since died, leaving a stale `unix:/tmp/kitty-<pid>` that
  # fails with `connect: no such file`. Folding it into the candidate set means
  # the same liveness + panel-preference filter applies, so a dead inherited
  # value is dropped and the live Quick-Access panel still wins.
  defp kitty_socket do
    env_candidate =
      case System.get_env("KITTY_LISTEN_ON") do
        s when is_binary(s) and s != "" -> [String.replace_prefix(s, "unix:", "")]
        _ -> []
      end

    (Path.wildcard("/tmp/kitty-*") ++ env_candidate)
    |> Enum.uniq()
    |> Enum.flat_map(fn p ->
      # File.stat failing drops a stale `$KITTY_LISTEN_ON` whose socket file is
      # already gone — the exact stale-inherited-env case.
      case File.stat(p, time: :posix) do
        {:ok, %File.Stat{mtime: m}} -> [{p, m, socket_kind(p)}]
        _ -> []
      end
    end)
    |> pick_socket()
  end

  @doc """
  Choose the control socket from candidates shaped `{path, mtime, kind}` where
  `kind` is `:normal | :panel | :dead`. Returns `{"unix:" <> path, kind}` or
  nil. Preference: the most-recently-touched `:panel` (the Quick-Access
  dropdown is the preferred worker-terminal surface), else the
  most-recently-touched `:normal` window, else nil (all candidates dead). Pure,
  so the policy is unit-testable without a live kitty.
  """
  @spec pick_socket([{String.t(), integer(), :normal | :panel | :dead}]) ::
          {String.t(), :panel | :normal} | nil
  def pick_socket(candidates) do
    by_recency = Enum.sort_by(candidates, fn {_p, m, _kind} -> m end, :desc)

    panel = Enum.find(by_recency, fn {_p, _m, kind} -> kind == :panel end)
    normal = Enum.find(by_recency, fn {_p, _m, kind} -> kind == :normal end)

    case panel || normal do
      {path, _m, kind} -> {"unix:" <> path, kind}
      nil -> nil
    end
  end

  # Classify a `/tmp/kitty-<pid>` socket by its owning process:
  #   :dead   — pid gone (stale socket file left behind; connecting would fail)
  #   :panel  — a Quick-Access / `kitten panel` overlay instance
  #   :normal — a normal kitty window we can safely remote-control
  # `ps` exiting non-zero means the pid is gone → :dead, which is how the stale
  # `/tmp/kitty-<pid>` files that caused `connect: no such file` get excluded.
  defp socket_kind(path) do
    with "kitty-" <> pid when pid != "" <- Path.basename(path),
         {out, 0} <- System.cmd("ps", ["-o", "args=", "-p", pid], stderr_to_stdout: true) do
      if String.contains?(out, "quick-access") or String.contains?(out, "kitten panel"),
        do: :panel,
        else: :normal
    else
      _ -> :dead
    end
  rescue
    _ -> :dead
  end

  defp kitty_bin do
    case System.find_executable("kitty") || Enum.find(@kitty_candidates, &File.exists?/1) do
      nil -> {:error, "kitty not found on this host (is it installed / on PATH?)"}
      path -> {:ok, path}
    end
  end

  # `shuttle.host` is local iff absent/empty or equal to this daemon's own id.
  defp remote_host?(host) do
    case host do
      h when is_binary(h) and h != "" -> h != Shuttle.Poller.own_host_id()
      _ -> false
    end
  end

  # System.cmd raises (ErlangError :enoent) when the executable is missing; we
  # pre-resolve kitty, but osascript / kitty edge cases shouldn't crash the
  # request — fold any spawn failure into a non-zero result.
  defp run(cmd, args) do
    System.cmd(cmd, args, stderr_to_stdout: true)
  rescue
    e -> {Exception.message(e), 127}
  end
end
