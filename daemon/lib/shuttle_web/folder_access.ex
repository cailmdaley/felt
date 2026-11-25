defmodule ShuttleWeb.FolderAccess do
  @moduledoc """
  Whether opening a file in a folder returns, asked of a throwaway OS process
  and remembered per folder for a while.

  An open can block without bound. macOS holds an open of a file in a folder
  it keeps from launchd processes (`~/Documents`, `~/Desktop`, `~/Downloads`
  and wherever else its privacy rules reach) while a consent prompt nobody
  sees waits, and a stalled network mount holds every open beneath it. An
  open in the BEAM pins a dirty I/O scheduler thread until the system call
  returns, which no exit signal interrupts, so a handful of such requests
  would wedge the whole daemon. The file routes ask here before they touch a
  path: `sh` opens the file, and one that has not exited within the deadline
  is SIGKILLed, which interrupts it mid-open, and the folder counts as one
  whose opens hang. Either answer stands for the folder for `@ttl_ms`, so a
  healthy folder pays one probe per interval and a wedged one fails at once
  after the first.

  No folder is refused by name: a daemon started from a terminal, or granted
  access, reads `~/Documents` like any other folder.

  The answer is about the folder, not one file's permissions: a folder whose
  opens return may still hold a file this daemon may not read, which the
  caller's own open then reports at once.

  Pure cache: this process owns the table and nothing else. A restart costs
  one probe per folder.
  """

  use GenServer

  @table :shuttle_folder_access
  @ttl_ms 30_000
  @deadline_ms 3_000
  @limit 1024

  @type verdict :: :returns | :hangs

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @impl true
  def init(_opts) do
    :ets.new(@table, [:named_table, :public, :set, read_concurrency: true])
    {:ok, nil}
  end

  @doc "The probe's deadline, in milliseconds."
  def deadline_ms, do: Shuttle.Env.app(:folder_probe_deadline_ms, @deadline_ms)

  @doc "Whether opens in `path`'s folder return, probing it unless remembered."
  @spec verdict(Path.t()) :: verdict()
  def verdict(path) do
    case cached(path) do
      nil -> remember(Path.dirname(path), probe(path))
      verdict -> verdict
    end
  end

  @doc "The remembered verdict for `path`'s folder, or `nil`; never probes."
  @spec cached(Path.t()) :: verdict() | nil
  def cached(path) do
    now = System.monotonic_time(:millisecond)

    case :ets.lookup(@table, Path.dirname(path)) do
      [{_folder, verdict, until}] when until > now -> verdict
      _ -> nil
    end
  end

  defp remember(folder, verdict) do
    if :ets.info(@table, :size) >= @limit, do: :ets.delete_all_objects(@table)
    :ets.insert(@table, {folder, verdict, System.monotonic_time(:millisecond) + @ttl_ms})
    verdict
  end

  # Whether the shell's open of `path` ends, however it ends: a missing or
  # unreadable file returns too.
  defp probe(path) do
    port =
      Port.open({:spawn_executable, Shuttle.Env.find_executable("sh")}, [
        :exit_status,
        args: ["-c", ~s(exec 2>/dev/null; : <"$1"), "folder-access", path]
      ])

    receive do
      {^port, {:exit_status, _status}} -> :returns
    after
      deadline_ms() -> abandon(port)
    end
  end

  # Close the port and kill the shell still in its open. The shell may exit on
  # its own at any moment, closing the port first, and its exit status may
  # already be in the mailbox; it is taken from there, where it would
  # otherwise wait for the next message the caller reads.
  defp abandon(port) do
    with {:os_pid, os_pid} <- Port.info(port, :os_pid) do
      try do
        Port.close(port)
      rescue
        ArgumentError -> :closed
      end

      Shuttle.Env.cmd("kill", ["-KILL", Integer.to_string(os_pid)], stderr_to_stdout: true)
    end

    receive do
      {^port, {:exit_status, _status}} -> :hangs
    after
      0 -> :hangs
    end
  end
end
