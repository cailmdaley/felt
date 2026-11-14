defmodule Shuttle.Terminal.Receipts do
  @moduledoc """
  Worker liveness from the worker's own launch or claim, without scanning the
  process table.

  `Shuttle.Terminal.launch/5` records each launch's run script under the
  worker's name, and stamps the script so that its first act writes its pid
  beside that receipt. A claim (`claim/4`) records the harness process itself:
  its pid and birth time, plus the name to give the human's terminal back
  under once that process has exited. All live under `Shuttle.data_dir/0`,
  never in the tmp directory a cleaner may empty. The receipt answers:

    * `:running` — the recorded pid still runs that script (its argv names the
      script path, which stays in argv even if the file is deleted), or the
      claimed process is still alive with the same birth time.
    * `:exited` — the recorded pid no longer runs it, or the claimed pid is
      gone or reused. Positive evidence of death, whatever the terminal
      backend can or cannot see.
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

  defp process_path(name), do: path(name) <> ".process"

  @suffixes ["", ".pid", ".process"]

  @doc """
  Record the harness process a claim brought: `pid`, its birth read now, and
  `released_as`, the terminal name or label to restore when it has exited.
  """
  def claim(runner, name, pid, released_as) when is_integer(pid) and pid > 0 do
    case birth(runner, pid) do
      {:ok, birth} ->
        target = process_path(name)

        with :ok <- Shuttle.FS.mkdir_p(Path.dirname(target)) do
          Shuttle.FS.write_atomic(
            target,
            Jason.encode!(%{"pid" => pid, "birth" => birth, "released_as" => released_as})
          )
        end

      :none ->
        {:error, :process_not_found}

      :unknown ->
        {:error, :birth_unreadable}
    end
  end

  @doc "The claimed process's receipt, when `name` has one."
  def process_receipt(name) do
    with {:ok, raw} <- Shuttle.FS.read(process_path(name)),
         {:ok, %{"pid" => pid, "birth" => birth, "released_as" => released_as}}
         when is_integer(pid) and is_binary(birth) and is_binary(released_as) <-
           Jason.decode(raw) do
      {:ok, %{pid: pid, birth: birth, released_as: released_as}}
    else
      _ -> :none
    end
  end

  @doc "Forget every receipt under `name`."
  def drop(name) do
    for suffix <- @suffixes, do: Shuttle.FS.rm(path(name) <> suffix)
    :ok
  end

  @doc "Record `script` as worker `name`'s run script; return the script text stamped to record its pid."
  def put(name, script, script_text) do
    target = path(name)
    _ = Shuttle.FS.rm(pid_path(name))
    _ = Shuttle.FS.rm(process_path(name))

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

  @doc "A renamed terminal keeps its receipts; the old name no longer has any."
  def move(from, to) do
    drop(to)

    for suffix <- @suffixes do
      case Shuttle.FS.read(path(from) <> suffix) do
        {:ok, content} -> Shuttle.FS.write_atomic(path(to) <> suffix, content)
        _ -> :ok
      end
    end

    drop(from)
  end

  @spec status(module(), String.t()) :: :running | :exited | :none
  def status(runner, name) do
    case process_receipt(name) do
      {:ok, receipt} -> process_status(runner, receipt)
      :none -> script_status(runner, name)
    end
  end

  @doc "The claimed process's liveness alone; `:none` without a process receipt."
  @spec process_status(module(), String.t() | map()) :: :running | :exited | :none
  def process_status(runner, name) when is_binary(name) do
    case process_receipt(name) do
      {:ok, receipt} -> process_status(runner, receipt)
      :none -> :none
    end
  end

  def process_status(runner, %{pid: pid, birth: birth}) do
    case birth(runner, pid) do
      {:ok, ^birth} -> :running
      {:ok, _} -> :exited
      :none -> :exited
      :unknown -> :none
    end
  end

  defp script_status(runner, name) do
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

  @doc "The pid of a run script or claimed process positively running under `name`, else nil."
  def running_pid(runner, name) do
    with :running <- status(runner, name) do
      case process_receipt(name) do
        {:ok, %{pid: pid}} -> pid
        :none -> with {pid, _} <- read_pid(name), do: pid, else: (_ -> nil)
      end
    else
      _ -> nil
    end
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

  # A process's birth: `/proc/<pid>/stat` field 22 (start time in clock
  # ticks since boot) on Linux, else `ps -o lstart=` pinned to one locale and
  # zone. Same pid and birth means the same process.
  defp birth(runner, pid) do
    case proc_root() do
      {:ok, root} ->
        case Shuttle.FS.read(Path.join([root, Integer.to_string(pid), "stat"])) do
          {:ok, stat} ->
            case stat |> String.split(")") |> List.last() |> String.split() |> Enum.at(19) do
              nil -> :unknown
              start -> {:ok, start}
            end

          {:error, reason} when reason in [:enoent, :esrch] ->
            :none

          _ ->
            :unknown
        end

      :none ->
        case runner.cmd("ps", ["-o", "lstart=", "-p", Integer.to_string(pid)],
               env: [{"LC_ALL", "C"}, {"TZ", "UTC"}],
               stderr_to_stdout: true,
               timeout_ms: 5_000
             ) do
          {out, 0} when out != "" -> {:ok, String.trim(out)}
          {_, 0} -> :none
          {"", 1} -> :none
          _ -> :unknown
        end
    end
  end

  defp proc_root do
    root = Env.app(:proc_root, "/proc")

    case {Env.app(:os_type) || :os.type(), Shuttle.FS.stat(root)} do
      {{:unix, :linux}, {:ok, _}} -> {:ok, root}
      _ -> :none
    end
  end

  defp args(runner, pid) do
    case proc_root() do
      {:ok, root} ->
        case Shuttle.FS.read(Path.join([root, Integer.to_string(pid), "cmdline"])) do
          {:ok, cmdline} -> {:ok, String.replace(cmdline, <<0>>, " ")}
          {:error, reason} when reason in [:enoent, :esrch] -> :none
          _ -> :unknown
        end

      :none ->
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
