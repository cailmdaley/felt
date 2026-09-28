defmodule Shuttle.WorkerProcess do
  @moduledoc """
  Worker liveness from the process table: the worker is its processes, and
  tmux is only a view onto them.

  tmux answers "is the session there?" by connecting to its server's socket
  (`/tmp/tmux-<uid>/default`). When that socket file is deleted while the
  server lives, every tmux command answers "no server running" although every
  worker is still running under the orphaned server. Read as death, that
  answer resumes each fiber onto the transcript its live worker still holds —
  two harness processes interleaving one conversation in one worktree. This
  module is how the daemon tells the two apart.

  Two signals, both read from `ps` over the daemon's own uid:

    * **The run script.** Every tmux session the daemon starts runs
      `bash -l <tmp>/shuttle-run-<session>.<n>.sh` (`script_path/1`). The
      script never `exec`s, so that bash — and the path in its argv — lives as
      long as the worker does. The process table alone therefore names every
      session with a live worker, across daemon restarts and with no daemon
      state (`session_process/2`, `sessions/1`). tmux session names never
      contain `.` (tmux rewrites it), so `<session>.<n>` parses unambiguously.
    * **The harness session id.** A worker's harness carries its session
      uuid as an argv token (`claude --session-id <uuid>`, `claude --resume
      <uuid>`, `codex resume <uuid>`, `pi --session <uuid>`), so
      `holder/2` finds whichever process holds a transcript open — including a
      worker whose run script predates the naming above.

  A scan that fails (non-zero exit, timeout, no uid) is `{:error, :unknown}`,
  and every caller reads uncertainty as "present" — the doctrine of
  `Shuttle.Tmux`.
  """

  require Logger

  @type proc :: %{pid: integer(), ppid: integer(), args: String.t()}

  @script_prefix "shuttle-run-"
  @scan_timeout_ms 10_000
  @warn_every_ms 600_000

  @doc """
  A fresh run-script path for tmux session `session`:
  `<tmp>/shuttle-run-<session>.<n>.sh`.
  """
  @spec script_path(String.t()) :: String.t()
  def script_path(session) when is_binary(session) do
    Path.join(
      System.tmp_dir!(),
      "#{@script_prefix}#{session}.#{System.unique_integer([:positive])}.sh"
    )
  end

  @doc """
  The processes of this daemon's uid: `ps -ww -o pid=,ppid=,args= -U <uid>`,
  which Linux procps and macOS ps both accept. `{:error, :unknown}` when the
  scan cannot answer.
  """
  @spec scan(module()) :: {:ok, [proc()]} | {:error, :unknown}
  def scan(runner) do
    with {:ok, uid} <- own_uid(),
         {output, 0} <-
           runner.cmd("ps", ["-ww", "-o", "pid=,ppid=,args=", "-U", uid],
             stderr_to_stdout: true,
             timeout_ms: @scan_timeout_ms
           ) do
      {:ok, parse(output)}
    else
      failure ->
        warn_once(:scan_failed, fn ->
          "Process scan failed (#{inspect(failure)}); tmux absence is read as " <>
            "uncertain, so no worker is declared dead or resumed on it"
        end)

        {:error, :unknown}
    end
  end

  @doc false
  @spec parse(String.t()) :: [proc()]
  def parse(output) do
    output
    |> to_string()
    |> String.split("\n", trim: true)
    |> Enum.flat_map(fn line ->
      case Regex.run(~r/^\s*(\d+)\s+(\d+)\s+(.*)$/, line) do
        [_, pid, ppid, args] ->
          [%{pid: String.to_integer(pid), ppid: String.to_integer(ppid), args: args}]

        _ ->
          []
      end
    end)
  end

  @doc "The live process running tmux session `session`'s run script, or nil."
  @spec session_process([proc()], String.t()) :: proc() | nil
  def session_process(procs, session) do
    Enum.find(procs, &(script_session(&1) == session))
  end

  @doc """
  Every shuttle worker session (`Shuttle.Dispatcher.shuttle_session?/1`) with a
  live run script, deduplicated.
  """
  @spec sessions([proc()]) :: [String.t()]
  def sessions(procs) do
    procs
    |> Enum.map(&script_session/1)
    |> Enum.filter(&(is_binary(&1) and Shuttle.Dispatcher.shuttle_session?(&1)))
    |> Enum.uniq()
  end

  @doc """
  The process whose argv carries harness session `uuid` as a whole token
  (`<uuid>` or `--flag=<uuid>`), or nil.
  """
  @spec holder([proc()], String.t()) :: proc() | nil
  def holder(procs, uuid) when is_binary(uuid) and uuid != "" do
    Enum.find(procs, fn %{args: args} ->
      args
      |> String.split()
      |> Enum.any?(&(&1 == uuid or String.ends_with?(&1, "=" <> uuid)))
    end)
  end

  def holder(_procs, _uuid), do: nil

  @doc """
  `:ok` when no process of this uid holds harness session `uuid`; otherwise a
  refusal saying what is true and what to do. `{:held, message}` names the
  process; `{:unknown, message}` says the scan could not run — uncertainty
  counts as held, since a second harness process on one transcript
  interleaves it.
  """
  @spec check_free(module(), String.t()) ::
          :ok | {:error, {:held, String.t()} | {:unknown, String.t()}}
  def check_free(runner, uuid) do
    case scan(runner) do
      {:ok, procs} ->
        case holder(procs, uuid) do
          nil ->
            :ok

          proc ->
            server = tmux_server(procs, proc)

            {:error,
             {:held,
              "session #{uuid} is still open in a running process (pid #{proc.pid}) that no " <>
                "tmux session shuttle can see holds — typically a worker whose tmux socket " <>
                "was deleted under a live server. To recover it, " <>
                recovery_hint(server) <>
                "; or stop pid #{proc.pid} to let the session be resumed."}}
        end

      {:error, :unknown} ->
        {:error,
         {:unknown,
          "could not check whether a running process still holds session #{uuid} " <>
            "(the process scan failed), so it is not resumed; the next attempt checks again."}}
    end
  end

  @doc """
  The pid of the tmux server `proc` runs under — the nearest ancestor whose
  command is tmux — or nil.
  """
  @spec tmux_server([proc()], proc()) :: integer() | nil
  def tmux_server(procs, proc) do
    by_pid = Map.new(procs, &{&1.pid, &1})
    climb(by_pid, Map.get(by_pid, proc.ppid), 32)
  end

  defp climb(_by_pid, nil, _depth), do: nil
  defp climb(_by_pid, _proc, 0), do: nil

  defp climb(by_pid, proc, depth) do
    command = proc.args |> String.split() |> List.first("") |> Path.basename()

    if command == "tmux" or String.starts_with?(command, "tmux:"),
      do: proc.pid,
      else: climb(by_pid, Map.get(by_pid, proc.ppid), depth - 1)
  end

  @doc """
  How to get a live worker back into tmux's view: `kill -USR1 <server>` makes
  the tmux server recreate its socket when the path is free.
  """
  @spec recovery_hint(integer() | nil) :: String.t()
  def recovery_hint(nil),
    do:
      "send SIGUSR1 to the tmux server it runs under (`kill -USR1 <tmux server pid>`) " <>
        "so tmux recreates its socket"

  def recovery_hint(server),
    do: "run `kill -USR1 #{server}` so that tmux server recreates its socket"

  @doc """
  Logs `message` (a string or a 0-arity function building one) at warning
  level at most once per ten minutes per `key` — for conditions the watcher
  re-observes every few seconds.
  """
  @spec warn_once(term(), String.t() | (-> String.t())) :: :ok
  def warn_once(key, message) do
    now = System.monotonic_time(:millisecond)
    term_key = {__MODULE__, :warned, key}

    case :persistent_term.get(term_key, nil) do
      at when is_integer(at) and now - at < @warn_every_ms ->
        :ok

      _ ->
        :persistent_term.put(term_key, now)
        Logger.warning(if is_function(message, 0), do: message.(), else: message)
    end
  end

  # The session named by a `…/shuttle-run-<session>.<n>.sh` token in argv.
  defp script_session(%{args: args}) do
    case Regex.run(~r{(?:^|[\s/])shuttle-run-([^\s/.]+)\.\d+\.sh(?:\s|$)}, args) do
      [_, session] -> session
      _ -> nil
    end
  end

  defp own_uid do
    case :persistent_term.get({__MODULE__, :uid}, nil) do
      nil ->
        case System.cmd("id", ["-u"], stderr_to_stdout: true) do
          {out, 0} ->
            uid = String.trim(out)
            :persistent_term.put({__MODULE__, :uid}, uid)
            {:ok, uid}

          failure ->
            {:error, {:id_failed, failure}}
        end

      uid ->
        {:ok, uid}
    end
  rescue
    error -> {:error, error}
  end
end
