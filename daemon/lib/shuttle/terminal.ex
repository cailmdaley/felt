defmodule Shuttle.Terminal do
  @moduledoc """
  Worker terminal lifecycle and conservative liveness policy.

  A terminal's positive presence gives `:alive`. Only positive absence from
  every backend AND a successful process scan finding no run script gives
  `:gone`. Every other observation is `:unknown`, which counts as present:
  uncertainty never frees a worker's name for a duplicate dispatch.

  Backends own terminal primitives. This facade owns the process fallback,
  per-name launch serialization, run scripts, and the stop signal ladder.
  """

  alias Shuttle.{Dispatcher, WorkerProcess}
  alias Shuttle.Terminal.Tmux

  @type status :: :alive | :gone | :unknown

  def primary do
    Shuttle.Env.app(:terminal_backend) ||
      case :persistent_term.get({__MODULE__, :primary}, "tmux") do
        "tmux" -> Tmux
        "rex" -> Shuttle.Terminal.Rex
      end
  end

  def backends do
    case primary() do
      Shuttle.Terminal.Rex ->
        if Tmux.available?(), do: [Shuttle.Terminal.Rex, Tmux], else: [Shuttle.Terminal.Rex]

      backend ->
        [backend]
    end
  end

  def available?, do: Enum.any?(backends(), & &1.available?())

  @spec status(module(), String.t(), keyword()) :: status()
  def status(runner, name, opts \\ []) do
    backends = Keyword.get_lazy(opts, :backends, &backends/0)
    observations = Enum.map(backends, &{&1, &1.probe(runner, name)})
    probes = Enum.map(observations, &elem(&1, 1))

    remember_holder(
      name,
      Enum.find_value(observations, fn {backend, probe} -> if probe == :present, do: backend end)
    )

    cond do
      :present in probes -> :alive
      Enum.all?(probes, &(&1 == :absent)) -> absent_status(runner, name, hd(backends))
      true -> :unknown
    end
  end

  defp absent_status(runner, name, backend) do
    with {:ok, procs} <- WorkerProcess.scan(runner),
         %{} = proc <- WorkerProcess.session_process(procs, name) do
      WorkerProcess.warn_once({:unreachable, name}, fn ->
        "#{backend.id()} cannot see session #{name}, but its worker is running " <>
          "(bash pid #{proc.pid}, parent #{proc.ppid}) — " <>
          backend.unreachable_hint(procs, proc)
      end)

      :unknown
    else
      {:error, :unknown} -> :unknown
      nil -> :gone
    end
  end

  def present?(runner, name), do: status(runner, name) != :gone

  def locate(runner, name) do
    backend = Enum.find(backends(), &(&1.probe(runner, name) == :present))
    remember_holder(name, backend)
    backend
  end

  def observed_id(name) do
    Shuttle.RuntimeCache.fetch({__MODULE__, :holder, name}, 10_000, fn -> nil end)
  end

  defp remember_holder(name, nil), do: Shuttle.RuntimeCache.delete({__MODULE__, :holder, name})

  defp remember_holder(name, backend),
    do: Shuttle.RuntimeCache.put({__MODULE__, :holder, name}, backend.id(), 10_000)

  @doc "Launch only when the name is positively free; keep its script in the worker's argv."
  def launch(runner, name, cwd, script_text, opts \\ []) do
    with_lock(name, fn ->
      if status(runner, name) == :gone do
        backend = primary()

        with :ok <- backend.ensure_ready(runner) do
          path = WorkerProcess.script_path(name)
          File.write!(path, script_text)
          File.chmod!(path, 0o755)

          case backend.launch(runner, name, cwd, path, opts) do
            :ok ->
              :ok

            {:error, _} = error ->
              File.rm(path)
              error
          end
        end
      else
        {:error, :already_running}
      end
    end)
  end

  @doc "Serialize a terminal mutation; a shared key also protects backend-wide indexes."
  def with_lock(key, fun), do: :global.trans({{__MODULE__, key}, self()}, fun)

  @doc "Hang up the terminal, then wait and signal its worker until positively gone."
  def stop(runner, name, opts \\ []) do
    backends = Keyword.get_lazy(opts, :backends, &backends/0)
    backend = Enum.find(backends, &(&1.probe(runner, name) == :present)) || hd(backends)

    case backend.close(runner, name) do
      :ok -> await_gone(runner, name, stop_ladder(), opts)
      :absent -> await_gone(runner, name, Enum.filter(stop_ladder(), &elem(&1, 0)), opts)
      {:error, message} -> {message, 1}
    end
  end

  # A failed probe is not proof that an address cannot receive a command.
  # With no observed holder, let the primary return the primitive's evidence.
  def close(runner, name), do: holder(runner, name).close(runner, name)
  def paste(runner, name, text), do: holder(runner, name).paste(runner, name, text)
  def rename(runner, from, to), do: holder(runner, from).rename(runner, from, to)
  def identity(runner, name), do: holder(runner, name).identity(runner, name)
  def owns_pane?(runner, name, pane), do: holder(runner, name).owns_pane?(runner, name, pane)
  def reveal(name, host \\ nil), do: holder(Shuttle.Runner.Default, name).reveal(name, host)

  defp holder(runner, name), do: locate(runner, name) || primary()

  def native_ref?("session:" <> _), do: true
  def native_ref?("block:" <> _), do: true
  def native_ref?(_), do: false

  @doc "List terminal names matching a prefix; an uncertain backend makes the list uncertain."
  def list(runner, prefix) do
    with {:ok, names} <- list_all(runner) do
      {:ok, Enum.filter(names, &String.starts_with?(&1, prefix))}
    end
  end

  @doc "Union worker terminals with run-script processes, preserving uncertain observations."
  def list_workers(runner) do
    with {:ok, names} <- list_all(runner) do
      listed = Enum.filter(names, &Dispatcher.shuttle_session?/1)

      case WorkerProcess.scan(runner) do
        {:ok, procs} -> {:ok, Enum.uniq(listed ++ WorkerProcess.sessions(procs))}
        {:error, :unknown} when listed == [] -> {:error, :unknown}
        {:error, :unknown} -> {:ok, listed}
      end
    end
  end

  defp list_all(runner) do
    Enum.reduce_while(backends(), {:ok, []}, fn backend, {:ok, names} ->
      case backend.list(runner) do
        {:ok, listed} -> {:cont, {:ok, Enum.uniq(names ++ listed)}}
        {:error, :unknown} = error -> {:halt, error}
      end
    end)
  end

  @stop_ladder [{nil, 3_000}, {"TERM", 2_000}, {"KILL", 1_000}]
  @stop_poll_ms 50

  defp stop_ladder, do: Shuttle.Env.app(:worker_stop_ladder, @stop_ladder)

  defp await_gone(_runner, name, [], _opts),
    do: {"worker of #{name} is still running after SIGKILL", 1}

  defp await_gone(runner, name, [{signal, wait_ms} | rest], opts) do
    if signal, do: signal_worker(runner, name, signal)
    deadline = System.monotonic_time(:millisecond) + wait_ms

    if gone_by?(runner, name, deadline, opts),
      do: {"", 0},
      else: await_gone(runner, name, rest, opts)
  end

  defp gone_by?(runner, name, deadline, opts) do
    cond do
      status(runner, name, opts) == :gone ->
        true

      System.monotonic_time(:millisecond) >= deadline ->
        false

      true ->
        Process.sleep(@stop_poll_ms)
        gone_by?(runner, name, deadline, opts)
    end
  end

  # The run script leads its process group, which holds the harness. Signal
  # both the group and process in case it does not lead one.
  defp signal_worker(runner, name, signal) do
    with {:ok, procs} <- WorkerProcess.scan(runner),
         %{pid: pid} <- WorkerProcess.session_process(procs, name) do
      runner.cmd("kill", ["-#{signal}", "--", "-#{pid}", "#{pid}"], stderr_to_stdout: true)
    end

    :ok
  end
end
