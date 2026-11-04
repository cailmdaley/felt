defmodule Shuttle.Terminal do
  @moduledoc """
  Worker terminal lifecycle and conservative liveness policy.

  A terminal or run-script process gives positive `:alive` evidence. Only
  positive absence from every backend AND a successful process scan finding
  no run script gives `:gone`. Every other observation is `:unknown`.
  Unknown liveness retains a worker with launch evidence, but does not create
  one or prevent a fiber's first launch.

  Backends own terminal primitives. This facade owns the process fallback,
  per-name launch serialization, run scripts, and the stop signal ladder.
  """

  alias Shuttle.{Dispatcher, WorkerProcess}
  alias Shuttle.Terminal.{LaunchAttempts, Tmux}

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

    cond do
      :present in probes -> :alive
      true -> process_status(runner, name, observations, hd(backends))
    end
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
      {:error, :unknown} -> :unknown
    end
  end

  @doc "Unknown liveness holds an existing assignment, never invents a first launch."
  def present?(runner, name, opts \\ []) do
    check_available(runner, name, opts) != :ok
  end

  def check_available(runner, name, opts \\ []) do
    case status(runner, name) do
      :alive ->
        {:error, :already_running}

      :gone ->
        :ok

      :unknown ->
        case LaunchAttempts.get(name) do
          {:ok, info} ->
            {:error, {:launch_reserved, info}}

          :none ->
            if Keyword.get(opts, :launch_evidence, true) or rex_bound?(name),
              do: {:error, :already_running},
              else: :ok
        end
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

    case opts[:conversation_uuid] do
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
      Shuttle.FS.write_private!(path, script_text, 0o700)

      case LaunchAttempts.record(name, path, %{"conversation_uuid" => opts[:conversation_uuid]}) do
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
  def with_lock(key, fun), do: :global.trans({{__MODULE__, key}, self()}, fun)

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

      {:error, message} ->
        {message, 1}
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

    with :ok <- backend.rename(runner, from, to) do
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
