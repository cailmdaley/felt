defmodule Shuttle.MigrationTest do
  use ExUnit.Case, async: true
  import Shuttle.Test.PollerHelpers
  import Shuttle.Test.ApiConn
  import Phoenix.ConnTest
  alias Shuttle.Test.{Env, FeltStoreRunner, FiberUid}
  alias Shuttle.{Poller, FiberDoc, WorkerProcess}
  @endpoint ShuttleWeb.Endpoint

  defmodule Runner do
    def cmd(command, args, opts) do
      cond do
        command == "tmux" and is_binary(Shuttle.Env.app(:migration_tmux_socket)) ->
          socket = Shuttle.Env.app(:migration_tmux_socket)

          args =
            if hd(args) == "new-session", do: List.replace_at(args, -1, "sleep 300"), else: args

          Shuttle.Env.cmd("tmux", ["-L", socket | args], Keyword.delete(opts, :timeout_ms))

        command == "ps" and is_binary(Shuttle.Env.app(:migration_tmux_socket)) ->
          Shuttle.Env.cmd(command, args, Keyword.delete(opts, :timeout_ms))

        command == "tmux" and hd(args) == "rename-session" and
            Shuttle.Env.app(:migration_rename_failure, false) ->
          {"collision", 1}

        command == "tmux" and hd(args) == "display-message" ->
          {Shuttle.Env.app(:migration_pane_session, "") <> "\n", 0}

        command == "shuttle" and ("show" in args or "ls" in args) ->
          case FeltStoreRunner.cmd(command, args, opts) do
            {bytes, 0} ->
              result = Jason.decode!(bytes)

              fresh =
                if is_list(result),
                  do: Enum.map(result, &read_document/1),
                  else: read_document(result)

              {Jason.encode!(fresh), 0}

            error ->
              error
          end

        true ->
          FeltStoreRunner.cmd(command, args, opts)
      end
    end

    defp read_document(fiber) do
      case FiberDoc.read_path(fiber["path"]) do
        {:ok, _, _, fm, _} ->
          resolved = get_in(fiber, ["shuttle", "resolved"])
          fresh = Map.merge(Map.delete(fiber, "shuttle"), fm) |> Map.put("id", fiber["id"])

          if resolved && fm["shuttle"],
            do: put_in(fresh, ["shuttle", "resolved"], resolved),
            else: fresh

        _ ->
          fiber
      end
    end
  end

  setup do
    FeltStoreRunner.start!()
    root = FeltStoreRunner.felt_root()
    data = Path.join(root, "data")
    Env.put_env("SHUTTLE_DATA_DIR", data)
    Env.delete_env("SHUTTLE_SESSIONS_FILE")
    Env.put_app_env(:app_workers_dir, Path.join(data, "app-workers"))
    Env.put_env("SHUTTLE_STORES", root)
    on_exit(fn -> File.rm_rf(root) end)

    for id <- ["source", "dest"] do
      FeltStoreRunner.set_fiber(id, make_fiber(id))
      FeltStoreRunner.set_shuttle(id, "kind: oneshot\nagent: claude-sonnet\n", "open")
    end

    {:ok, poller} =
      start_poller!(
        runner: Runner,
        own_host_id: "test-host",
        felt_stores: [root],
        poll_interval_ms: 600_000,
        heartbeat_interval_ms: 600_000
      )

    await_boot_cycle!(poller)
    FeltStoreRunner.add_tmux_session("capture")

    assert {:ok, _} =
             Poller.claim_session(poller, "source", "capture",
               session_uuid: "native-session",
               agent: "claude-sonnet"
             )

    Env.put_app_env(:migration_pane_session, FiberUid.session("source"))
    %{poller: poller, root: root}
  end

  test "public migration rekeys runtime, watcher, ledger and mailbox ownership; retries and late events are inert",
       %{poller: poller} do
    old = Poller.worker_status(poller, "source")

    conn =
      api_conn()
      |> post(
        "/api/v1/migrate",
        Jason.encode!(%{from: "source", to: "dest", session_id: "", tmux_pane: "%1"})
      )

    assert conn.status == 200, conn.resp_body

    assert %{"ok" => true, "from" => "source", "to" => "dest", "session_uuid" => "native-session"} =
             Jason.decode!(conn.resp_body)

    assert Poller.worker_status(poller, "source") == nil
    moved = Poller.worker_status(poller, "dest")
    assert moved.session == FiberUid.session("dest")
    assert moved.pid == old.pid
    assert :sys.get_state(moved.pid).fiber_id == "dest"
    assert :sys.get_state(moved.pid).session == moved.session
    assert fm("source")["status"] == "active"
    refute get_in(fm("source"), ["shuttle", "runtime"])
    assert get_in(fm("dest"), ["shuttle", "runtime", "session_uuid"]) == "native-session"
    assert is_binary(get_in(fm("dest"), ["shuttle", "runtime", "dispatched_at"]))
    row = Shuttle.SessionLedger.latest_for_session("native-session")
    assert row["kind"] == "migrate"
    assert row["fiber"] == "dest"
    assert row["fiber_path"] == FeltStoreRunner.fiber("dest")["path"]
    assert row["tmux"] == moved.session

    assert {:ok, %{ok: true}} =
             Poller.migrate(poller, "source", "dest", session_id: "native-session")

    assert {:ok, %{ok: true}} =
             Poller.migrate(poller, "dest", "dest", session_id: "native-session")

    send(poller, {:worker_exited, "source", old.pid, old.session, :normal_exit})
    send(poller, {:dispatched_identity, "source", make_ref(), "stale-id"})
    assert Poller.session_uuid(poller, "dest") == "native-session"
    assert Poller.worker_status(poller, "source") == nil
    assert receiver(poller, "source") == {:error, :no_worker}
    assert {:ok, "shuttle://test-host/claude/native-session", _} = receiver(poller, "dest")
    Env.put_app_env(:migration_pane_session, moved.session)

    assert {:ok, %{ok: true}} =
             Poller.migrate(poller, "dest", "dest", session_id: "", tmux_pane: "%1")
  end

  for {flag, horizon} <- [{:rest, "stashed"}, {:disabled, nil}] do
    test "#{flag} leaves source open without session identity", %{poller: poller} do
      assert {:ok, _} = Poller.migrate(poller, "source", "dest", [{unquote(flag), true}])
      source = fm("source")
      assert source["status"] == "open"
      assert source["horizon"] == unquote(horizon)
      refute get_in(source, ["shuttle", "runtime"])
    end
  end

  test "validation refuses wrong identity, same fiber, foreign ownership and uninstalled destination without writes",
       %{poller: poller} do
    before = bytes()

    assert {:error, :identity_mismatch} =
             Poller.migrate(poller, "source", "dest", session_id: "wrong")

    assert {:error, :same_fiber} =
             Poller.migrate(poller, "source", "source", session_id: "native-session")

    assert {:error, :identity_mismatch} =
             Poller.migrate(poller, "source", "dest", tmux_pane: "%bad", session_id: "wrong")

    assert bytes() == before
    path = FeltStoreRunner.fiber("dest")["path"]
    {:ok, _, raw, _, body} = FiberDoc.read_path(path)
    FiberDoc.write!(path, raw, body, [{:put_nested, "shuttle", "host", "elsewhere"}])
    assert {:error, :other_host} = Poller.migrate(poller, "source", "dest", [])
    {:ok, _, raw, _, body} = FiberDoc.read_path(path)
    FiberDoc.write!(path, raw, body, [{:delete, "shuttle"}])
    assert {:error, :not_installed} = Poller.migrate(poller, "source", "dest", [])
  end

  test "rename failure leaves documents and running registry unchanged", %{poller: poller} do
    before = bytes()
    old = Poller.worker_status(poller, "source")
    Env.put_app_env(:migration_rename_failure, true)
    assert {:error, :rename_failed} = Poller.migrate(poller, "source", "dest", [])
    assert bytes() == before
    assert Poller.worker_status(poller, "source") == old
    assert Poller.worker_status(poller, "dest") == nil
  end

  test "stale concurrent world is invalidated and cannot dispatch between document writes", %{
    poller: poller
  } do
    token = make_ref()

    task =
      spawn(fn ->
        receive do
          :stop -> :ok
        end
      end)

    monitor = Process.monitor(task)

    :sys.replace_state(poller, fn state ->
      %{state | poll_check_in_progress: true, poll_token: token, poll_task_pid: task}
    end)

    test_pid = self()
    source_path = FeltStoreRunner.fiber("source")["path"]

    Env.put_app_env(:migration_document_writer, fn path, raw, body, ops ->
      FiberDoc.write!(path, raw, body, ops)

      if path == source_path do
        send(test_pid, {:between_writes, self()})

        receive do
          :continue_write -> :ok
        end
      end
    end)

    migration = Task.async(fn -> Poller.migrate(poller, "source", "dest", rest: true) end)
    assert_receive {:between_writes, writer}
    assert_receive {:DOWN, ^monitor, :process, ^task, _}
    refute get_in(fm("source"), ["shuttle", "runtime"])
    refute get_in(fm("dest"), ["shuttle", "runtime"])
    send(poller, {:poll_world, token, {:ok, %{invalid_stale_world: true}}})
    send(writer, :continue_write)
    assert {:ok, _} = Task.await(migration, 30_000)
    assert Poller.worker_status(poller, "source") == nil
    assert Poller.session_uuid(poller, "dest") == "native-session"
    refute :sys.get_state(poller).poll_check_in_progress
  end

  test "script-name fallback follows the moved worker without claiming a fresh source script" do
    old = FiberUid.session("source")
    new = FiberUid.session("dest")
    procs = [%{pid: 10, ppid: 2, args: "bash -l /tmp/shuttle-run-#{old}.123.sh"}]
    aliases = WorkerProcess.migration_aliases(procs, old, new)
    assert :ok = WorkerProcess.write_migration_aliases(aliases)
    assert WorkerProcess.sessions(procs) == [new]
    assert WorkerProcess.session_process(procs, old) == nil
    assert WorkerProcess.session_process(procs, new).pid == 10
    fresh = %{pid: 11, ppid: 2, args: "bash -l /tmp/shuttle-run-#{old}.456.sh"}
    assert WorkerProcess.session_process([fresh | procs], old).pid == 11
    assert :ok = WorkerProcess.restore_migration_aliases(aliases)
    assert WorkerProcess.sessions(procs) == [old]
  end

  @tag :integration
  test "real isolated tmux keeps the moved PID and starts a fresh source fixture", %{
    poller: poller
  } do
    assert System.find_executable("tmux"), "tmux is required for this integration probe"
    socket = "migrate-test-#{System.pid()}-#{System.unique_integer([:positive])}"
    Env.put_app_env(:migration_tmux_socket, socket)
    on_exit(fn -> System.cmd("tmux", ["-L", socket, "kill-server"], stderr_to_stdout: true) end)
    source = FiberUid.session("source")
    dest = FiberUid.session("dest")
    # No models, credentials or operator server. Keep a real immutable source-named script.
    script = WorkerProcess.script_path(source)
    File.write!(script, "#!/bin/sh\nsleep 300\n")
    on_exit(fn -> File.rm(script) end)

    assert {_, 0} =
             Shuttle.Env.cmd(
               "tmux",
               [
                 "-L",
                 socket,
                 "-f",
                 "/dev/null",
                 "new-session",
                 "-d",
                 "-s",
                 source,
                 "sh #{script}"
               ],
               stderr_to_stdout: true
             )

    {old_pid, 0} =
      Runner.cmd("tmux", ["display-message", "-p", "-t", source <> ":0.0", "\#{pane_pid}"], [])

    assert String.to_integer(String.trim(old_pid)) > 0

    {pane, 0} =
      Runner.cmd("tmux", ["display-message", "-p", "-t", source <> ":0.0", "\#{pane_id}"], [])

    assert String.starts_with?(String.trim(pane), "%")

    assert {:ok, _} = Poller.migrate(poller, "source", "dest", tmux_pane: String.trim(pane))

    assert {^old_pid, 0} =
             Runner.cmd(
               "tmux",
               ["display-message", "-p", "-t", dest <> ":0.0", "\#{pane_pid}"],
               []
             )

    assert {pane_name, 0} =
             Runner.cmd(
               "tmux",
               ["display-message", "-p", "-t", String.trim(pane), "\#{session_name}"],
               []
             )

    assert String.trim(pane_name) == dest
    assert Shuttle.SessionLedger.latest_for_session("native-session")["kind"] == "migrate"

    assert {:ok, _} =
             Poller.migrate(poller, "dest", "dest", session_id: "", tmux_pane: String.trim(pane))

    {:ok, procs} = WorkerProcess.scan(Runner)
    assert WorkerProcess.session_process(procs, source) == nil
    assert WorkerProcess.session_process(procs, dest) != nil
    # The real tmux launch is replaced with a sleeping fixture by this runner.
    assert {:ok, _} = Poller.dispatch_fiber(poller, "source", force: true)

    {fresh_pid, 0} =
      Runner.cmd("tmux", ["display-message", "-p", "-t", source <> ":0.0", "\#{pane_pid}"], [])

    assert fresh_pid != old_pid
    assert Poller.session_uuid(poller, "source") != "native-session"
    assert Poller.session_uuid(poller, "dest") == "native-session"

    assert {^old_pid, 0} =
             Runner.cmd(
               "tmux",
               ["display-message", "-p", "-t", dest <> ":0.0", "\#{pane_pid}"],
               []
             )
  end

  test "failed second document write restores both files, rename and source receiver", %{
    poller: poller
  } do
    before = bytes()
    dest_path = FeltStoreRunner.fiber("dest")["path"]

    Env.put_app_env(:migration_document_writer, fn path, raw, body, ops ->
      if path == dest_path, do: raise("fixture write failure")
      FiberDoc.write!(path, raw, body, ops)
    end)

    assert {:error, {:migration_failed, _}} = Poller.migrate(poller, "source", "dest", [])
    assert bytes() == before
    assert Poller.worker_status(poller, "source").session == FiberUid.session("source")
    assert Poller.worker_status(poller, "dest") == nil
    assert {:ok, "shuttle://test-host/claude/native-session", _} = receiver(poller, "source")

    assert FeltStoreRunner.cmd(
             "tmux",
             ["has-session", "-t", "=" <> FiberUid.session("source")],
             []
           ) == {"", 0}
  end

  test "restart adopts destination with same native UUID and source dispatches fresh", %{
    poller: poller,
    root: root
  } do
    assert {:ok, _} = Poller.migrate(poller, "source", "dest", [])
    GenServer.stop(poller)

    {:ok, restarted} =
      start_poller!(
        runner: Runner,
        own_host_id: "test-host",
        felt_stores: [root],
        poll_interval_ms: 600_000,
        heartbeat_interval_ms: 600_000
      )

    await_boot_cycle!(restarted)
    assert Poller.session_uuid(restarted, "dest") == "native-session"
    source = Poller.worker_status(restarted, "source")
    assert source != nil
    assert source.session == FiberUid.session("source")
    refute source[:session_uuid] == "native-session"

    source_launches =
      Enum.filter(FeltStoreRunner.commands(), fn {cmd, args} ->
        cmd == "tmux" and hd(args) == "new-session"
      end)

    assert source_launches != []
    # The continuation decision is made from the source's cleared runtime.
    assert get_in(FeltStoreRunner.fiber("source"), ["shuttle", "runtime", "session_uuid"]) !=
             "native-session"
  end

  test "ledger failure rolls back files, backend, watcher and receiver before returning an error",
       %{poller: poller, root: root} do
    before = bytes()
    old = Poller.worker_status(poller, "source")
    ledger_dir = Path.join(root, "unwritable-ledger")
    File.mkdir_p!(ledger_dir)
    Env.put_env("SHUTTLE_SESSIONS_FILE", ledger_dir)

    assert {:error, {:migration_failed, {:error, {:ledger_write_failed, _}}}} =
             Poller.migrate(poller, "source", "dest", [])

    assert bytes() == before
    assert Poller.worker_status(poller, "source").session == old.session
    assert :sys.get_state(old.pid).fiber_id == "source"
    assert :sys.get_state(old.pid).session == old.session
    assert receiver(poller, "dest") == {:error, :no_worker}
    assert {:ok, "shuttle://test-host/claude/native-session", _} = receiver(poller, "source")
  end

  test "owned Codex migration rekeys durable record without changing the thread or endpoint", %{
    poller: poller,
    root: root
  } do
    old = Poller.worker_status(poller, "source")

    record = %{
      "session_uuid" => "native-session",
      "thread_id" => "native-session",
      "active" => true,
      "fiber_id" => "source",
      "uid" => FiberUid.for("source"),
      "felt_store" => root,
      "backend_host" => "test-host",
      "backend_endpoint" => Shuttle.CodexApp.Transport.default_socket(),
      "surface" => "app"
    }

    assert :ok = Shuttle.AppWorkers.put(record)
    ref = Shuttle.AppWorkers.ref("native-session")

    :sys.replace_state(poller, fn state ->
      key = Poller.running_key(state, "source")
      %{state | running: Map.put(state.running, key, %{old | session: ref})}
    end)

    assert {:ok, _} =
             Poller.migrate(poller, "source", "dest",
               session_id: "native-session",
               tmux_pane: "%unrelated",
               rest: true
             )

    assert {:ok, moved} = Shuttle.AppWorkers.get("native-session")
    assert moved["fiber_id"] == "dest"
    assert moved["uid"] == FiberUid.for("dest")
    assert moved["felt_store"] == root
    assert moved["thread_id"] == record["thread_id"]
    assert moved["backend_endpoint"] == record["backend_endpoint"]
    assert Shuttle.AppWorkers.for_fiber("source", FiberUid.for("source")) == nil
    assert Shuttle.AppWorkers.for_fiber("dest", FiberUid.for("dest")) == moved
    assert Poller.worker_status(poller, "dest").session == ref
    assert :sys.get_state(old.pid).session == ref
  end

  test "live destination and unknown native identity are refused before writes", %{poller: poller} do
    FeltStoreRunner.add_tmux_session("second-capture")

    assert {:ok, _} =
             Poller.claim_session(poller, "dest", "second-capture", session_uuid: "other-session")

    before = bytes()
    assert {:error, :already_running} = Poller.migrate(poller, "source", "dest", [])
    assert bytes() == before

    :sys.replace_state(poller, fn state ->
      source = Poller.running_key(state, "source")
      dest = Poller.running_key(state, "dest")

      %{
        state
        | running:
            state.running
            |> Map.delete(dest)
            |> Map.update!(source, &Map.put(&1, :session_uuid, nil))
      }
    end)

    FeltStoreRunner.remove_tmux_session(FiberUid.session("dest"))
    assert {:error, :surface_unsupported} = Poller.migrate(poller, "source", "dest", [])
    assert bytes() == before
  end

  defp fm(id) do
    {:ok, _, _, fm, _} = FiberDoc.read_path(FeltStoreRunner.fiber(id)["path"])
    fm
  end

  defp bytes, do: for(id <- ["source", "dest"], do: File.read!(FeltStoreRunner.fiber(id)["path"]))
  defp receiver(poller, fiber), do: GenServer.call(poller, {:context_receiver, fiber})
end
