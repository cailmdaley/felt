defmodule Shuttle.Runner do
  @moduledoc """
  Behavior for shell command execution.

  Default implementation spawns the command through a Port, bounded by a
  wall-clock timeout (see `Shuttle.Runner.Default`). Tests inject a mock
  module to capture commands without running them.

  A command that exceeds its bound yields `{message, :timeout}` — the exit
  "status" is the `:timeout` atom, so every existing non-zero-exit error path
  degrades the same way it would for a failed command instead of blocking its
  caller forever. Callers that must distinguish "the world said no" from "the
  world didn't answer" match `:timeout` explicitly (a timeout is never
  evidence of absence — see `Shuttle.FeltStores`).

  `max_output_bytes: n` bounds collected output (including stderr when merged).
  The default is `:infinity`. Exceeding the ceiling kills the child, discards
  partial output and returns `{message, :output_limit}`, never truncated success.

  `timeout_ms: :infinity` is for completion-owned local mutations: neither a
  deadline nor caller death SIGKILLs them, so they can release filesystem locks.
  Their network phases must carry their own deadlines.
  """

  @callback cmd(String.t(), [String.t()], keyword()) ::
              {String.t(), non_neg_integer() | :timeout | :output_limit}

  defmodule Default do
    @behaviour Shuttle.Runner

    # Wall-clock bound on every shelled command. `System.cmd/3` has no timeout,
    # so on an overloaded machine (a shared cluster login node under IO
    # pressure, where a felt call that normally answers in ~10ms was observed
    # taking ~11s) a single wedged call would stall its caller — most
    # damagingly the poll cycle — forever. Generous on purpose: this is a bound
    # on wedged calls, not a latency target; slow-but-alive calls must still
    # complete. Override globally via `config :shuttle, :cmd_timeout_ms` or
    # per call via the `:timeout_ms` option.
    @default_timeout_ms 60_000

    # Spawns via a raw Port rather than `System.cmd/3` so the OS pid is in
    # hand: on timeout the process is killed (SIGKILL), not merely abandoned.
    # A Task-wrapped System.cmd would unblock the caller but leave the wedged
    # process running (closing an Erlang port closes stdin, it doesn't kill) —
    # on the very login node whose overload caused the timeout, the daemon
    # would accumulate stuck felt processes and amplify the load it was
    # defending against.
    def cmd(command, args, opts) do
      if Keyword.get(opts, :input_eof, false) do
        with_input_file(command, args, opts)
      else
        cmd_without_eof(command, args, opts)
      end
    end

    defp with_input_file(command, args, opts) do
      input = Keyword.fetch!(opts, :input)

      path =
        Path.join(
          Keyword.get(opts, :input_tmp_dir, System.tmp_dir!()),
          "shuttle-input-" <> Base.url_encode64(:crypto.strong_rand_bytes(18), padding: false)
        )

      case File.open(path, [:write, :binary, :exclusive]) do
        {:ok, file} ->
          try do
            with :ok <- File.chmod(path, 0o600),
                 :ok <- IO.binwrite(file, input),
                 :ok <- File.close(file) do
              opts = opts |> Keyword.drop([:input_eof, :input, :input_tmp_dir])

              cmd_without_eof(
                "sh",
                ["-c", "input=$1; shift; exec \"$@\" < \"$input\"", "sh", path, command | args],
                opts
              )
            else
              {:error, reason} -> {"cannot prepare command input: #{inspect(reason)}", 1}
            end
          after
            File.close(file)
            File.rm(path)
          end

        {:error, reason} ->
          {"cannot create command input: #{inspect(reason)}", 1}
      end
    end

    defp cmd_without_eof(command, args, opts) do
      {timeout_ms, opts} = Keyword.pop(opts, :timeout_ms, default_timeout_ms())
      opts = opts |> with_scoped_env() |> then(&maybe_clear_inherited_tmux(command, &1))

      # The lookup reads the caller's `PATH` (`Shuttle.Env.find_executable/1`).
      case Shuttle.Env.find_executable(command) do
        nil ->
          {"#{command}: command not found", 127}

        executable ->
          case run_bounded(executable, command, args, opts, timeout_ms) do
            {:spawn_error, :enoent} -> {"#{command}: command not found", 127}
            {:spawn_error, :eacces} -> {"#{command}: permission denied", 126}
            result -> result
          end
      end
    end

    defp run_bounded(executable, command, args, opts, timeout_ms) do
      input = Keyword.get(opts, :input)

      port_opts =
        [:binary, :exit_status, :use_stdio, :hide, args: args] ++
          if(Keyword.get(opts, :stderr_to_stdout, false), do: [:stderr_to_stdout], else: []) ++
          case Keyword.get(opts, :cd) do
            dir when is_binary(dir) -> [cd: dir]
            _ -> []
          end ++
          case Keyword.get(opts, :env) do
            env when is_list(env) and env != [] -> [env: port_env(env)]
            _ -> []
          end

      # Any raise here (bad option, unreadable cd, …) propagates to the caller
      # exactly as bare `System.cmd/3` would — only spawn :enoent/:eacces and
      # the timeout are softened into the tuple contract.
      case open_port(executable, command, port_opts) do
        {:error, reason} ->
          {:spawn_error, reason}

        {:ok, port} ->
          # Request-style CLI adapters consume one newline-delimited JSON frame
          # and exit after writing their receipt. Keeping stdin open lets us
          # continue collecting stdout and the exit status from the same port;
          # this path needs no shell, temporary file, or EOF handshake. Commands
          # that need EOF use the private input file in `with_input_file/3`.
          if is_binary(input), do: Port.command(port, input)

          os_pid =
            case Port.info(port, :os_pid) do
              {:os_pid, pid} -> pid
              _ -> nil
            end

          # Whoever owns the command must reap it: the Poller's stall watchdog
          # `:kill`s a poll task mid-command, which skips `collect/7`'s own timeout
          # kill, and closing the port only closes the child's stdin.
          # Completion-owned mutations opt out of both deadline and owner-death
          # killing. Their subprocess owns releasing filesystem locks even if its
          # caller exits; closing a Port alone does not SIGKILL the subprocess.
          guard =
            if os_pid && timeout_ms != :infinity,
              do: spawn_guard(self(), Shuttle.Env.callers(), os_pid)

          deadline =
            if timeout_ms == :infinity,
              do: :infinity,
              else: System.monotonic_time(:millisecond) + timeout_ms

          try do
            collect(port, os_pid, command, args, timeout_ms, deadline, {
              [],
              Keyword.get(opts, :max_output_bytes, :infinity)
            })
          after
            if guard, do: send(guard, :released)
          end
      end
    end

    # Retry only a failed spawn: no child has run, so retry cannot repeat work.
    # A newly installed earlier-PATH executable may remain unseen for up to
    # the 60-second lookup cache lifetime. If retry finds a non-executable
    # candidate, that path can be cached again for the same bounded interval.
    defp open_port(executable, command, port_opts) do
      {:ok, Port.open({:spawn_executable, executable}, port_opts)}
    rescue
      error in ErlangError ->
        if error.original in [:enoent, :eacces] do
          Shuttle.Env.invalidate_executable(command)

          case Shuttle.Env.find_executable(command) do
            nil ->
              {:error, :enoent}

            resolved ->
              retry_open_port(resolved, port_opts)
          end
        else
          reraise error, __STACKTRACE__
        end
    end

    defp retry_open_port(executable, port_opts) do
      {:ok, Port.open({:spawn_executable, executable}, port_opts)}
    rescue
      error in ErlangError ->
        if error.original in [:enoent, :eacces],
          do: {:error, error.original},
          else: reraise(error, __STACKTRACE__)
    end

    # An unlinked sentinel that reaps `os_pid`'s process group if `owner` dies
    # before releasing it. It reads the owner's `Shuttle.Env` scope, since the
    # owner is gone when it acts.
    defp spawn_guard(owner, callers, os_pid) do
      spawn(fn ->
        Shuttle.Env.adopt_callers(callers)
        ref = Process.monitor(owner)

        receive do
          :released -> :ok
          {:DOWN, ^ref, :process, _, _} -> reap(os_pid)
        end
      end)
    end

    defp collect(port, os_pid, command, args, timeout_ms, deadline, {acc, byte_budget}) do
      remaining =
        if deadline == :infinity,
          do: :infinity,
          else: max(deadline - System.monotonic_time(:millisecond), 0)

      receive do
        {^port, {:data, data}} when byte_budget != :infinity and byte_size(data) > byte_budget ->
          if os_pid, do: reap(os_pid)
          safe_close(port)
          flush_port(port)
          {"#{command} exceeded output byte limit", :output_limit}

        {^port, {:data, data}} ->
          budget = if byte_budget == :infinity, do: :infinity, else: byte_budget - byte_size(data)
          collect(port, os_pid, command, args, timeout_ms, deadline, {[acc | [data]], budget})

        {^port, {:exit_status, status}} ->
          {IO.iodata_to_binary(acc), status}
      after
        remaining ->
          # Reap, don't just abandon: SIGKILL the OS process, then close the
          # port and drain anything it raced onto our mailbox between the kill
          # and the close — a non-trapping GenServer caller must never see a
          # stray `{port, …}` message on a later receive.
          if os_pid, do: reap(os_pid)
          safe_close(port)
          flush_port(port)
          {"#{command} #{Enum.join(args, " ")} timed out after #{timeout_ms}ms", :timeout}
      end
    end

    # SIGKILL the command and everything it spawned. The port driver starts each
    # child as the leader of its own process group, so `-pid` addresses the
    # whole tree (an `ssh` or `felt` under a shell wrapper included); the plain
    # pid covers a child that is not a group leader. /bin/kill exists on macOS
    # and every Linux cluster. Spawned bare (not through cmd/3) to avoid recursion.
    defp reap(os_pid) do
      pid = Integer.to_string(os_pid)
      Shuttle.Env.cmd("kill", ["-9", "--", "-" <> pid], stderr_to_stdout: true)
      Shuttle.Env.cmd("kill", ["-9", pid], stderr_to_stdout: true)
    rescue
      # No `kill` on PATH (pathological) — the process leaks, but the caller
      # still unblocks; nothing better to do here.
      _ -> :ok
    end

    # The port may already be closed (exit_status racing the kill); closing a
    # dead port raises ArgumentError, which is exactly the benign case here.
    defp safe_close(port) do
      Port.close(port)
    rescue
      ArgumentError -> :ok
    end

    defp flush_port(port) do
      receive do
        {^port, _} -> flush_port(port)
      after
        0 -> :ok
      end
    end

    # Port env entries are charlists; `System.cmd/3` accepts binaries and a
    # `nil` value meaning "unset" — preserve both (`false` unsets for ports).
    defp port_env(env) do
      Enum.map(env, fn {key, value} ->
        {String.to_charlist(key), if(value, do: String.to_charlist(value), else: false)}
      end)
    end

    defp default_timeout_ms,
      do: Shuttle.Env.app(:cmd_timeout_ms, @default_timeout_ms)

    # The child inherits the caller's scoped env overrides (`Shuttle.Env`);
    # an `env:` entry the caller passes wins over a scoped one.
    defp with_scoped_env(opts) do
      case Shuttle.Env.child_env() do
        [] ->
          opts

        scoped ->
          caller = Keyword.get(opts, :env, [])
          names = MapSet.new(caller, &elem(&1, 0))
          Keyword.put(opts, :env, caller ++ Enum.reject(scoped, &(elem(&1, 0) in names)))
      end
    end

    defp maybe_clear_inherited_tmux("tmux", opts) do
      Keyword.update(opts, :env, [{"TMUX", ""}], fn env ->
        [{"TMUX", ""} | Enum.reject(env, fn {key, _} -> key == "TMUX" end)]
      end)
    end

    defp maybe_clear_inherited_tmux(_command, opts), do: opts
  end
end
