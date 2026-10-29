defmodule Shuttle.Terminal.Tmux do
  @moduledoc "Tmux terminal primitives, including exact-name probes and interactive script snippets."
  @behaviour Shuttle.Terminal.Backend

  @absence_markers [
    "can't find session",
    "can’t find session",
    "no such session",
    "session not found",
    "no server running",
    "no current session",
    "error connecting"
  ]

  @impl true
  def id, do: "tmux"

  @impl true
  def available?, do: Shuttle.Env.find_executable("tmux") != nil

  @impl true
  def ensure_ready(runner), do: Shuttle.TmuxServer.ensure_available(runner)

  @impl true
  def launch(runner, name, cwd, script_path, _opts) do
    args = ["new-session", "-d", "-s", name, "-c", cwd, "bash", "-l", script_path]

    case runner.cmd("tmux", args, stderr_to_stdout: true) do
      {_, 0} -> :ok
      {output, _} -> {:error, "tmux failed: #{output}"}
    end
  end

  @impl true
  def probe(runner, name) do
    case runner.cmd("tmux", ["has-session", "-t", "=" <> name], stderr_to_stdout: true) do
      {_, 0} -> :present
      {output, _} -> if absence_message?(output), do: :absent, else: :unknown
    end
  end

  @impl true
  def list(runner) do
    case runner.cmd("tmux", ["ls", "-F", "\#{session_name}"], stderr_to_stdout: true) do
      {output, 0} ->
        {:ok, output |> String.split("\n", trim: true) |> Enum.map(&String.trim/1)}

      {_, :timeout} ->
        {:error, :unknown}

      {output, _} ->
        if absence_message?(output), do: {:ok, []}, else: {:error, :unknown}
    end
  end

  @impl true
  def close(runner, name) do
    case runner.cmd("tmux", ["kill-session", "-t", name], stderr_to_stdout: true) do
      {_, 0} -> :ok
      {output, _} -> if absence_message?(output), do: :absent, else: {:error, output}
    end
  end

  @doc "Paste one multiline message with bracketed paste, then submit after the harness takes it."
  @impl true
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

  @impl true
  def rename(_runner, name, name), do: :ok

  def rename(runner, from, to) do
    # A captured immutable session ID must not be converted into a name target.
    target = if String.starts_with?(from, "$"), do: from, else: "=" <> from

    case runner.cmd("tmux", ["rename-session", "-t", target, to], stderr_to_stdout: true) do
      {_, 0} -> :ok
      _ -> {:error, :rename_failed}
    end
  end

  @impl true
  def owns_pane?(runner, name, pane) do
    case runner.cmd("tmux", ["display-message", "-p", "-t", pane, "\#{session_name}"],
           stderr_to_stdout: true
         ) do
      {output, 0} -> String.trim(output) == name
      _ -> false
    end
  end

  @impl true
  def identity(runner, name) do
    format = "\#{session_id}\t\#{session_created}\t\#{pane_id}\t\#{pane_pid}"

    case runner.cmd("tmux", ["list-panes", "-s", "-t", "=" <> name, "-F", format],
           stderr_to_stdout: true
         ) do
      {output, 0} ->
        lines = String.split(String.trim(output), "\n", trim: true)

        if lines != [] and
             Enum.all?(lines, &Regex.match?(~r/^\$[0-9]+\t[0-9]+\t%[0-9]+\t[1-9][0-9]*$/, &1)),
           do: {:ok, %{"panes" => Enum.sort(lines)}},
           else: {:error, :backend_unobservable}

      _ ->
        {:error, :backend_unobservable}
    end
  end

  @impl true
  def reveal(name, host), do: Shuttle.Kitty.open(name, host)

  @impl true
  def script(name) do
    # Detached tmux starts at its default size, and scrollback does not reflow.
    # Wait up to 10s for a human-sized, non-control client before drawing.
    wait = ~s"""
    WAIT_DEADLINE=$(( $(date +%s) + 10 ))
    while [ "$(date +%s)" -lt "$WAIT_DEADLINE" ]; do
      if tmux list-clients -t '#{name}' -F '\#{client_control_mode}' 2>/dev/null | grep -qx '0'; then
        break
      fi
      sleep 0.2
    done
    """

    %{
      wait_for_viewer: wait,
      submit_key: ~s|( sleep 2; tmux send-keys -t '#{name}' Enter ) &\n    |,
      env: ""
    }
  end

  @impl true
  def unreachable_hint(procs, proc) do
    server = Shuttle.WorkerProcess.tmux_server(procs, proc)

    "its tmux server is unreachable from this daemon: either the server listens under a " <>
      "different TMUX_TMPDIR than the daemon's, or its socket was deleted. " <>
      "Holding it as present; if the socket was deleted, " <>
      Shuttle.WorkerProcess.recovery_hint(server)
  end

  @doc "Positive tmux absence evidence, distinct from a failed or timed-out command."
  def absence_message?(output) do
    down = String.downcase(to_string(output))
    Enum.any?(@absence_markers, &String.contains?(down, &1))
  end
end
