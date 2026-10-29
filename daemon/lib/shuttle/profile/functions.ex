defmodule Shuttle.Profile.Functions do
  @moduledoc """
  Collects bounded counters for selected dispatcher and serialization functions.

  Function counters are inclusive: a caller's time and allocations include the
  work of functions it calls. They are diagnostics and must not be summed as a
  measure of total VM work. Call time excludes waiting. Instrumentation adds
  overhead; exclude this window from steady-state rates.
  """

  @functions [
    {Shuttle.Poller, :start_poll_plan_task, 3},
    {Shuttle.Poller, :start_poll_read_task, 4},
    {Shuttle.Poller, :poll_reads, 2},
    {Shuttle.Poller, :apply_poll_cycle, 2},
    {Shuttle.Poller, :cached_fiber, 2},
    {Shuttle.Poller, :owner_feed_base, 1},
    {Shuttle.Poller, :stamp_runtime, 3},
    {Shuttle.Poller, :stamp_pending_results, 2},
    {Shuttle.Poller.Snapshot, :build_snapshot, 1},
    {Shuttle.Poller.Snapshot, :put_runtime, 5},
    {Shuttle.Poller.Snapshot, :put_held, 2},
    {Shuttle.Poller.Snapshot, :runtime_index, 2},
    {Shuttle.RemoteFiberRegistry, :build_feeds_view, 1},
    {Shuttle.RemoteFiberRegistry, :persist, 3},
    {ShuttleWeb.FiberDocumentsController, :cached_owner_feed, 0},
    {ShuttleWeb.FiberDocumentsController, :serve_owner_feed, 1},
    {ShuttleWeb.FiberDocumentsController, :composite, 2},
    {ShuttleWeb.RelayHelpers, :etag_hash, 1},
    {ShuttleWeb.ConditionalJSON, :send, 2},
    {Jason, :encode!, 1},
    {:erlang, :term_to_binary, 1}
  ]

  @max_rows 40

  @doc "Starts counters for the static allowlist in an existing trace session."
  def start(session) do
    {active, skipped} =
      Enum.split_with(@functions, fn {module, _function, _arity} = mfa ->
        if module == :erlang or Code.ensure_loaded?(module) do
          try do
            :trace.function(session, mfa, true, [:call_time, :call_memory]) == 1
          catch
            _, _ -> false
          end
        else
          false
        end
      end)

    %{active: active, skipped: skipped}
  end

  @doc "Pauses and reads counters, returning bounded JSON-safe diagnostics."
  def finish(session, %{active: active, skipped: skipped}) do
    finish_counters(session, active, skipped)
  end

  def finish(session, active) when is_list(active), do: finish_counters(session, active, [])

  defp finish_counters(session, active, skipped) do
    Enum.each(active, fn mfa ->
      try do
        :trace.function(session, mfa, :pause, [:call_time, :call_memory])
      catch
        _, _ -> :ok
      end
    end)

    case read_counters(session, active) do
      {:ok, rows} ->
        totals =
          rows
          |> Enum.group_by(& &1["function"])
          |> Enum.map(fn {function, entries} ->
            %{
              "function" => function,
              "calls" => Enum.sum(Enum.map(entries, & &1["calls"])),
              "cpu_microseconds" => Enum.sum(Enum.map(entries, & &1["cpu_microseconds"])),
              "allocated_words" => Enum.sum(Enum.map(entries, & &1["allocated_words"]))
            }
          end)
          |> Enum.sort_by(&{-&1["cpu_microseconds"], &1["function"]})

        %{
          "available" => true,
          "semantics" => %{
            "inclusive" => true,
            "cpu_excludes_wait" => true,
            "instrumentation_overhead" => "included; exclude profile windows from steady rates",
            "totals_are_additive" => false
          },
          "functions" => totals,
          "skipped_functions" => Enum.map(skipped, &mfa_string/1),
          "top_process_functions" =>
            Enum.take(
              Enum.sort_by(rows, &{-&1["cpu_microseconds"], &1["function"], &1["pid"]}),
              @max_rows
            ),
          "process_function_limit" => @max_rows
        }

      :unavailable ->
        %{
          "available" => false,
          "reason" => "trace_session_unavailable",
          "functions" => [],
          "skipped_functions" => Enum.map(skipped, &mfa_string/1),
          "top_process_functions" => [],
          "process_function_limit" => @max_rows,
          "semantics" => %{
            "inclusive" => true,
            "cpu_excludes_wait" => true,
            "instrumentation_overhead" => "included; exclude profile windows from steady rates",
            "totals_are_additive" => false
          }
        }
    end
  end

  defp read_counters(session, active) do
    result =
      Enum.reduce_while(active, {:ok, []}, fn {module, function, arity} = mfa, {:ok, rows} ->
        with {:ok, times} <- info(session, mfa, :call_time),
             {:ok, memories} <- info(session, mfa, :call_memory) do
          memory_by_pid = Map.new(memories, fn {pid, calls, words} -> {pid, {calls, words}} end)

          new_rows =
            Enum.map(times, fn {pid, calls, seconds, microseconds} ->
              {memory_calls, words} = Map.get(memory_by_pid, pid, {0, 0})

              %{
                "pid" => inspect(pid),
                "function" => mfa_string({module, function, arity}),
                "calls" => max(calls, memory_calls),
                "cpu_microseconds" => seconds * 1_000_000 + microseconds,
                "allocated_words" => words
              }
            end)

          {:cont, {:ok, new_rows ++ rows}}
        else
          _ -> {:halt, :unavailable}
        end
      end)

    case result do
      {:ok, rows} -> {:ok, rows}
      :unavailable -> :unavailable
    end
  rescue
    _ -> :unavailable
  catch
    _, _ -> :unavailable
  end

  defp info(session, mfa, item) do
    case :trace.info(session, mfa, item) do
      {^item, values} when is_list(values) -> {:ok, values}
      _ -> :error
    end
  catch
    _, _ -> :error
  end

  defp mfa_string({module, function, arity}), do: "#{inspect(module)}.#{function}/#{arity}"
end
