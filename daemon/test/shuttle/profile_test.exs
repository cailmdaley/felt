defmodule Shuttle.ProfileTest do
  use ExUnit.Case, async: false
  import Phoenix.ConnTest
  import Shuttle.Test.ApiConn
  @endpoint ShuttleWeb.Endpoint

  test "a one-second profile attributes File.stat and leaves other tracers intact" do
    legacy = :erlang.trace_info(self(), :flags)
    msacc_previous = :erlang.system_flag(:microstate_accounting, true)
    sibling = :trace.session_create(:profile_test_sibling, self(), [])
    sessions = :trace.session_info(:all)
    :trace.function(sibling, {File, :stat, 2}, true, [:local])
    worker = spawn(fn -> stat_loop() end)
    on_exit(fn -> Process.exit(worker, :kill) end)

    try do
      assert {:ok, result} = Shuttle.Profile.run(1)

      assert %{window: %{seconds: 1, single_flight: true}, processes: [_ | _], file_calls: calls} =
               result

      assert Enum.any?(calls.by_caller, fn row ->
               row.caller == "Shuttle.ProfileTest.stat_loop/0" and row.function == "File.stat/1" and
                 row.count > 0
             end)

      assert Enum.any?(
               calls.by_caller,
               &String.starts_with?(&1.function, ":prim_file.read_file_info/")
             )

      assert Enum.any?(calls.by_directory, &(&1.directory == Path.dirname(System.tmp_dir!())))
      assert Enum.any?(result.processes, &(&1.pid == inspect(worker) and &1.reductions_delta > 0))
      assert %{scheduler: %{emulator: emulator}} = result.msacc
      assert emulator >= 0
      assert :erlang.system_flag(:microstate_accounting, true)
      assert :erlang.trace_info(self(), :flags) == legacy
      assert :trace.info(sibling, {File, :stat, 2}, :traced) == {:traced, :local}
      assert Enum.sort(:trace.session_info(:all)) == Enum.sort(sessions)
      assert Jason.encode!(result)
    after
      Process.exit(worker, :kill)
      :trace.session_destroy(sibling)
      :erlang.system_flag(:microstate_accounting, msacc_previous)
    end
  end

  # The call is not in tail position, so the trace's caller is this function.
  def stat_loop do
    File.stat(System.tmp_dir!())

    receive do
      :stop -> :ok
    after
      1 -> stat_loop()
    end
  end

  test "concurrent HTTP profiles return 409, and killing a requester cleans up" do
    Shuttle.Test.Env.put_app_env(:host_class, :single_user)
    before_sessions = :trace.session_info(:all)
    request = spawn(fn -> Shuttle.Profile.run(300) end)
    on_exit(fn -> Process.exit(request, :kill) end)
    await_profile()
    conn = get(api_conn(), "/api/v1/debug/profile?seconds=1")
    assert conn.status == 409
    assert Jason.decode!(conn.resp_body) == %{"error" => "profile_in_progress"}
    owner = Process.whereis(Shuttle.Profile)
    monitor = Process.monitor(owner)
    Process.exit(request, :kill)
    assert_receive {:DOWN, ^monitor, :process, ^owner, :normal}, 5000
    assert :trace.session_info(:all) == before_sessions
  end

  test "shared host peer gate refuses the profile before it starts" do
    Shuttle.Test.Env.put_app_env(:host_class, :shared_multi_user)
    Shuttle.Test.Env.put_app_env(:peer_gate_expected_uid, 1234)
    conn = get(api_conn(), "/api/v1/debug/profile?seconds=1")
    assert conn.status == 403
    assert Jason.decode!(conn.resp_body)["error"] == "peer_refused"
    assert Process.whereis(Shuttle.Profile) == nil
  end

  test "CPU mode reports function and concurrent HTTP work without file calls" do
    Shuttle.Test.Env.put_app_env(:host_class, :single_user)
    sibling = :trace.session_create(:profile_cpu_sibling, self(), [])
    parent = self()

    request =
      spawn(fn ->
        send(
          parent,
          {:cpu_response, get(api_conn(), "/api/v1/debug/profile?mode=cpu&seconds=300")}
        )
      end)

    on_exit(fn ->
      Process.exit(request, :kill)
      :trace.session_destroy(sibling)
    end)

    session = await_profile()
    conn = get(api_conn(), "/api/v1/version")
    assert conn.status == 200

    assert_receive {:cpu_response, profile_conn}, 15_000
    assert profile_conn.status == 200
    body = Jason.decode!(profile_conn.resp_body)
    assert body["window"]["mode"] == "cpu"
    assert body["window"]["instrumented"] == true
    assert body["window"]["seconds"] == 10
    assert body["functions"]["available"] == true
    assert Enum.any?(body["http"]["groups"], &(&1["route"] == "/api/v1/version"))
    refute Map.has_key?(body, "file_calls")
    assert is_binary(body["runtime"]["otp_release"])
    assert is_binary(body["runtime"]["erts_version"])
    assert Enum.any?(:trace.session_info(:all), fn {name, _} -> name == :profile_cpu_sibling end)
    refute Enum.any?(:trace.session_info(:all), fn {name, _} -> name == :shuttle_profile end)
    assert session != nil
  end

  test "CPU duration has its own ten second clamp" do
    assert Shuttle.Profile.cpu_seconds("300") == 10
    assert Shuttle.Profile.cpu_seconds(0) == 1
    assert Shuttle.Profile.cpu_seconds(nil) == 10
  end

  test "killing a CPU profile requester detaches telemetry and destroys its session" do
    Shuttle.Test.Env.put_app_env(:host_class, :single_user)
    request = spawn(fn -> get(api_conn(), "/api/v1/debug/profile?mode=cpu&seconds=10") end)
    on_exit(fn -> Process.exit(request, :kill) end)
    await_profile()

    assert Enum.any?(:telemetry.list_handlers([:phoenix, :endpoint, :start]), fn handler ->
             match?({Shuttle.Profile.HTTP, _}, handler.id)
           end)

    owner = Process.whereis(Shuttle.Profile)
    monitor = Process.monitor(owner)
    Process.exit(request, :kill)
    assert_receive {:DOWN, ^monitor, :process, ^owner, :normal}, 5_000
    refute Enum.any?(:trace.session_info(:all), fn {name, _} -> name == :shuttle_profile end)

    refute Enum.any?(:telemetry.list_handlers([:phoenix, :endpoint, :start]), fn handler ->
             match?({Shuttle.Profile.HTTP, _}, handler.id)
           end)
  end

  test "collector backlog stops tracing and counts discarded queued events" do
    task = Task.async(fn -> Shuttle.Profile.run(1) end)
    session = await_profile()
    {:tracer, collector} = :trace.info(session, :new_processes, :tracer)
    :erlang.suspend_process(collector)

    try do
      for _ <- 1..11_000 do
        send(
          collector,
          {:trace, self(), :call, {File, :stat, ["/tmp/profile"]}, {__MODULE__, :flood, 0}}
        )
      end
    after
      :erlang.resume_process(collector)
    end

    assert {:ok, %{file_calls: %{truncated: true, dropped: dropped, events: events}}} =
             Task.await(task, 10_000)

    assert dropped > 10_000
    assert events < 200_000
    refute Enum.any?(:trace.session_info(:all), fn {name, _} -> name == :shuttle_profile end)
  end

  test "collector death cleans up tracing and releases single flight" do
    task = Task.async(fn -> Shuttle.Profile.run(300) end)
    session = await_profile()
    {:tracer, collector} = :trace.info(session, :new_processes, :tracer)
    Process.exit(collector, :kill)
    assert {:error, {:collector_down, :killed}} = Task.await(task, 5000)
    assert Process.whereis(Shuttle.Profile) == nil
    refute Enum.any?(:trace.session_info(:all), fn {name, _} -> name == :shuttle_profile end)
  end

  test "seconds and path cardinality are bounded" do
    assert Shuttle.Profile.seconds(nil) == 30
    assert Shuttle.Profile.seconds("no") == 30
    assert Shuttle.Profile.seconds("0") == 1
    assert Shuttle.Profile.seconds("301") == 300

    assert Shuttle.Profile.directory("/a/01ARZ3NDEKTSV4RRFFQ69G5FAV/b/c/d/e/f/file") ==
             "/a/<id>/b/c/d"

    assert Shuttle.Profile.directory("/a/550e8400-e29b-41d4-a716-446655440000/file") == "/a/<id>"
  end

  @tag :tmp_dir
  test "Linux proc snapshots parse comm, CPU ticks and limits", %{tmp_dir: root} do
    File.mkdir_p!(Path.join(root, "task/42"))

    File.write!(
      Path.join(root, "limits"),
      "Max cpu time              600                  unlimited            seconds\n"
    )

    write_stat(root, 100, 50)
    before = Shuttle.Profile.OS.snapshot(root)
    write_stat(root, 130, 70)
    later = Shuttle.Profile.OS.snapshot(root)

    assert %{
             process: %{utime: 0.3, stime: 0.2},
             accumulated: %{total: 2.0},
             threads: %{"erts_dios_2" => %{utime: 0.3, stime: 0.2}},
             rlimit_cpu: %{soft: 600, hard: "unlimited"}
           } = Shuttle.Profile.OS.delta(before, later)
  end

  defp write_stat(root, user, system) do
    fields =
      ["S" | List.duplicate("0", 10)] ++
        [to_string(user), to_string(system)] ++ List.duplicate("0", 6) ++ ["123"]

    stat = "42 (name with ) spaces) " <> Enum.join(fields, " ") <> "\n"
    File.write!(Path.join(root, "stat"), stat)
    File.write!(Path.join(root, "task/42/stat"), stat)
    File.write!(Path.join(root, "task/42/comm"), "erts_dios_2\n")
  end

  defp await_profile(attempts \\ 5000)
  defp await_profile(0), do: flunk("profile does not start")

  defp await_profile(attempts) do
    case Enum.find(:trace.session_info(:all), fn {name, _} -> name == :shuttle_profile end) do
      nil ->
        receive do
        after
          1 -> await_profile(attempts - 1)
        end

      session ->
        case :trace.info(session, :new_processes, :flags) do
          {:flags, [:call]} ->
            session

          _ ->
            receive do
            after
              1 -> await_profile(attempts - 1)
            end
        end
    end
  end
end
