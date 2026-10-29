defmodule Shuttle.Profile.FunctionsTest do
  use ExUnit.Case, async: true

  alias Shuttle.Profile.Functions

  defmodule EmptyUidRunner do
    def cmd("felt", ["-C", _store, "show", _uid, "-j"], _opts),
      do: {"not found", 1}

    def cmd("felt", ["-C", _store, "ls", "-j", "-s", "all"], _opts),
      do: {"[]", 0}
  end

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
      assert {Shuttle.Poller, :run_shuttle_listing, 5} in state.active
      assert {Shuttle.FeltStores, :felt_ls_json, 1} in state.active
      assert {Shuttle.FiberDocuments, :ls_rows, 4} in state.active

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

      assert result["semantics"]["source_helper_counters"] ==
               "per-process correlation for PIDs retained in top_process_functions; not inclusive decode timings"

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

  test "source helper rows survive the top process cutoff for retained decode workers" do
    Shuttle.Test.Env.own_scope!()
    Shuttle.Test.Env.put_app_env(:felt_stores_runner, EmptyUidRunner)

    collector = spawn(fn -> receive do: (:stop -> :ok) end)
    session = :trace.session_create(:profile_functions_source_rows, collector, [])
    parent = self()
    payload = Jason.encode!(Enum.to_list(1..4_000))
    uid = "01ARZ3NDEKTSV4RRFFQ69G5FAV"

    try do
      state = Functions.start(session)
      assert {Shuttle.FeltStores, :felt_ls_json, 1} in state.active

      tasks =
        for _ <- 1..45 do
          Task.async(fn ->
            send(parent, {:source_worker_ready, self()})

            receive do
              :profile ->
                assert {:error, :not_found} =
                         Shuttle.FeltStores.resolve_fiber(uid, ["/profile/test-store"])

                for _ <- 1..30, do: Jason.decode!(payload)
                :ok
            end
          end)
        end

      worker_pids =
        for _ <- tasks do
          assert_receive {:source_worker_ready, pid}
          pid
        end

      assert Enum.sort(worker_pids) == Enum.sort(Enum.map(tasks, & &1.pid))
      Enum.each(worker_pids, &:trace.process(session, &1, true, [:call]))
      Enum.each(tasks, &send(&1.pid, :profile))
      assert Enum.all?(Task.await_many(tasks, 30_000), &(&1 == :ok))

      result = Functions.finish(session, state)
      assert result["available"]

      decode_pids =
        result["top_process_functions"]
        |> Enum.filter(&(&1["function"] == "Jason.decode/2"))
        |> MapSet.new(& &1["pid"])

      assert MapSet.size(decode_pids) > 0

      helper_pids =
        result["source_process_functions"]
        |> Enum.filter(&(&1["function"] == "Shuttle.FeltStores.felt_ls_json/1"))
        |> MapSet.new(& &1["pid"])

      assert MapSet.subset?(decode_pids, helper_pids)
      assert result["source_process_functions_limit"] == 120
      assert result["source_process_functions_omitted_count"] >= 5
      assert result["source_process_functions_truncated"]
      assert length(result["top_process_functions"]) <= 40
      assert length(result["source_process_functions"]) <= 120
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
