defmodule Shuttle.Profile.FunctionsTest do
  use ExUnit.Case, async: true

  alias Shuttle.Profile.Functions

  test "captures selected function counters for a process that has exited" do
    collector = spawn(fn -> receive do: (:stop -> :ok) end)
    session = :trace.session_create(:profile_functions_test, collector, [])

    try do
      state = Functions.start(session)
      assert {Jason, :encode!, 1} in state.active
      assert {Jason, :encode_to_iodata!, 1} in state.active
      assert {Jason, :encode_to_iodata!, 2} in state.active
      assert {Jason, :decode, 1} in state.active
      assert {Jason, :decode, 2} in state.active

      test_pid = self()

      {worker, monitor} =
        spawn_monitor(fn ->
          send(test_pid, {:worker_ready, self()})

          receive do
            :go -> Jason.encode!(%{"probe" => true})
          end
        end)

      assert_receive {:worker_ready, ^worker}
      :trace.process(session, worker, true, [:call])
      send(worker, :go)
      assert_receive {:DOWN, ^monitor, :process, ^worker, :normal}

      result = Functions.finish(session, state)
      assert result["available"]
      assert result["semantics"]["includes_uninstrumented_callees"]
      assert result["semantics"]["excludes_instrumented_callees"]
      refute result["semantics"]["covers_total_vm_cpu"]
      assert result["semantics"]["cpu_excludes_wait"]

      assert %{"function" => "Jason.encode!/1", "calls" => calls} =
               Enum.find(result["functions"], &(&1["function"] == "Jason.encode!/1"))

      assert calls == 1
      assert Enum.any?(result["top_process_functions"], &(&1["pid"] == inspect(worker)))
      assert is_binary(Jason.encode!(result))
    after
      :trace.session_destroy(session)
      Process.exit(collector, :kill)
    end
  end

  test "nested instrumented Jason wrappers exclude the inner function cost" do
    collector = spawn(fn -> receive do: (:stop -> :ok) end)
    session = :trace.session_create(:profile_functions_nested, collector, [])

    try do
      state = Functions.start(session)
      test_pid = self()

      {worker, monitor} =
        spawn_monitor(fn ->
          send(test_pid, {:worker_ready, self()})

          receive do
            :go -> Jason.encode_to_iodata!(%{"probe" => Enum.to_list(1..100)})
          end
        end)

      assert_receive {:worker_ready, ^worker}
      :trace.process(session, worker, true, [:call])
      send(worker, :go)
      assert_receive {:DOWN, ^monitor, :process, ^worker, :normal}

      result = Functions.finish(session, state)

      outer =
        Enum.find(
          result["top_process_functions"],
          &(&1["function"] == "Jason.encode_to_iodata!/1")
        )

      inner =
        Enum.find(
          result["top_process_functions"],
          &(&1["function"] == "Jason.encode_to_iodata!/2")
        )

      assert outer["calls"] == 1
      assert outer["allocated_words"] == 0
      assert inner["calls"] == 1
      assert inner["allocated_words"] > 0
      assert result["semantics"]["excludes_instrumented_callees"]
    after
      :trace.session_destroy(session)
      Process.exit(collector, :kill)
    end
  end

  test "pausing this session leaves a sibling trace session active" do
    tracer = spawn(fn -> receive do: (:stop -> :ok) end)
    first = :trace.session_create(:profile_functions_first, tracer, [])
    second = :trace.session_create(:profile_functions_second, tracer, [])

    try do
      state = Functions.start(first)
      :trace.function(second, {Jason, :encode!, 1}, true, [:call_time])
      :trace.process(first, self(), true, [:call])
      :trace.process(second, self(), true, [:call])
      Jason.encode!(%{"before" => true})

      assert Functions.finish(first, state)["available"]
      Jason.encode!(%{"after" => true})

      assert {:call_time, counters} = :trace.info(second, {Jason, :encode!, 1}, :call_time)
      assert Enum.any?(counters, fn {_pid, calls, _seconds, _microseconds} -> calls >= 2 end)
    after
      :trace.session_destroy(first)
      :trace.session_destroy(second)
      Process.exit(tracer, :kill)
    end
  end

  test "a destroyed session produces an unavailable JSON-safe result" do
    tracer = spawn(fn -> receive do: (:stop -> :ok) end)
    session = :trace.session_create(:profile_functions_destroyed, tracer, [])

    state = Functions.start(session)
    :trace.process(session, self(), true, [:call])
    :trace.session_destroy(session)

    result = Functions.finish(session, state)
    assert result["available"] == false
    assert result["reason"] == "trace_session_unavailable"
    assert result["semantics"]["includes_uninstrumented_callees"]
    assert result["semantics"]["excludes_instrumented_callees"]
    refute result["semantics"]["covers_total_vm_cpu"]
    assert is_binary(Jason.encode!(result))
    Process.exit(tracer, :kill)
  end
end
