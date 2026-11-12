defmodule Shuttle.Terminal do
  @moduledoc """
  Worker terminal lifecycle and conservative liveness policy.

  A terminal or run-script process gives positive `:alive` evidence. A
  worker's launch receipt (`Shuttle.Terminal.Receipts`) is decisive both ways:
  its recorded pid running the run script is `:alive`, that pid gone is
  `:gone`, with no process-table scan. Without a receipt, only positive
  absence from every backend AND a successful process scan finding no run
  script gives `:gone` — or, when the scan fails, a pre-receipt launch whose
  reserved script is gone. Every other observation is `:unknown`.
  Unknown liveness retains a worker with launch evidence, but does not create
  one or prevent a fiber's first launch.

  Backends own terminal primitives. This facade owns the process fallback,
  per-name launch serialization, run scripts, and the stop signal ladder.
  """

  alias Shuttle.{Dispatcher, WorkerProcess}
  alias Shuttle.Terminal.{LaunchAttempts, Receipts, Tmux}

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

  @doc "A permanently unusable primary is a dispatch refusal, not liveness uncertainty."
  def require_config do
    if primary() == Shuttle.Terminal.Rex,
      do: Shuttle.Terminal.Rex.require_config(),
      else: :ok
  end

  def backend_health do
    if primary() == Shuttle.Terminal.Rex,
      do: Shuttle.Terminal.Rex.health(),
      else: %{state: "not_selected", available: false, reason: nil}
  end

  @spec status(module(), String.t(), keyword()) :: status()
  def status(runner, name, opts \\ []) do
    backends = Keyword.get_lazy(opts, :backends, &backends/0)

    observations =
      backends
      |> observation_order(name)
      |> Enum.reduce_while([], fn backend, acc ->
        probe = backend.probe(runner, name)
        observations = [{backend, probe} | acc]
        if probe == :present, do: {:halt, observations}, else: {:cont, observations}
      end)

    probes = Enum.map(observations, &elem(&1, 1))

    remember_holder(
      name,
      Enum.find_value(observations, fn {backend, probe} -> if probe == :present, do: backend end)
    )

    if :present in probes do
      :alive
    else
      case Receipts.status(runner, name) do
        :exited -> :gone
        :running -> unreachable(name, hd(backends))
        :none -> process_status(runner, name, observations, hd(backends))
      end
    end
  end

  defp unreachable(name, backend) do
    WorkerProcess.warn_once({:unreachable, name}, fn ->
      "#{backend.id()} cannot see session #{name}, but its run script is running"
    end)

    :alive
  end

  # Bound Rex addresses win. For unbound names, a positive tmux probe avoids
  # scanning Rex's session/block labels for every pre-flip worker and viewer.
  defp observation_order(backends, name) do
    if Tmux in backends and Shuttle.Terminal.Rex in backends and
         not native_ref?(name) and not rex_bound?(name),
       do: [Tmux | List.delete(backends, Tmux)],
       else: backends
  end

  defp rex_bound?(name) do
    case Shuttle.Terminal.RexBindings.read() do
      {:ok, doc} -> Map.has_key?(doc["bindings"], name)
      {:error, _} -> false
    end
  end

  defp process_status(runner, name, observations, backend) do
    with {:ok, procs} <- WorkerProcess.scan(runner) do
      case WorkerProcess.session_process(procs, name) do
        nil ->
          if Enum.all?(observations, fn {_, probe} -> probe == :absent end),
            do: :gone,
            else: :unknown

        proc ->
          WorkerProcess.warn_once({:unreachable, name}, fn ->
            "#{backend.id()} cannot see session #{name}, but its worker is running " <>
              "(bash pid #{proc.pid}, parent #{proc.ppid}) — " <>
              backend.unreachable_hint(procs, proc)
          end)

          :alive
      end
    else
      {:error, :unknown} -> if Receipts.legacy_exited?(name), do: :gone, else: :unknown
    end
  end

  @doc "Unknown liveness holds an existing assignment, never invents a first launch."
  def present?(runner, name, opts \\ []) do
    case status(runner, name) do
      :gone -> false
      observation -> availability(observation, name, opts) != :ok
    end
  end

  def check_available(runner, name, opts \\ []),
    do: availability(status(runner, name), name, opts)

  defp availability(:alive, _name, _opts), do: {:error, :already_running}

  defp availability(:gone, name, _opts) do
    case LaunchAttempts.get(name) do
      {:ok, info} ->
        if LaunchAttempts.dispatch_pending?(info),
          do: {:error, {:launch_reserved, info}},
          else: :ok

      :none ->
        :ok
    end
  end

  defp availability(:unknown, name, opts) do
    case LaunchAttempts.get(name) do
      {:ok, info} ->
        {:error, {:launch_reserved, info}}

      :none ->
        if Keyword.get(opts, :launch_evidence, true) or rex_bound?(name),
          do: {:error, :already_running},
          else: :ok
    end
  end

  def release_reservation(name),
    do: with_lock(name, fn -> LaunchAttempts.release(name) end)

  def locate(runner, name) do
    case locate_target(runner, name) do
      {backend, _target} -> backend
      nil -> nil
    end
  end

  @doc "Locate a terminal and retain its resolved address for immediate reveal."
  def locate_target(runner, name) do
    target =
      Enum.find_value(observation_order(backends(), name), fn
        Shuttle.Terminal.Rex = backend ->
          case backend.locate(runner, name) do
            {:ok, binding} -> {backend, binding}
            {:error, _} -> nil
          end

        backend ->
          if backend.probe(runner, name) == :present, do: {backend, name}
      end)

    remember_holder(name, if(target, do: elem(target, 0)))
    target
  end

  def observed_id(name) do
    Shuttle.RuntimeCache.fetch({__MODULE__, :holder, name}, 10_000, fn -> nil end)
  end

  defp remember_holder(name, nil), do: Shuttle.RuntimeCache.delete({__MODULE__, :holder, name})

  defp remember_holder(name, backend),
    do: Shuttle.RuntimeCache.put({__MODULE__, :holder, name}, backend.id(), 10_000)

  @doc "Serialize launches using the assignment's evidence; keep the script in the worker's argv."
  def launch(runner, name, cwd, script_text, opts \\ []) do
    acquire = fn ->
      with_lock(name, fn ->
        with :ok <- require_config() do
          launch_ready(runner, name, cwd, script_text, opts)
        end
      end)
    end

    case opts[:conversation_uuid] || get_in(opts, [:prepared_launch, "session_uuid"]) do
      uuid when is_binary(uuid) and uuid != "" -> with_lock({:conversation, uuid}, acquire)
      _ -> acquire.()
    end
  end

  defp check_conversation(_runner, nil), do: :ok

  defp check_conversation(runner, uuid) do
    with :ok <- WorkerProcess.check_free(runner, uuid),
         {:ok, attempts} <- LaunchAttempts.for_conversation(uuid),
         {:ok, procs} <- WorkerProcess.scan(runner) do
      Enum.reduce_while(attempts, :ok, fn attempt, :ok ->
        evidence =
          cond do
            WorkerProcess.script_process(procs, attempt["script"]) -> :alive
            WorkerProcess.session_process(procs, attempt["worker"]) -> :gone
            true -> status(runner, attempt["worker"])
          end

        case evidence do
          :gone ->
            {:cont, :ok}

          _ ->
            {:halt,
             {:error,
              {:transcript_held,
               "session #{uuid} is being opened or held by #{attempt["worker"]}"}}}
        end
      end)
    else
      {:error, {_, message}} ->
        {:error, {:transcript_held, message}}

      {:error, :unknown} ->
        {:error, {:transcript_held, "Cannot read conversation launch reservations"}}
    end
  end

  defp launch_ready(runner, name, cwd, script_text, opts) do
    backend = primary()

    with :ok <- check_available(runner, name, opts),
         :ok <- check_conversation(runner, opts[:conversation_uuid]),
         :ok <- if(opts[:preflighted], do: :ok, else: backend.ensure_ready(runner)),
         :ok <- LaunchAttempts.clear(name) do
      path = WorkerProcess.script_path(name)
      {:ok, script_text} = Receipts.put(name, path, script_text)
      Shuttle.FS.write_private!(path, script_text, 0o700)

      case LaunchAttempts.record(name, path, %{
             "conversation_uuid" =>
               opts[:conversation_uuid] || get_in(opts, [:prepared_launch, "session_uuid"]),
             "dispatch" => opts[:prepared_launch]
           }) do
        :ok ->
          launch_backend(runner, backend, name, cwd, path, opts)

        error ->
          Shuttle.FS.rm(path)
          error
      end
    end
  end

  defp launch_backend(runner, backend, name, cwd, path, opts) do
    case backend.launch(runner, name, cwd, path, opts) do
      :ok ->
        refresh_layout(runner, backend)
        :ok

      {:error, {:unknown, reason}} = error ->
        LaunchAttempts.note(name, reason)
        error

      {:error, _} = error ->
        LaunchAttempts.clear(name)
        error
    end
  end

  @doc "Serialize a terminal mutation; a shared key also protects backend-wide indexes."
  def with_lock(key, fun), do: Shuttle.Lock.transaction({__MODULE__, key}, fun)

  @doc "Hang up the terminal, then wait and signal its worker until positively gone."
  def stop(runner, name, opts \\ []) do
    backends = Keyword.get_lazy(opts, :backends, &backends/0)

    backend =
      Enum.find(observation_order(backends, name), &(&1.probe(runner, name) == :present)) ||
        hd(backends)

    case backend.close(runner, name) do
      :ok ->
        refresh_layout(runner, backend)
        await_gone(runner, name, stop_ladder(), opts)

      :absent ->
        refresh_layout(runner, backend)
        await_gone(runner, name, Enum.filter(stop_ladder(), &elem(&1, 0)), opts)

      # An unreachable terminal does not matter once its worker is gone.
      {:error, message} ->
        if status(runner, name, opts) == :gone, do: {"", 0}, else: {message, 1}
    end
  end

  # A failed probe is not proof that an address cannot receive a command.
  # With no observed holder, let the primary return the primitive's evidence.
  def close(runner, name) do
    backend = holder(runner, name)
    result = backend.close(runner, name)
    if result in [:ok, :absent], do: refresh_layout(runner, backend)
    result
  end

  def paste(runner, name, text), do: holder(runner, name).paste(runner, name, text)

  def rename(runner, from, to, opts \\ []) do
    backend = holder(runner, from)

    with :ok <- backend.rename(runner, from, to),
         :ok <- Receipts.move(from, to) do
      if backend == Shuttle.Terminal.Rex do
        with :ok <- Shuttle.Terminal.RexBindings.put_fiber(to, opts[:fiber]) do
          refresh_layout(runner, backend)
        end
      else
        :ok
      end
    end
  end

  defp refresh_layout(runner, Shuttle.Terminal.Rex),
    do: Shuttle.Terminal.RexTree.refresh(runner)

  defp refresh_layout(_runner, _backend), do: :ok
  def identity(runner, name), do: holder(runner, name).identity(runner, name)
  def owns_pane?(runner, name, pane), do: holder(runner, name).owns_pane?(runner, name, pane)

  defp holder(_runner, "session:" <> _), do: Shuttle.Terminal.Rex
  defp holder(_runner, "block:" <> _), do: Shuttle.Terminal.Rex
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

  @doc """
  Union worker terminals with run-script processes. `{:partial, names}` when
  the terminals listed but the process scan failed: every name is live, but a
  live worker without a visible terminal may be missing.
  """
  def list_workers(runner) do
    with {:ok, names} <- list_all(runner) do
      listed = Enum.filter(names, &Dispatcher.shuttle_session?/1)

      case WorkerProcess.scan(runner) do
        {:ok, procs} -> {:ok, Enum.uniq(listed ++ WorkerProcess.sessions(procs))}
        {:error, :unknown} -> {:partial, listed}
      end
    end
  end

  defp list_all(runner) do
    Enum.reduce_while(backends(), {:ok, []}, fn backend, {:ok, names} ->
      case backend.list(runner) do
        {:ok, listed} ->
          {:cont, {:ok, Enum.uniq(names ++ listed)}}

        {:error, :unknown} = error ->
          {:halt, error}
      end
    end)
  end

  @stop_ladder [{nil, 3_000}, {"TERM", 2_000}, {"KILL", 1_000}]
  @stop_poll_ms 50

  defp stop_ladder, do: Shuttle.Env.app(:worker_stop_ladder, @stop_ladder)

  defp await_gone(_runner, name, [], _opts),
    do: {"worker of #{name} is still running after SIGKILL", 1}

  # Unknown liveness ends the ladder at once, as stopped: no signal can settle
  # a worker nothing can observe, every further look repeats a scan that may
  # take seconds on a loaded host, and refusing would leave the human no way to
  # stop it. A launch still refuses while that worker cannot be ruled out
  # (`check_available/3`), so stopping it never makes room for a second one.
  defp await_gone(runner, name, [{signal, wait_ms} | rest], opts) do
    if signal, do: signal_worker(runner, name, signal)
    deadline = System.monotonic_time(:millisecond) + wait_ms

    case gone_by(runner, name, deadline, opts) do
      :gone ->
        {"", 0}

      :unknown ->
        WorkerProcess.warn_once({:unobservable_stop, name}, fn ->
          "stopped #{name} without seeing it exit: no terminal shows it, it has no " <>
            "launch receipt, and the process table could not be read"
        end)

        {"", 0}

      :alive ->
        await_gone(runner, name, rest, opts)
    end
  end

  defp gone_by(runner, name, deadline, opts) do
    case status(runner, name, opts) do
      :alive ->
        if System.monotonic_time(:millisecond) >= deadline do
          :alive
        else
          Process.sleep(@stop_poll_ms)
          gone_by(runner, name, deadline, opts)
        end

      settled ->
        settled
    end
  end

  # The run script leads its process group, which holds the harness. Signal
  # both the group and process in case it does not lead one. The launch
  # receipt names the pid without a process scan.
  defp signal_worker(runner, name, signal) do
    pid =
      Receipts.running_pid(runner, name) ||
        with {:ok, procs} <- WorkerProcess.scan(runner),
             %{pid: pid} <- WorkerProcess.session_process(procs, name),
             do: pid,
             else: (_ -> nil)

    if pid,
      do: runner.cmd("kill", ["-#{signal}", "--", "-#{pid}", "#{pid}"], stderr_to_stdout: true)

    :ok
  end
end
