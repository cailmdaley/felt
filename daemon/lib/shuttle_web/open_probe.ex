defmodule ShuttleWeb.OpenProbe do
  @moduledoc """
  Whether this daemon's open of a file returns, asked of a throwaway OS
  process and remembered for that file for a while.

  An open can block without bound. macOS holds an open of a file in a folder
  it keeps from launchd processes (`~/Documents`, `~/Desktop`, `~/Downloads`
  and wherever else its privacy rules reach) while a consent prompt nobody
  sees waits, and a stalled network mount holds every open beneath it. An
  open in the BEAM pins a dirty I/O scheduler thread until the system call
  returns, which no exit signal interrupts, so a handful of such requests
  would wedge the whole daemon. The file routes ask here before they open a
  path: `sh` opens the file itself, and one that has not exited within the
  deadline is SIGKILLed, which interrupts it mid-open. The probe runs in a
  task under `Shuttle.TaskSupervisor`, which kills its shell at the deadline
  whether or not the request that asked is still waiting for it.

  A verdict is one file's, keyed by the path asked about. An open that
  returned stands for `@ttl_ms`, in which the file route opens and reads that
  file in the BEAM; an open that hung stands as long, in which the file is
  refused at once. A failed open is not remembered, since asking again is
  quick. No other file is judged by it, and no folder is refused by name: a
  daemon started from a terminal, or granted access, reads `~/Documents` like
  any other folder.

  What stays in the BEAM, unbounded: `stat` and `lstat`, which return under
  macOS's privacy rules; opens and reads of a file whose probe passed within
  the last `@ttl_ms`, which a mount that stalls since, or a file replaced
  since by a link into a guarded folder, would still hold; and all I/O on the
  daemon's own `~/.shuttle`, whose loss the daemon cannot outlive anyway.

  Pure cache: this process owns the table and nothing else. While it
  restarts, the missing table is a miss on read and on write.
  """

  use GenServer

  @table :shuttle_open_probe
  @ttl_ms 30_000
  @deadline_ms 3_000
  @limit 1024
  # How much longer than the deadline a caller waits for the probe's task,
  # which kills its shell at the deadline and answers then.
  @grace_ms 2_000

  @typedoc "An open that returned, one that failed with the shell's words, or one that did not end."
  @type verdict :: :opens | {:fails, String.t()} | :hangs

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @impl true
  def init(_opts) do
    :ets.new(@table, [:named_table, :public, :set, read_concurrency: true])
    {:ok, nil}
  end

  @doc "The probe's deadline, in milliseconds."
  def deadline_ms, do: Shuttle.Env.app(:open_probe_deadline_ms, @deadline_ms)

  @doc "Whether this daemon's open of `path` returns, probing it unless remembered."
  @spec verdict(Path.t()) :: verdict()
  def verdict(path) do
    with nil <- cached(path) do
      sh = Shuttle.Env.find_executable("sh")
      deadline = deadline_ms()

      task =
        Task.Supervisor.async_nolink(Shuttle.TaskSupervisor, fn ->
          remember(path, probe(sh, path, deadline))
        end)

      case Task.yield(task, deadline + @grace_ms) || Task.ignore(task) do
        {:ok, verdict} -> verdict
        {:exit, reason} -> exit(reason)
        nil -> :hangs
      end
    end
  end

  @doc "The remembered verdict for `path`, or `nil`; never probes."
  @spec cached(Path.t()) :: :opens | :hangs | nil
  def cached(path) do
    now = System.monotonic_time(:millisecond)

    case :ets.lookup(@table, path) do
      [{_path, verdict, until}] when until > now -> verdict
      _ -> nil
    end
  rescue
    ArgumentError -> nil
  end

  defp remember(_path, {:fails, _words} = verdict), do: verdict

  defp remember(path, verdict) do
    if :ets.info(@table, :size) >= @limit, do: :ets.delete_all_objects(@table)
    :ets.insert(@table, {path, verdict, System.monotonic_time(:millisecond) + @ttl_ms})
    verdict
  rescue
    ArgumentError -> verdict
  end

  # The shell opens `path` for reading; its words on a failed open end with
  # the system's reason (`sh: <path>: Permission denied`).
  defp probe(sh, path, deadline) do
    port =
      Port.open({:spawn_executable, sh}, [
        :binary,
        :exit_status,
        :stderr_to_stdout,
        env: [{~c"LC_ALL", ~c"C"}],
        args: ["-c", ~s(: <"$1"), "open-probe", path]
      ])

    await(port, "", System.monotonic_time(:millisecond) + deadline)
  end

  defp await(port, words, until) do
    receive do
      {^port, {:data, data}} ->
        await(port, words <> data, until)

      {^port, {:exit_status, 0}} ->
        :opens

      {^port, {:exit_status, _status}} ->
        {:fails, words |> String.trim() |> String.split(": ") |> List.last()}
    after
      max(until - System.monotonic_time(:millisecond), 0) -> abandon(port)
    end
  end

  # Close the port and kill the shell still in its open. The shell may exit on
  # its own at any moment, closing the port first.
  defp abandon(port) do
    with {:os_pid, os_pid} <- Port.info(port, :os_pid) do
      try do
        Port.close(port)
      rescue
        ArgumentError -> :closed
      end

      Shuttle.Env.cmd("kill", ["-KILL", Integer.to_string(os_pid)], stderr_to_stdout: true)
    end

    :hangs
  end
end
