defmodule Shuttle.Terminal.CodexRexRealTest do
  use ExUnit.Case, async: true

  alias Shuttle.{Dispatcher, Poller, Rex, Terminal, WorkerProcess}
  alias Shuttle.Terminal.Rex, as: Backend
  alias Shuttle.Test.{Env, FeltStoreRunner, FiberUid, IsolatedRex}
  import Shuttle.Test.PollerHelpers
  @moduletag :integration
  @moduletag :tmp_dir
  @moduletag timeout: 180_000
  @moduletag skip:
               IsolatedRex.skip?(["codex"]) or
                 is_nil(Shuttle.Env.get("SHUTTLE_TEST_CODEX_AUTH"))

  defmodule Runner do
    def cmd("tmux", _args, _opts), do: {"no private tmux workers", 1}

    def cmd(command, args, opts) when command in ["shuttle", "felt"] do
      if command == "shuttle" and "mark-runtime" in args do
        case Shuttle.Runner.Default.cmd(command, args, opts) do
          {_, 0} -> FeltStoreRunner.cmd(command, args, opts)
          error -> error
        end
      else
        FeltStoreRunner.cmd(command, args, opts)
      end
    end

    def cmd(command, args, opts), do: Shuttle.Runner.Default.cmd(command, args, opts)
  end

  test "late native Codex startup binds after adoption and restart, and accepts terminal input",
       %{
         tmp_dir: dir
       } do
    auth = Shuttle.Env.get("SHUTTLE_TEST_CODEX_AUTH")
    codex = Shuttle.Env.find_executable("codex")
    Env.put_env("SHUTTLE_REX_BIN", Rex.bin())
    private_home = Path.join(dir, "home")
    File.mkdir_p!(private_home)
    Env.put_env("HOME", private_home)
    home = Path.join(dir, "codex")
    File.mkdir_p!(home)
    File.cp!(auth, Path.join(home, "auth.json"))
    File.chmod!(Path.join(home, "auth.json"), 0o600)
    File.write!(Path.join(home, "config.toml"), "model = \"gpt-6.1-sol\"\n")

    hook = %{
      "type" => "command",
      "command" => quote_sh(Shuttle.Env.find_executable("shuttle")) <> " hook event"
    }

    File.write!(
      Path.join(home, "hooks.json"),
      Jason.encode!(%{
        "hooks" => Map.new(~w(SessionStart UserPromptSubmit Stop), &{&1, [%{"hooks" => [hook]}]})
      })
    )

    Env.put_env("CODEX_HOME", home)
    Env.put_env("SHUTTLE_CODEX_SESSIONS_DIR", Path.join(home, "sessions"))
    Env.put_env("SHUTTLE_HOST", "test-host")

    for key <-
          ~w(AI_AGENT PI_SESSION_ID CLAUDE_CODE_SESSION_ID CLAUDE_SESSION_ID CODEX_THREAD_ID SHUTTLE_FIBER_PATH),
        do: Env.delete_env(key)

    Env.put_env("SHUTTLE_SESSIONS_FILE", Path.join(dir, "sessions.jsonl"))
    Env.put_app_env(:terminal_backend, Backend)
    Env.put_app_env(:terminal_runner, Runner)
    Env.put_app_env(:session_capture_timeout_ms, 100)
    Env.put_app_env(:session_capture_poll_ms, 10)
    Env.put_app_env(:session_capture_retry_ms, 500)
    rex_root = IsolatedRex.start(dir)
    work = Path.join(rex_root, "work")
    File.mkdir_p!(work)
    {physical_work, 0} = System.cmd("pwd", ["-P"], cd: work)
    work = String.trim(physical_work)
    Env.put_env("TMUX_TMPDIR", rex_root)

    FeltStoreRunner.start!()
    store = FeltStoreRunner.felt_root()
    on_exit(fn -> File.rm_rf(store) end)
    id = "tests/codex-rex"
    name = FiberUid.session(id)
    boundary = DateTime.utc_now() |> DateTime.add(-90 * 60, :second) |> DateTime.to_iso8601()
    FeltStoreRunner.set_fiber(id, make_fiber(id))

    FeltStoreRunner.set_shuttle(
      id,
      "kind: oneshot\nagent: codex\nproject_dir: #{work}\nruntime:\n  dispatched_at: #{boundary}\n"
    )

    gate = Path.join(dir, "start.fifo")
    {_, 0} = System.cmd("mkfifo", [gate])
    prompt = "Reply exactly READY. Do not use tools.\nFiber: #{id}"

    command =
      "read -r _ < #{quote_sh(gate)}\n" <>
        "SHUTTLE_EVENTS_FILE=#{quote_sh(Path.join(dir, "events.jsonl"))} CODEX_HOME=#{quote_sh(home)} #{quote_sh(codex)} " <>
        "-c #{quote_sh("projects.#{inspect(work)}.trust_level=\"trusted\"")} " <>
        "#{quote_sh(prompt)}"

    script = WorkerProcess.script_path(name)

    File.write!(
      script,
      Dispatcher.build_run_script(id, command, "codex-sol",
        terminal: Backend,
        session: name,
        headless: true
      )
    )

    rex = Rex.bin()
    endpoint = Rex.server()

    on_exit(fn ->
      File.rm(script)

      System.cmd(rex, ["--autostart=false", "-S", endpoint, "server", "stop"],
        stderr_to_stdout: true
      )

      # The temporary CODEX_HOME owns this daemon, independent of the operator's.
      System.cmd(codex, ["app-server", "daemon", "stop"],
        env: [{"CODEX_HOME", home}],
        stderr_to_stdout: true
      )

      File.rm_rf!(home)
    end)

    assert :ok = Backend.launch(Runner, name, work, script, [])

    opts = [
      runner: Runner,
      own_host_id: "test-host",
      felt_stores: [store],
      poll_interval_ms: 600_000
    ]

    {:ok, first} = start_poller!(opts)
    await_boot_cycle!(first)

    IsolatedRex.await(fn ->
      Enum.any?(:sys.get_state(first).running, fn {_, worker} ->
        String.contains?(worker[:identity_error] || "", "timed out")
      end)
    end)

    GenServer.stop(first)
    {:ok, poller} = start_poller!(opts)
    await_boot_cycle!(poller)
    Env.put_server(Poller, poller)
    assert :ok = File.write(gate, "start\n")

    assert {:ok, %{"session_id" => sid, "block_id" => bid}} = Backend.identity(Runner, name)

    IsolatedRex.await(
      fn ->
        case Rex.command(Runner, ["capture", "--trim", "-s", sid, "-b", bid]) do
          {:ok, text} -> String.contains?(text, "Trust all and continue")
          _ -> false
        end
      end,
      600
    )

    assert {:ok, _} = Rex.send_key(Runner, sid, bid, "down")
    assert {:ok, _} = Rex.send_key(Runner, sid, bid, "enter")

    await_identity(poller, id, 1_200)
    uuid = Poller.session_uuid(poller, id)
    assert is_binary(uuid)

    assert Enum.any?(File.stream!(Path.join(dir, "events.jsonl")), fn line ->
             event = Jason.decode!(line)

             event["sessionId"] == uuid and event["type"] == "session_start" and
               event["harness"] == "codex" and event["tmuxSession"] == name
           end)

    assert get_in(FeltStoreRunner.fiber(id), ["shuttle", "runtime", "session_uuid"]) == uuid
    assert File.read!(FeltStoreRunner.fiber(id)["path"]) =~ uuid
    assert get_in(FeltStoreRunner.fiber(id), ["shuttle", "runtime", "dispatched_at"]) == boundary

    assert %{"fiber" => ^id, "tmux" => ^name, "harness" => "codex"} =
             Shuttle.SessionLedger.latest_for_session(uuid)

    Env.put_app_env(:felt_runner, Shuttle.Runner.Default)
    Env.put_env("SHUTTLE_STORES", store)

    server =
      start_supervised!(
        {Bandit, plug: ShuttleWeb.Endpoint, ip: {127, 0, 0, 1}, port: 0, startup_log: false}
      )

    {:ok, {_, port}} = ThousandIsland.listener_info(server)
    Env.put_env("SHUTTLE_DAEMON_URL", "http://127.0.0.1:#{port}")

    for target <- ["shuttle://test-host/codex/#{uuid}", id] do
      {receipt, status} =
        Shuttle.Runner.Default.cmd(
          "shuttle",
          ["-C", store, "message", target, "Reply exactly RECEIVED. Do not use tools.", "--json"],
          stderr_to_stdout: true
        )

      assert status == 0, receipt
      assert receipt =~ ~r/"status"\s*:\s*"submitted"/
    end

    assert {:ok, %{"session_id" => sid, "block_id" => bid}} =
             Backend.identity(Shuttle.Runner.Default, name)

    assert {:ok, _} = Rex.process(Shuttle.Runner.Default, sid, bid)
    assert {"", 0} = Terminal.stop(Shuttle.Runner.Default, name, backends: [Backend])
  end

  defp await_identity(poller, id, attempts) do
    cond do
      Poller.session_uuid(poller, id) != nil ->
        :ok

      attempts == 0 ->
        flunk("native Codex rollout was not bound: #{inspect(Poller.worker_status(poller, id))}")

      true ->
        Process.sleep(50)
        await_identity(poller, id, attempts - 1)
    end
  end

  defp quote_sh(value), do: "'" <> String.replace(value, "'", "'\\''") <> "'"
end
