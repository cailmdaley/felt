defmodule Shuttle.Terminal.Receipts do
  @moduledoc """
  Worker liveness from the worker's own launch, without scanning the process table.

  `Shuttle.Terminal.launch/5` records each launch's run script under the
  worker's name, and stamps the script so that its first act writes its pid
  beside that receipt. Both live under `Shuttle.data_dir/0`, never in the tmp
  directory a cleaner may empty. The receipt answers:

    * `:running` — the recorded pid still runs that script (its argv names the
      script path, which stays in argv even if the file is deleted).
    * `:exited` — the recorded pid no longer runs it. Positive evidence of
      death, whatever the terminal backend can or cannot see.
    * `:none` — no receipt, or the script has not recorded its pid yet, or the
      lookup failed; the caller falls back to terminals and a process scan.

  One lookup of one pid keeps this answer fast where a full `ps` scan stalls
  on a loaded shared host.
  """

  alias Shuttle.Env
  alias Shuttle.Terminal.LaunchAttempts

  defp path(name) do
    key = :crypto.hash(:sha256, name) |> Base.encode16(case: :lower)
    Path.join([Shuttle.data_dir(), "terminals", "receipts", key])
  end

  @doc false
  def pid_path(name), do: path(name) <> ".pid"

  @doc "Record `script` as worker `name`'s run script; return the script text stamped to record its pid."
  def put(name, script, script_text) do
    target = path(name)
    _ = Shuttle.FS.rm(pid_path(name))

    with :ok <- Shuttle.FS.mkdir_p(Path.dirname(target)),
         :ok <- Shuttle.FS.write_atomic(target, script) do
      {:ok, stamp(script_text, pid_path(name))}
    end
  end

  # The pid line goes right after the interpreter line, before any `set -e`,
  # so a failed write cannot stop the worker.
  defp stamp(text, pid_path) do
    line = "printf '%s\\n' \"$$\" > #{quote_sh(pid_path)} 2>/dev/null\n"

    case String.split(text, "\n", parts: 2) do
      ["#!" <> _ = shebang, rest] -> shebang <> "\n" <> line <> rest
      _ -> line <> text
    end
  end

  defp quote_sh(text), do: "'" <> String.replace(text, "'", "'\\''") <> "'"

  @doc "A renamed terminal keeps its run script; the old name no longer has one."
  def move(from, to) do
    for suffix <- ["", ".pid"], do: Shuttle.FS.rm(path(to) <> suffix)

    with {:ok, script} <- Shuttle.FS.read(path(from)),
         :ok <- Shuttle.FS.write_atomic(path(to), script) do
      case Shuttle.FS.read(pid_path(from)) do
        {:ok, pid} -> Shuttle.FS.write_atomic(pid_path(to), pid)
        _ -> :ok
      end
    end

    for suffix <- ["", ".pid"], do: Shuttle.FS.rm(path(from) <> suffix)
    :ok
  end

  @spec status(module(), String.t()) :: :running | :exited | :none
  def status(runner, name) do
    with {:ok, script} when script != "" <- Shuttle.FS.read(path(name)),
         {pid, _} when pid > 0 <- read_pid(name) do
      case args(runner, pid) do
        {:ok, args} -> if String.contains?(args, script), do: :running, else: :exited
        :none -> :exited
        :unknown -> :none
      end
    else
      _ -> :none
    end
  end

  @doc "The pid of a run script positively running under `name`, else nil."
  def running_pid(runner, name) do
    with :running <- status(runner, name), {pid, _} <- read_pid(name), do: pid, else: (_ -> nil)
  end

  @doc """
  A launch without a receipt (one made before receipts) whose reserved script
  file is gone. Weak evidence — a tmp cleaner deletes old scripts too — so it
  is consulted only after the process scan has failed.
  """
  def legacy_exited?(name) do
    case Shuttle.FS.read(path(name)) do
      {:ok, _} ->
        false

      _ ->
        case LaunchAttempts.recorded_script(name) do
          nil -> false
          script -> Shuttle.FS.stat(script) == {:error, :enoent}
        end
    end
  end

  defp read_pid(name) do
    case Shuttle.FS.read(pid_path(name)) do
      {:ok, raw} -> Integer.parse(String.trim(raw))
      _ -> :error
    end
  end

  defp args(runner, pid) do
    root = Env.app(:proc_root, "/proc")

    case {Env.app(:os_type) || :os.type(), Shuttle.FS.stat(root)} do
      {{:unix, :linux}, {:ok, _}} ->
        case Shuttle.FS.read(Path.join([root, Integer.to_string(pid), "cmdline"])) do
          {:ok, cmdline} -> {:ok, String.replace(cmdline, <<0>>, " ")}
          {:error, reason} when reason in [:enoent, :esrch] -> :none
          _ -> :unknown
        end

      _ ->
        case runner.cmd("ps", ["-ww", "-o", "args=", "-p", Integer.to_string(pid)],
               stderr_to_stdout: true,
               timeout_ms: 5_000
             ) do
          {args, 0} -> {:ok, args}
          {"", 1} -> :none
          _ -> :unknown
        end
    end
  end
end
