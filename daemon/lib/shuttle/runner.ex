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
  """

  @callback cmd(String.t(), [String.t()], keyword()) ::
              {String.t(), non_neg_integer() | :timeout}

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
      {timeout_ms, opts} = Keyword.pop(opts, :timeout_ms, default_timeout_ms())
      opts = maybe_clear_inherited_tmux(command, opts)

      # `System.cmd/3` resolves the executable the same way and raises
      # `ErlangError :enoent` when it's missing; map that documented failure
      # mode to exit 127 (the shell's "command not found") so PATH problems
      # degrade like any other failed command instead of crashing the caller.
      case System.find_executable(command) do
        nil -> {"#{command}: command not found", 127}
        executable -> run_bounded(executable, command, args, opts, timeout_ms)
      end
    end

    defp run_bounded(executable, command, args, opts, timeout_ms) do
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
      # exactly as bare `System.cmd/3` would — only :enoent and the timeout are
      # softened into the tuple contract.
      port = Port.open({:spawn_executable, executable}, port_opts)

      os_pid =
        case Port.info(port, :os_pid) do
          {:os_pid, pid} -> pid
          _ -> nil
        end

      deadline = System.monotonic_time(:millisecond) + timeout_ms
      collect(port, os_pid, command, args, timeout_ms, deadline, [])
    end

    defp collect(port, os_pid, command, args, timeout_ms, deadline, acc) do
      remaining = max(deadline - System.monotonic_time(:millisecond), 0)

      receive do
        {^port, {:data, data}} ->
          collect(port, os_pid, command, args, timeout_ms, deadline, [acc | [data]])

        {^port, {:exit_status, status}} ->
          {IO.iodata_to_binary(acc), status}
      after
        remaining ->
          # Reap, don't just abandon: SIGKILL the OS process, then close the
          # port and drain anything it raced onto our mailbox between the kill
          # and the close — a non-trapping GenServer caller must never see a
          # stray `{port, …}` message on a later receive.
          if os_pid, do: kill9(os_pid)
          safe_close(port)
          flush_port(port)
          {"#{command} #{Enum.join(args, " ")} timed out after #{timeout_ms}ms", :timeout}
      end
    end

    # `:os.cmd`-free, port-free kill: /bin/kill exists on macOS and every
    # Linux cluster. Spawned bare (not through cmd/3) to avoid recursion.
    defp kill9(os_pid) do
      System.cmd("kill", ["-9", Integer.to_string(os_pid)], stderr_to_stdout: true)
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
      do: Application.get_env(:shuttle, :cmd_timeout_ms, @default_timeout_ms)

    defp maybe_clear_inherited_tmux("tmux", opts) do
      Keyword.update(opts, :env, [{"TMUX", ""}], fn env ->
        [{"TMUX", ""} | Enum.reject(env, fn {key, _} -> key == "TMUX" end)]
      end)
    end

    defp maybe_clear_inherited_tmux(_command, opts), do: opts
  end
end
