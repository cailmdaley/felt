defmodule Shuttle.TranscriptIndexerTest do
  use ExUnit.Case, async: true

  alias Shuttle.TranscriptIndexer
  alias Shuttle.Test.Env
  import ExUnit.CaptureLog
  import Shuttle.Test.ApiConn
  import Phoenix.ConnTest

  @endpoint ShuttleWeb.Endpoint
  @moduletag :tmp_dir
  @receipt Jason.encode!(%{index: %{sessions: 1, messages: 2}, errors: []})

  defmodule Runner do
    def cmd(command, args, opts) do
      send(Shuttle.Env.app(:indexer_test_pid), {:index_command, self(), command, args, opts})

      receive do
        {:result, result} -> result
        {:exit, reason} -> exit(reason)
      end
    end
  end

  setup %{tmp_dir: tmp} do
    Env.put_app_env(:indexer_test_pid, self())
    Env.put_env("SHUTTLE_HOST_CONFIG_FILE", Path.join(tmp, "host.json"))
    :ok
  end

  defp start_indexer(opts \\ []) do
    Env.start_scoped!(
      {TranscriptIndexer,
       Keyword.merge(
         [name: nil, runner: Runner, boot_delay_ms: :infinity, interval_ms: :infinity],
         opts
       )}
    )
  end

  defp command(pid) do
    send(pid, :index)
    assert_receive {:index_command, task, "nice", args, opts}
    assert args == ["-n", "10", "shuttle", "transcript", "index", "--json"]
    assert opts[:stderr_to_stdout]
    {task, opts}
  end

  defp complete(pid, task, result) do
    monitor = Process.monitor(task)
    send(task, {:result, result})
    assert_receive {:DOWN, ^monitor, :process, ^task, :normal}
    await_idle(pid)
  end

  # Calls yield to the server until it consumes the monitored task's result.
  # The deadline is only a failure bound, never a successful-path sleep.
  defp await_idle(pid, deadline \\ nil) do
    deadline = deadline || System.monotonic_time(:millisecond) + 10_000
    state = :sys.get_state(pid)

    if state.task == nil do
      state
    else
      assert System.monotonic_time(:millisecond) < deadline, "indexer did not finish"
      await_idle(pid, deadline)
    end
  end

  test "production boot and catch-up timers run off-mailbox even under quarantine" do
    Env.put_app_env(:boot_quarantine, true)
    pid = start_indexer(boot_delay_ms: 5_000, interval_ms: 300_000)
    initial = :sys.get_state(pid)
    assert Process.read_timer(initial.timer) in 0..5_000
    assert TranscriptIndexer.status(pid).state == :scheduled
    {task, opts} = command(pid)
    assert opts[:timeout_ms] == 1_800_000
    assert Process.read_timer(:sys.get_state(pid).task.deadline) in 0..1_805_000
    assert TranscriptIndexer.status(pid).state == :running
    assert Shuttle.Readiness.status().ready

    # Duplicate ticks cannot overlap the blocked command or queue a new pass.
    send(pid, :index)
    send(pid, :index)
    assert :sys.get_state(pid).task.pid == task
    refute_received {:index_command, _, _, _, _}

    finished = complete(pid, task, {@receipt, 0})
    assert finished.status.ok == true
    assert finished.status.duration_ms >= 0
    assert %DateTime{} = finished.status.last_run_at
    assert Process.read_timer(finished.timer) in 0..300_000
    refute_received {:index_command, _, _, _, _}

    # A later scheduled tick starts a fresh pass, rather than caching success.
    {next, _} = command(pid)
    refute next == task
    complete(pid, next, {@receipt, 0})
  end

  test "boot and catch-up timers trigger passes without an external tick" do
    pid = start_indexer(boot_delay_ms: 0, interval_ms: 0)
    assert_receive {:index_command, first, "nice", _, _}
    assert TranscriptIndexer.status(pid).state == :running
    send(first, {:result, {@receipt, 0}})
    assert_receive {:index_command, second, "nice", _, _}
    refute second == first
    assert TranscriptIndexer.status(pid).ok
    assert TranscriptIndexer.status(pid).state == :running
  end

  test "defaults schedule an actual boot pass and completion schedules catch-up" do
    # Omit the production defaults rather than supplying the values under test.
    pid = Env.start_scoped!({TranscriptIndexer, name: nil, runner: Runner})
    assert Process.read_timer(:sys.get_state(pid).timer) in 0..5_000
    {task, _} = command(pid)
    finished = complete(pid, task, {@receipt, 0})
    assert Process.read_timer(finished.timer) in 0..300_000
  end

  test "host opt-out skips commands and a subsequent pass re-reads config", %{tmp_dir: tmp} do
    path = Path.join(tmp, "host.json")
    File.write!(path, ~s({"transcript_index":false}))
    pid = start_indexer()
    send(pid, :index)
    state = await_idle(pid)
    assert state.status.state == :disabled
    assert state.status.ok == nil
    refute_received {:index_command, _, _, _, _}

    File.write!(path, ~s({"transcript_index":true}))
    {task, _} = command(pid)
    complete(pid, task, {@receipt, 0})
    assert TranscriptIndexer.status(pid).ok
  end

  test "only literal false opts out; malformed config warns rather than crashing", %{tmp_dir: tmp} do
    for value <- [nil, "false", 0] do
      File.write!(Path.join(tmp, "host.json"), Jason.encode!(%{transcript_index: value}))

      assert capture_log(fn -> assert Shuttle.Host.transcript_index?() end) =~
               "must be true or false"
    end

    File.write!(Path.join(tmp, "host.json"), "not json")

    assert capture_log(fn -> assert Shuttle.Host.transcript_index?() end) =~
             "cannot read transcript_index"
  end

  test "version stays responsive during a scan and exposes its last result" do
    pid = start_indexer()
    {task, _} = command(pid)
    version = api_conn() |> get("/api/v1/version") |> json_response(200)
    assert version["ready"]
    assert version["transcript_indexer"]["state"] == "running"
    assert version["transcript_indexer"]["ok"] == nil
    complete(pid, task, {@receipt, 0})

    health =
      api_conn()
      |> get("/api/v1/version")
      |> json_response(200)
      |> Map.fetch!("transcript_indexer")

    assert health["state"] == "idle"
    assert health["ok"] == true
    assert health["error"] == nil
    assert health["duration_ms"] >= 0
    assert {:ok, _, _} = DateTime.from_iso8601(health["last_run_at"])
  end

  for {label, result, error} <- [
        {"nonzero exit", {"disk full", 1}, "disk full"},
        {"CLI timeout", {"deadline", :timeout}, "timeout"},
        {"invalid receipt", {"garbage", 0}, "invalid receipt"},
        {"partial scan", {~s({"index":{},"errors":["unreadable transcript"]}), 0}, "incomplete"}
      ] do
    test "#{label} logs health failure and the next pass can recover" do
      pid = start_indexer()
      {task, _} = command(pid)

      log = capture_log(fn -> complete(pid, task, unquote(Macro.escape(result))) end)
      assert log =~ unquote(error)
      assert %{ok: false, error: error, duration_ms: duration} = TranscriptIndexer.status(pid)
      assert error =~ unquote(error)
      assert duration >= 0
      assert Process.alive?(pid)

      {next, _} = command(pid)
      complete(pid, next, {@receipt, 0})
      assert %{ok: true, error: nil} = TranscriptIndexer.status(pid)
    end
  end

  test "task crash and outer deadline are observed without crashing the server" do
    pid = start_indexer()
    {task, _} = command(pid)
    monitor = Process.monitor(task)

    capture_log(fn ->
      send(task, {:exit, :broken})
      assert_receive {:DOWN, ^monitor, :process, ^task, :broken}
      await_idle(pid)
    end)

    assert %{ok: false, error: error} = TranscriptIndexer.status(pid)
    assert error =~ "broken"

    {next, _} = command(pid)
    ref = :sys.get_state(pid).task.ref
    monitor = Process.monitor(next)

    capture_log(fn ->
      send(pid, {:index_timeout, ref})
      assert_receive {:DOWN, ^monitor, :process, ^next, :killed}
      await_idle(pid)
    end)

    assert %{ok: false, error: "index task exceeded its deadline"} = TranscriptIndexer.status(pid)
    # Stale result/timeout messages cannot overwrite a newer success.
    {last, _} = command(pid)
    complete(pid, last, {@receipt, 0})
    send(pid, {ref, {:error, "stale"}})
    send(pid, {:index_timeout, ref})
    assert TranscriptIndexer.status(pid).ok
  end

  test "real shuttle builds a missing index and catches up all three synthetic harnesses", %{
    tmp_dir: tmp
  } do
    # The suite's normal CLI prerequisite supplies this binary. A temporary
    # source build can be prepended to PATH; no installation is needed.
    assert Shuttle.Env.find_executable("shuttle")
    Env.put_env("HOME", tmp)
    Env.put_env("XDG_CACHE_HOME", Path.join(tmp, "cache"))
    Env.put_env("SHUTTLE_TRANSCRIPT_INDEX", Path.join(tmp, "index.sqlite"))
    Env.put_env("SHUTTLE_DATA_DIR", Path.join(tmp, "state"))
    Env.put_env("SHUTTLE_DAEMON_URL", "http://127.0.0.1:1")
    Env.put_env("SHUTTLE_SESSIONS_FILE", Path.join(tmp, "sessions.jsonl"))
    Env.put_env("SHUTTLE_REMOTES_FILE", Path.join(tmp, "remotes.json"))

    for {harness, env} <- [
          {"claude", "SHUTTLE_CLAUDE_PROJECTS_DIR"},
          {"codex", "SHUTTLE_CODEX_SESSIONS_DIR"},
          {"pi", "SHUTTLE_PI_SESSIONS_DIR"}
        ] do
      root = Path.join(tmp, harness)
      File.mkdir_p!(root)
      Env.put_env(env, root)

      filename = if harness == "codex", do: "rollout-fixture.jsonl", else: "#{harness}.jsonl"

      File.cp!(
        Path.expand("../../../internal/transcriptindex/testdata/#{harness}.jsonl", __DIR__),
        Path.join(root, filename)
      )
    end

    Env.put_app_env(:felt_runner, Shuttle.Runner.Default)
    pid = start_indexer(runner: Shuttle.Runner.Default)
    send(pid, :index)
    assert await_idle(pid).status.ok
    assert File.exists?(Path.join(tmp, "index.sqlite"))

    {:ok, output} = Shuttle.CLI.run(["transcript", "search", "VMPZ", "--no-index", "--json"])
    doc = Jason.decode!(output)
    assert doc["index"]["sessions"] == 3
    assert MapSet.new(doc["hits"], & &1["harness"]) == MapSet.new(["claude", "codex", "pi"])

    appended =
      Jason.encode!(%{
        type: "user",
        sessionId: "11111111-1111-4111-8111-111111111111",
        timestamp: "2026-10-24T12:00:00Z",
        message: %{role: "user", content: "indexeruniquecatchup"}
      })

    File.write!(Path.join([tmp, "claude", "claude.jsonl"]), appended <> "\n", [:append])
    send(pid, :index)
    assert await_idle(pid).status.ok

    {:ok, output} =
      Shuttle.CLI.run(["transcript", "search", "indexeruniquecatchup", "--no-index", "--json"])

    assert [%{"harness" => "claude", "session" => "11111111-1111-4111-8111-111111111111"}] =
             Jason.decode!(output)["hits"]
  end

  test "supervisor restart kills in-flight work and schedules a new pass" do
    pid = start_indexer()
    {task, _} = command(pid)
    monitor = Process.monitor(task)
    Process.exit(pid, :kill)
    assert_receive {:DOWN, ^monitor, :process, ^task, :killed}

    # Synchronise with the test supervisor's restart, not a sleep.
    {:ok, supervisor} = ExUnit.fetch_test_supervisor()
    [{_, restarted, _, _}] = Supervisor.which_children(supervisor)
    refute restarted == pid
    assert Process.alive?(restarted)
    assert TranscriptIndexer.status(restarted).state == :scheduled
    {next, _} = command(restarted)
    complete(restarted, next, {@receipt, 0})
    assert TranscriptIndexer.status(restarted).ok
  end
end
