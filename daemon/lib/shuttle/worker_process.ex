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

  Holder evidence starts with `ps` over the daemon's own uid:

    * **The run script.** Every tmux session the daemon starts runs
      `bash -l <tmp>/shuttle-run-<uuid>.<n>.sh` (`script_path/1`), keyed by the
      conversation UUID the launch pre-assigned. The script never `exec`s, so
      that bash — and the path in its argv — lives as long as the worker does.
      Run scripts from builds that keyed them by tmux session name still parse
      (`session_process/2`). Neither `.` nor `/` occurs in a UUID or a tmux
      session name, so `<key>.<n>` parses unambiguously.
    * **The harness session id.** A worker's harness carries its session
      uuid as an argv token (`claude --session-id <uuid>`, `claude --resume
      <uuid>`, `pi --session-id <uuid>`, `pi --session <uuid>`), so
      `holder/3` finds whichever process holds a transcript open.
    * **The hook receiver.** A session-start hook binds a UUID to its
      receiver's pid and kernel birth token (`Shuttle.SessionBinding`), which
      also follows `/resume` and `/clear`; a local Codex receiver registration
      binds fresh embedded Codex argv. Either counts only while the live
      process's start token matches (`shuttle process-identity`), so a reused
      pid never does.
    * **The claim.** A claim binds the claimer's worker process — its launch's
      run script, else the harness that ran the claim in its pane — by pid
      and start token (`pane_holder/3`).

  Holding a conversation is not being its worker: `find/3` counts only a
  bound process or a holder a Shuttle launch runs (`launch_root/2`), so a
  History resume or a human's own `--resume` is never adopted or signalled as
  a worker. A launch maps to its tmux pane by process ancestry (`pane_of/3`),
  which is how a stop reaches it by exact pane id whatever its session is
  called.

  A scan that fails (non-zero exit, timeout, no uid) is `{:error, :unknown}`,
  and every caller reads uncertainty as "present" — the doctrine of
  `Shuttle.Tmux`.
  """

  require Logger

  @type proc :: %{pid: integer(), ppid: integer(), args: String.t()}

  @script_prefix "shuttle-run-"
  @scan_timeout_ms 10_000
  @warn_every_ms 600_000
  @session_flags ["--resume", "--session-id", "--session", "resume"]

  @doc """
  A fresh run-script path keyed by `key` — a launch's conversation UUID, or
  the tmux session name of a helper session: `<tmp>/shuttle-run-<key>.<n>.sh`.
  """
  @spec script_path(String.t()) :: String.t()
  def script_path(key) when is_binary(key) do
    Path.join(
      System.tmp_dir!(),
      "#{@script_prefix}#{key}.#{System.unique_integer([:positive])}.sh"
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
  The process whose argv opens harness session `uuid`, or nil: the uuid as the
  value of a harness session flag (`--resume <uuid>`, `--session-id <uuid>`,
  `--session <uuid>`, `resume <uuid>`, or `--flag=<uuid>`). A uuid that merely
  appears as a word — inside a prompt argument naming a previous session, or
  a shell command line — does not hold the transcript.

  A hook receiver without a UUID in argv must match its kernel start token.
  An unobservable receiver lifetime returns `{:error, :unknown}`.
  """
  @spec holder([proc()], String.t(), module()) :: proc() | nil | {:error, :unknown}
  def holder(procs, uuid, runner \\ Shuttle.Runner.Default)

  def holder(procs, uuid, runner) when is_binary(uuid) and uuid != "" do
    Enum.find(procs, &opens?(&1, uuid)) || bound_holder(procs, uuid, runner)
  end

  def holder(_procs, _uuid, _runner), do: nil

  # The process carries `uuid` as a harness session flag or its run script's key.
  defp opens?(%{args: args} = proc, uuid) do
    not tmux?(proc) and
      (script_session_in(args) == uuid or
         args
         |> String.split()
         |> Enum.chunk_every(2, 1, [nil])
         |> Enum.any?(fn
           [flag, ^uuid] when flag in @session_flags ->
             true

           [token, _] ->
             String.starts_with?(token, "--") and String.ends_with?(token, "=" <> uuid)
         end))
  end

  # A run script keyed by its tmux session name holds the conversation the
  # ledger last paired with that session. Only such scripts are looked up,
  # so the ledger is read only while one runs.
  defp bound_holder(procs, uuid, runner) do
    script_holder =
      with [_ | _] <- Enum.filter(procs, &session_keyed_script?/1),
           %{"host" => host, "tmux" => tmux} when is_binary(tmux) <-
             Shuttle.SessionLedger.latest_for_session(uuid),
           true <- host == Shuttle.Poller.own_host_id(),
           %{"session" => ^uuid} <- latest_for_tmux(tmux) do
        session_process(procs, tmux)
      else
        _ -> nil
      end

    with nil <- script_holder,
         nil <- hook_holder(procs, uuid, runner) do
      binding_holder(procs, uuid, runner)
    end
  end

  # The receiver a session-start hook bound `uuid` to, while that exact
  # process lifetime is alive.
  defp binding_holder(procs, uuid, runner) do
    binding = Shuttle.SessionBinding.observed()

    with {_harness, pid, birth} = key <- Map.get(binding.members, uuid),
         %{retired: false} <- Map.get(binding.processes, key),
         %{} = proc <- Enum.find(procs, &(&1.pid == pid)) do
      receiver_holder(proc, birth, runner)
    else
      _ -> nil
    end
  end

  @doc """
  The live process bound to a claimed pane, `%{"pid" => pid, "start" =>
  start}`: the pane's process while its start token still matches, so a
  reused pid never counts. `{:error, :unknown}` when the lifetime cannot be
  observed.
  """
  @spec pane_holder([proc()], map() | nil, module()) :: proc() | nil | {:error, :unknown}
  def pane_holder(procs, %{"pid" => pid, "start" => start}, runner)
      when is_integer(pid) and is_binary(start) do
    case Enum.find(procs, &(&1.pid == pid)) do
      nil -> nil
      proc -> receiver_holder(proc, start, runner)
    end
  end

  def pane_holder(_procs, _pane, _runner), do: nil

  @doc """
  The worker process of the execution `handle` (`%{uuid, pane}`): the process
  its claim bound (`pane`, `<pid>:<start>`) while that lifetime lives, else a
  process holding its conversation UUID that a Shuttle launch runs
  (`launch_root/2`). A process that merely holds the conversation — a History
  resume, or a human's `claude --resume` in a terminal of their own — is not
  the worker: it is never adopted or signalled as one, though it still keeps a
  resume off the transcript (`check_free/2`). `{:error, :unknown}` when a
  lifetime cannot be observed.
  """
  @spec find([proc()], map(), module()) :: proc() | nil | {:error, :unknown}
  def find(procs, handle, runner \\ Shuttle.Runner.Default) do
    case pane_holder(procs, Map.get(handle, :pane), runner) do
      nil -> conversation_worker(procs, Map.get(handle, :uuid), runner)
      found -> found
    end
  end

  defp conversation_worker(procs, uuid, runner) when is_binary(uuid) and uuid != "" do
    case Enum.find(procs, &(opens?(&1, uuid) and launch_root(procs, &1) != nil)) do
      nil ->
        case bound_holder(procs, uuid, runner) do
          %{} = proc -> if launch_root(procs, proc), do: proc
          other -> other
        end

      proc ->
        proc
    end
  end

  defp conversation_worker(_procs, _uuid, _runner), do: nil

  @doc """
  The Shuttle launch running `proc`: the outermost run script at or above it,
  below any tmux server, that a dispatch or capture started — keyed by its
  conversation UUID, or by the session name an earlier build gave it. The
  scripts of a History resume, a Codex terminal viewer and remote control are
  not launches. nil when none.
  """
  @spec launch_root([proc()], proc()) :: proc() | nil
  def launch_root(procs, proc) do
    by_pid = Map.new(procs, &{&1.pid, &1})

    by_pid
    |> ancestry(proc, 32)
    |> Enum.take_while(&(not tmux?(&1)))
    |> Enum.filter(&launch_script?/1)
    |> List.last()
  end

  @doc """
  The process that stands for worker `proc`: its launch's run script, else
  `proc` itself (a claimed harness).
  """
  @spec worker_root([proc()], proc()) :: proc()
  def worker_root(procs, proc), do: launch_root(procs, proc) || proc

  # Every run script but the helpers': a History resume, a Codex terminal
  # viewer and the remote-control session run scripts of their own.
  @helper_prefixes ["resume-", "codex-terminal-", "shuttle-remote-control"]

  defp launch_script?(proc) do
    case script_session(proc) do
      key when is_binary(key) -> not String.starts_with?(key, @helper_prefixes)
      _ -> false
    end
  end

  defp uuid?(key),
    do: Regex.match?(~r/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, key)

  @doc """
  The claimer's own harness: the process on the ancestry of `pid` (the
  claiming CLI) whose parent is the pane process `pane_pid`, or the launch
  running that chain. nil when `pid` does not run in that pane.
  """
  @spec claimer([proc()], integer(), integer()) :: proc() | nil
  def claimer(procs, pid, pane_pid) do
    by_pid = Map.new(procs, &{&1.pid, &1})

    with %{} = proc <- Map.get(by_pid, pid),
         chain = ancestry(by_pid, proc, 32),
         index when is_integer(index) <- Enum.find_index(chain, &(&1.pid == pane_pid)) do
      launch_root(procs, proc) || if(index > 0, do: Enum.at(chain, index - 1), else: proc)
    else
      _ -> nil
    end
  end

  @doc """
  Every tmux pane this daemon's server shows, as `%{pid, pane, session}`
  (`pane` is the exact pane id, `%N`). `{:error, :unknown}` when tmux cannot
  answer; a server that is not running has no panes.
  """
  @spec panes(module()) :: {:ok, [map()]} | {:error, :unknown}
  def panes(runner) do
    case runner.cmd(
           "tmux",
           ["list-panes", "-a", "-F", "\#{pane_pid} \#{pane_id} \#{session_name}"],
           stderr_to_stdout: true
         ) do
      {output, 0} ->
        {:ok,
         output
         |> to_string()
         |> String.split("\n", trim: true)
         |> Enum.flat_map(fn line ->
           case String.split(String.trim(line), " ", parts: 3) do
             [pid, "%" <> _ = pane, session] ->
               case Integer.parse(pid) do
                 {pid, ""} -> [%{pid: pid, pane: pane, session: session}]
                 _ -> []
               end

             _ ->
               []
           end
         end)}

      {output, _} ->
        if Shuttle.Tmux.absence_message?(output), do: {:ok, []}, else: {:error, :unknown}
    end
  end

  @doc """
  The pane whose process is `proc` or one of its ancestors, or nil when tmux
  shows none of them (a server whose socket was deleted, or no tmux at all).
  """
  @spec pane_of([proc()], [map()], proc()) :: map() | nil
  def pane_of(procs, panes, proc) do
    by_pid = Map.new(procs, &{&1.pid, &1})
    by_pane = Map.new(panes, &{&1.pid, &1})
    ancestry(by_pid, proc, 32) |> Enum.find_value(&Map.get(by_pane, &1.pid))
  end

  defp ancestry(_by_pid, nil, _depth), do: []
  defp ancestry(_by_pid, _proc, 0), do: []

  defp ancestry(by_pid, proc, depth),
    do: [proc | ancestry(by_pid, Map.get(by_pid, proc.ppid), depth - 1)]

  defp latest_for_tmux(tmux) do
    Shuttle.SessionLedger.read_since(0)
    |> Enum.filter(&(&1["tmux"] == tmux and &1["host"] == Shuttle.Poller.own_host_id()))
    |> Enum.max_by(& &1["at"], fn -> nil end)
  end

  defp hook_holder(procs, uuid, runner) do
    key = :crypto.hash(:sha256, uuid) |> Base.encode16(case: :lower)
    path = Path.join([Shuttle.data_dir(), "mailboxes", "codex", key, "receiver.json"])

    with {:ok, bytes} <- File.read(path),
         {:ok, %{"id" => ^uuid, "host" => host, "pid" => pid} = reg} <- Jason.decode(bytes),
         true <- host == Shuttle.Poller.own_host_id() and reg["ended"] != true,
         %{} = proc <- Enum.find(procs, &(&1.pid == pid)) do
      receiver_holder(proc, reg["start"], runner)
    else
      {:error, :enoent} -> nil
      {:error, _reason} -> {:error, :unknown}
      _ -> nil
    end
  end

  defp receiver_holder(proc, start, runner) when is_binary(start) and start != "" do
    with {:ok, output} <-
           Shuttle.CLI.run(["process-identity", Integer.to_string(proc.pid)],
             runner: runner,
             timeout_ms: 2_000
           ),
         {:ok, identity} <- Jason.decode(output) do
      case identity do
        %{"status" => "present", "start" => actual} when is_binary(actual) and actual != "" ->
          # A hook birth token carries the Linux boot id before the start.
          if start == actual or String.ends_with?(start, ":" <> actual), do: proc

        %{"status" => "gone"} ->
          nil

        _ ->
          {:error, :unknown}
      end
    else
      _ -> {:error, :unknown}
    end
  end

  defp receiver_holder(_proc, _start, _runner), do: {:error, :unknown}

  @doc """
  `:ok` when no process of this uid holds harness session `uuid`; otherwise a
  refusal saying what is true and what to do. `{:held, message}` names the
  process; `{:unknown, message}` says the scan or lifetime is unobservable — uncertainty
  counts as held, since a second harness process on one transcript
  interleaves it.
  """
  @spec check_free(module(), String.t()) ::
          :ok | {:error, {:held, String.t()} | {:unknown, String.t()}}
  def check_free(runner, uuid) do
    case scan(runner) do
      {:ok, procs} ->
        case holder(procs, uuid, runner) do
          nil ->
            :ok

          {:error, :unknown} ->
            unknown_holder(uuid)

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
        unknown_holder(uuid)
    end
  end

  defp unknown_holder(uuid) do
    {:error,
     {:unknown,
      "could not check whether a running process still holds session #{uuid} " <>
        "(the process scan or receiver lifetime could not be verified), so it is not resumed; " <>
        "the next attempt checks again."}}
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
    if tmux?(proc),
      do: proc.pid,
      else: climb(by_pid, Map.get(by_pid, proc.ppid), depth - 1)
  end

  # A tmux process — client or server. A server forked by `new-session` keeps
  # that client's argv (Linux and macOS alike), run-script path included, for
  # its whole life; it is never itself a worker.
  defp tmux?(%{args: args}) do
    command = args |> String.split() |> List.first("") |> Path.basename()
    command == "tmux" or String.starts_with?(command, "tmux:")
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

  @doc """
  The conversation UUIDs whose launch run scripts are running, each with its
  script's process.
  """
  @spec launches([proc()]) :: [{String.t(), proc()}]
  def launches(procs) do
    for proc <- procs, key = script_session(proc), is_binary(key) and uuid?(key), do: {key, proc}
  end

  defp session_keyed_script?(proc) do
    case script_session(proc) do
      key when is_binary(key) -> Shuttle.Dispatcher.shuttle_session?(key)
      _ -> false
    end
  end

  # The key named by a `…/shuttle-run-<key>.<n>.sh` token in argv: a launch's
  # conversation UUID, or the session name a helper session's script carries.
  defp script_session(%{args: args} = proc) do
    if tmux?(proc), do: nil, else: script_session_in(args)
  end

  defp script_session_in(args) do
    case Regex.run(~r{(?:^|[\s/])shuttle-run-([^\s/.]+)\.\d+\.sh(?:\s|$)}, args) do
      [_, session] -> session
      _ -> nil
    end
  end

  defp own_uid do
    case :persistent_term.get({__MODULE__, :uid}, nil) do
      nil ->
        case Shuttle.Env.cmd("id", ["-u"], stderr_to_stdout: true) do
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
