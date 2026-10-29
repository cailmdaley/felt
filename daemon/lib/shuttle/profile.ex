defmodule Shuttle.Profile do
  @moduledoc """
  On-demand, single-flight VM profiling. Trace sessions isolate this instrument
  from other tracers. File, Erlang file, and prim_file entries are separate
  layers, not additive NIF totals: OTP's file server hides the original caller
  at the prim_file boundary, so the public layers retain application callers.

  `truncated` means tracing stops early at the event/backlog limit. `dropped`
  counts queued events discarded, not calls made after tracing stops. A heap
  limit terminates an overloaded collector and fails the profile, not the VM.
  Processes and OS threads that exit during the window have no final sample.
  """

  @event_limit 200_000
  @backlog_limit 10_000

  def seconds(value) when is_integer(value), do: value |> max(1) |> min(300)

  def seconds(value) when is_binary(value) do
    case Integer.parse(value) do
      {n, ""} -> seconds(n)
      _ -> 30
    end
  end

  def seconds(_), do: 30

  def cpu_seconds(value) when is_integer(value), do: value |> max(1) |> min(10)

  def cpu_seconds(value) when is_binary(value) do
    case Integer.parse(value) do
      {n, ""} -> cpu_seconds(n)
      _ -> 10
    end
  end

  def cpu_seconds(_), do: 10

  def run(duration \\ 30), do: run(duration, [])

  def run(duration, opts) when is_list(opts) do
    mode = if Keyword.get(opts, :mode) == :cpu, do: :cpu, else: :file
    duration = if mode == :cpu, do: cpu_seconds(duration), else: seconds(duration)
    caller = self()
    ref = make_ref()
    {pid, monitor} = spawn_monitor(fn -> acquire(caller, ref, duration, mode) end)

    receive do
      {^ref, result} ->
        receive do
          {:DOWN, ^monitor, :process, ^pid, _} -> result
        end

      {:DOWN, ^monitor, :process, ^pid, reason} ->
        {:error, {:profile_failed, reason}}
    end
  end

  defp acquire(caller, ref, duration, mode) do
    acquired =
      try do
        Process.register(self(), __MODULE__)
      rescue
        ArgumentError -> false
      end

    if acquired do
      result = capture(caller, duration, mode)
      send(caller, {ref, result})
    else
      send(caller, {ref, {:error, :busy}})
    end
  end

  defp capture(caller, duration, :cpu) do
    memory = poller_memory_snapshot()

    case Shuttle.Profile.HTTP.start() do
      {:ok, http_profile} -> capture_started(caller, duration, :cpu, http_profile, memory)
      {:error, reason} -> {:error, {:http_telemetry, reason}}
    end
  end

  defp capture(caller, duration, :file), do: capture_started(caller, duration, :file, nil, nil)

  defp capture_started(caller, duration, mode, http_profile, memory) do
    owner = Process.monitor(caller)

    profiler = self()

    {collector, monitor} =
      :erlang.spawn_opt(
        fn ->
          Process.monitor(profiler)
          collect(empty_calls(), nil)
        end,
        [:monitor, {:max_heap_size, %{size: 4_000_000, kill: true, error_logger: false}}]
      )

    session = :trace.session_create(:shuttle_profile, collector, [])
    function_state = if mode == :cpu, do: Shuttle.Profile.Functions.start(session)
    ms = start_msacc()

    try do
      send(collector, {:session, session})
      if mode == :file, do: start_trace(session)
      before_os = Shuttle.Profile.OS.snapshot()
      before_processes = reductions()
      started = DateTime.utc_now() |> DateTime.to_iso8601()
      before_ms = msacc_stats(ms)
      :trace.process(session, :all, true, [:call])
      if mode == :file, do: :trace.process(session, self(), false, [:call])
      before_gc = if mode == :cpu, do: :erlang.statistics(:garbage_collection)

      receive do
        {:DOWN, ^owner, :process, ^caller, _} -> {:error, :request_down}
        {:DOWN, ^monitor, :process, ^collector, reason} -> {:error, {:collector_down, reason}}
      after
        duration * 1000 ->
          functions =
            if function_state, do: Shuttle.Profile.Functions.finish(session, function_state)

          :trace.session_destroy(session)
          delivered = :trace.delivered(session, :all)

          receive do
            {:trace_delivered, :all, ^delivered} -> :ok
          after
            5000 -> raise "trace delivery timed out"
          end

          after_ms = msacc_stats(ms)
          after_gc = if mode == :cpu, do: :erlang.statistics(:garbage_collection)
          after_os = Shuttle.Profile.OS.snapshot()
          processes = top_processes(before_processes)
          send(collector, {:finish, self()})

          receive do
            {:file_calls, calls} ->
              result = %{
                window: %{started_at: started, seconds: duration, single_flight: true},
                os: Shuttle.Profile.OS.delta(before_os, after_os),
                msacc: msacc_delta(before_ms, after_ms),
                processes: processes
              }

              if mode == :cpu do
                http = Shuttle.Profile.HTTP.finish(http_profile)

                {:ok,
                 Map.merge(result, %{
                   window: Map.merge(result.window, %{mode: :cpu, instrumented: true}),
                   functions: functions,
                   http: http,
                   memory: memory,
                   gc: gc_delta(before_gc, after_gc),
                   runtime: runtime()
                 })}
              else
                {:ok, Map.put(result, :file_calls, calls)}
              end

            {:DOWN, ^monitor, :process, ^collector, reason} ->
              {:error, {:collector_down, reason}}

            {:DOWN, ^owner, :process, ^caller, _} ->
              {:error, :request_down}
          after
            5000 -> {:error, :collector_timeout}
          end
      end
    after
      :trace.session_destroy(session)
      stop_msacc(ms)
      Process.exit(collector, :kill)
      Process.demonitor(monitor, [:flush])
      Process.demonitor(owner, [:flush])
      if http_profile, do: Shuttle.Profile.HTTP.stop(http_profile)
    end
  end

  defp poller_memory_snapshot do
    Shuttle.Poller.cpu_memory_measurements()
  rescue
    _ -> %{available: false, reason: "poller_unreachable"}
  catch
    :exit, _ -> %{available: false, reason: "poller_unreachable"}
  end

  defp gc_delta({before_count, before_words, _}, {after_count, after_words, _}) do
    word_size_bytes = :erlang.system_info(:wordsize)
    words_reclaimed = after_words - before_words

    %{
      collections: after_count - before_count,
      words_reclaimed: words_reclaimed,
      bytes_reclaimed: words_reclaimed * word_size_bytes,
      word_size_bytes: word_size_bytes
    }
  end

  defp runtime do
    %{
      otp_release: :erlang.system_info(:otp_release) |> List.to_string(),
      erts_version: :erlang.system_info(:version) |> List.to_string()
    }
  end

  defp start_trace(session) do
    spec = [{:_, [], [{:message, {:caller}}]}]

    for module <- [:prim_file, :file, File] do
      Code.ensure_loaded!(module)

      for {function, arity} <- module.module_info(:exports),
          function not in [:module_info, :__info__, :on_load, :start] do
        :trace.function(session, {module, function, arity}, spec, [:local])
      end
    end

    :trace.function(session, {:erlang, :open_port, 2}, spec, [:local])
  end

  defp empty_calls do
    %{
      events: 0,
      dropped: 0,
      truncated: false,
      by_caller: %{},
      by_directory: %{},
      port_spawns: %{}
    }
  end

  defp collect(state, session) do
    receive do
      {:session, handle} ->
        collect(state, handle)

      {:finish, owner} ->
        send(owner, {:file_calls, format_calls(state)})

      {:DOWN, _ref, :process, _owner, _reason} ->
        if session, do: :trace.session_destroy(session)
        :ok

      {:trace, _pid, :call, {module, function, args}, caller} ->
        state =
          if state.truncated do
            %{state | dropped: state.dropped + 1}
          else
            state |> count_call(module, function, args, caller) |> limit(session)
          end

        collect(state, session)
    end
  end

  defp limit(state, session) do
    if state.events >= @event_limit or
         (rem(state.events, 256) == 0 and
            elem(Process.info(self(), :message_queue_len), 1) > @backlog_limit) do
      :trace.session_destroy(session)
      %{state | truncated: true}
    else
      state
    end
  end

  defp count_call(state, module, function, args, caller) do
    mfa = {module, function, length(args)}
    key = {mfa_string(caller), mfa_string(mfa)}
    state = %{state | events: state.events + 1}

    if mfa == {:erlang, :open_port, 2} do
      Map.update!(state, :port_spawns, &increment(&1, key))
    else
      state = Map.update!(state, :by_caller, &increment(&1, key))

      case args do
        [path | _] when is_binary(path) or is_list(path) ->
          case directory(path) do
            nil -> state
            dir -> Map.update!(state, :by_directory, &increment(&1, dir))
          end

        _ ->
          state
      end
    end
  end

  defp increment(map, key), do: Map.update(map, key, 1, &(&1 + 1))

  @doc false
  def directory(path) do
    try do
      path = IO.chardata_to_string(path)

      if String.valid?(path) and byte_size(path) <= 4096 and not String.contains?(path, <<0>>) do
        path
        |> Path.dirname()
        |> Path.split()
        |> Enum.take(6)
        |> Enum.map(fn part ->
          if Regex.match?(
               ~r/^(?:[0-9A-HJKMNP-TV-Z]{26}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
               part
             ), do: "<id>", else: part
        end)
        |> Path.join()
      end
    rescue
      ArgumentError -> nil
      UnicodeConversionError -> nil
    end
  end

  defp format_calls(state) do
    %{
      events: state.events,
      dropped: state.dropped,
      truncated: state.truncated,
      event_limit: @event_limit,
      backlog_limit: @backlog_limit,
      by_caller: caller_rows(state.by_caller),
      port_spawns: caller_rows(state.port_spawns),
      by_directory:
        top(state.by_directory)
        |> Enum.map(fn {dir, count} ->
          %{directory: dir, count: count}
        end)
    }
  end

  defp caller_rows(counts) do
    top(counts)
    |> Enum.map(fn {{caller, function}, count} ->
      %{caller: caller, function: function, count: count}
    end)
  end

  defp top(counts), do: counts |> Enum.sort_by(fn {key, n} -> {-n, key} end) |> Enum.take(40)

  defp reductions do
    for pid <- Process.list(),
        {:reductions, n} <- [Process.info(pid, :reductions)],
        into: %{},
        do: {pid, n}
  end

  defp top_processes(before) do
    reductions()
    |> Enum.map(fn {pid, n} -> {pid, max(n - Map.get(before, pid, 0), 0)} end)
    |> Enum.sort_by(fn {pid, n} -> {-n, pid} end)
    |> Enum.take(25)
    |> Enum.flat_map(fn {pid, n} ->
      case Process.info(pid, [
             :registered_name,
             :initial_call,
             :current_function,
             :message_queue_len,
             :memory,
             :dictionary
           ]) do
        nil ->
          []

        info ->
          initial = Keyword.get(info[:dictionary], :"$initial_call", info[:initial_call])

          [
            %{
              pid: inspect(pid),
              registered_name: name(info[:registered_name]),
              initial_call: mfa_string(initial),
              translated_initial_call: mfa_string(:proc_lib.translate_initial_call(pid)),
              current_function: mfa_string(info[:current_function]),
              message_queue_len: info[:message_queue_len],
              memory: info[:memory],
              reductions_delta: n
            }
          ]
      end
    end)
  end

  defp name([]), do: nil
  defp name(value), do: value

  defp mfa_string({m, f, a}) when is_atom(m) and is_atom(f) and is_integer(a),
    do: "#{inspect(m)}.#{f}/#{a}"

  defp mfa_string(other), do: inspect(other)

  defp start_msacc do
    try do
      previous = :erlang.system_flag(:microstate_accounting, true)
      {:enabled, previous}
    catch
      :error, :badarg -> nil
      :error, :undef -> nil
    end
  end

  defp stop_msacc({:enabled, previous}), do: :erlang.system_flag(:microstate_accounting, previous)
  defp stop_msacc(nil), do: :ok
  defp msacc_stats(nil), do: nil

  defp msacc_stats(_) do
    try do
      :msacc.stats()
    catch
      :error, :undef -> nil
      :error, :badarg -> nil
    end
  end

  defp msacc_delta(nil, _), do: nil
  defp msacc_delta(_, nil), do: nil

  defp msacc_delta(before, later) do
    baseline = Map.new(before, fn row -> {{row.type, row.id}, row.counters} end)

    Enum.reduce(later, %{}, fn row, acc ->
      counters = Map.get(baseline, {row.type, row.id}, %{})

      delta =
        Map.new(row.counters, fn {key, value} ->
          {key, max(counter(value) - counter(Map.get(counters, key, 0)), 0) / 1_000_000}
        end)

      Map.update(acc, row.type, delta, &Map.merge(&1, delta, fn _, a, b -> a + b end))
    end)
  end

  defp counter({time, _count}), do: time
  defp counter(time), do: time
end
