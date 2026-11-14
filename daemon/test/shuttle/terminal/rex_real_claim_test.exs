defmodule Shuttle.Terminal.RexRealClaimTest do
  # Real Rex: native-session claims and empty sessions.
  use Shuttle.Test.RexRealCase, async: true

  for interrupted <- [false, true] do
    test "native Rex capture claims retain their immutable script assignment (interrupted=#{interrupted})",
         %{root: root} do
      alias Shuttle.Test.{FeltStoreRunner, FiberUid}
      FeltStoreRunner.start!()
      store = FeltStoreRunner.felt_root()
      on_exit(fn -> File.rm_rf(store) end)
      Env.put_env("SHUTTLE_STORES", store)
      Env.put_app_env(:terminal_backend, Backend)
      FeltStoreRunner.set_fiber("native-capture", make_fiber("native-capture"))
      FeltStoreRunner.set_shuttle("native-capture", "kind: oneshot\nhost: test-host\n", "open")

      {:ok, p} =
        start_poller!(runner: ClaimRunner, own_host_id: "test-host", felt_stores: [store])

      await_boot_cycle!(p)
      source = FiberUid.name("capture-native")

      assert :ok =
               Terminal.launch(ClaimRunner, source, root, "trap 'rm -f \"$0\"' EXIT\nsleep 300\n",
                 preflighted: true
               )

      assert {:ok, %{"bindings" => %{^source => binding}}} = RexBindings.read()
      assert {:ok, %{"script" => script}} = Terminal.LaunchAttempts.get(source)

      await(fn ->
        {:ok, procs} = WorkerProcess.scan(@runner)
        WorkerProcess.script_process(procs, script) != nil
      end)

      canonical = FiberUid.session("native-capture")

      if unquote(interrupted) do
        assert catch_throw(
                 (fn ->
                    aliases = WorkerProcess.claim_aliases(ClaimRunner, source, canonical)
                    :ok = WorkerProcess.write_migration_aliases(aliases)
                    throw(:crashed_before_rename)
                  end).()
               ) == :crashed_before_rename
      end

      assert {:ok, %{session: ^canonical}} =
               Shuttle.Poller.claim_session(p, "native-capture", binding["session_id"],
                 tmux_pane: binding["block_id"]
               )

      assert {:ok, procs} = WorkerProcess.scan(@runner)
      assert WorkerProcess.session_process(procs, canonical)
      assert canonical in WorkerProcess.sessions(procs)
      assert {"", 0} = Terminal.stop(@runner, canonical, backends: [Backend])
    end
  end

  test "a human-labelled native session is claimed canonically and a retry keeps its watcher", %{
    root: root
  } do
    alias Shuttle.Test.{FeltStoreRunner, FiberUid}
    FeltStoreRunner.start!()
    store = FeltStoreRunner.felt_root()
    on_exit(fn -> File.rm_rf(store) end)
    Env.put_env("SHUTTLE_STORES", store)
    Env.delete_env("SHUTTLE_SESSIONS_FILE")
    Env.put_app_env(:terminal_backend, Backend)
    FeltStoreRunner.set_fiber("claimed", make_fiber("claimed"))
    FeltStoreRunner.set_shuttle("claimed", "kind: oneshot\nagent: claude-sonnet\n", "open")

    {:ok, p} =
      start_poller!(
        runner: ClaimRunner,
        own_host_id: "test-host",
        felt_stores: [store],
        poll_interval_ms: 600_000,
        heartbeat_interval_ms: 600_000
      )

    await_boot_cycle!(p)
    path = Path.join(root, "human.sh")
    File.write!(path, "sleep 60\n")

    assert {:ok, %{"session_id" => sid}} =
             Rex.create(@runner, Backend.create_spec("probe-human", root, path))

    canonical = FiberUid.session("claimed")

    assert {:ok, %{session: ^canonical}} =
             Shuttle.Poller.claim_session(p, "claimed", sid, session_uuid: "human-native-uuid")

    worker = Shuttle.Poller.worker_status(p, "claimed")
    assert {:ok, [%{"session_id" => ^sid, "label" => "claimed"}]} = Rex.sessions(@runner)
    assert {:ok, [%{"label" => "claimed"}]} = Rex.windows(@runner, sid)
    assert {:ok, %{"bindings" => %{^canonical => %{"session_id" => ^sid}}}} = RexBindings.read()

    assert {:ok, %{session: ^canonical}} =
             Shuttle.Poller.claim_session(p, "claimed", sid, session_uuid: "human-native-uuid")

    assert Shuttle.Poller.worker_status(p, "claimed").pid == worker.pid
    assert {"", 0} = Terminal.stop(@runner, canonical, backends: [Backend])
    assert {:ok, [%{"session_id" => ^sid}]} = Rex.sessions(@runner)
    assert {:ok, []} = Rex.windows(@runner, sid)
  end

  # The human's shell outlives the harness it ran: the block stays, so only
  # the claim's process receipt can end the worker, and the block is given
  # back to the human rather than closed.
  test "a claimed block whose harness is killed ends its worker and stays open, released", %{
    root: root
  } do
    alias Shuttle.Test.{FeltStoreRunner, FiberUid}
    FeltStoreRunner.start!()
    store = FeltStoreRunner.felt_root()
    on_exit(fn -> File.rm_rf(store) end)
    Env.put_env("SHUTTLE_STORES", store)
    Env.delete_env("SHUTTLE_SESSIONS_FILE")
    Env.put_app_env(:terminal_backend, Backend)
    FeltStoreRunner.set_fiber("released", make_fiber("released"))
    FeltStoreRunner.set_shuttle("released", "kind: oneshot\nagent: claude-sonnet\n", "open")

    {:ok, p} =
      start_poller!(
        runner: ClaimRunner,
        own_host_id: "test-host",
        felt_stores: [store],
        poll_interval_ms: 600_000,
        heartbeat_interval_ms: 50
      )

    await_boot_cycle!(p)
    pid_file = Path.join(root, "harness.pid")
    path = Path.join(root, "human.sh")
    File.write!(path, "sleep 300 &\necho $! > #{pid_file}\nwait\nsleep 300\n")

    assert {:ok, %{"session_id" => sid}} =
             Rex.create(@runner, Backend.create_spec("probe-human", root, path))

    await(fn -> File.exists?(pid_file) and File.read!(pid_file) =~ ~r/^\d+\n$/ end)
    harness = pid_file |> File.read!() |> String.trim() |> String.to_integer()
    canonical = FiberUid.session("released")

    assert {:ok, %{session: ^canonical}} =
             Shuttle.Poller.claim_session(p, "released", sid,
               session_uuid: "released-uuid",
               harness_pid: harness
             )

    assert Terminal.status(@runner, canonical, backends: [Backend]) == :alive
    assert Shuttle.Poller.worker_status(p, "released")

    {_, 0} = System.cmd("kill", ["-KILL", Integer.to_string(harness)])
    await(fn -> Shuttle.Poller.worker_status(p, "released") == nil end)

    assert {:ok, [%{"session_id" => ^sid}]} = Rex.sessions(@runner)
    assert {:ok, [%{"label" => "released"} | _]} = Rex.blocks(@runner, sid)
    assert {:ok, %{"bindings" => bindings}} = RexBindings.read()
    refute Map.has_key?(bindings, canonical)
    assert :absent = Backend.probe(@runner, canonical)
  end

  test "an exited auto-closing block leaves an empty session which the backend removes", %{
    root: root
  } do
    name = Shuttle.Test.FiberUid.name("probe-exit") <> "-shuttle"
    path = WorkerProcess.script_path(name)
    File.write!(path, "exit 0\n")
    on_exit(fn -> File.rm(path) end)
    assert :ok = Backend.launch(@runner, name, root, path, [])
    assert {:ok, %{"bindings" => %{^name => b}}} = RexBindings.read()
    await(fn -> Rex.blocks(@runner, b["session_id"]) == {:ok, []} end)
    assert :absent = Backend.probe(@runner, name)
    assert {:ok, []} = Rex.sessions(@runner)
  end

  test "an empty worker session is preserved after its binding is lost", %{root: root} do
    name = Shuttle.Test.FiberUid.name("probe-lost") <> "-shuttle"
    path = WorkerProcess.script_path(name)
    File.write!(path, "exit 0\n")
    on_exit(fn -> File.rm(path) end)
    assert :ok = Backend.launch(@runner, name, root, path, [])
    assert {:ok, %{"bindings" => %{^name => b}}} = RexBindings.read()
    assert :ok = RexBindings.delete(name, b)
    await(fn -> Rex.blocks(@runner, b["session_id"]) == {:ok, []} end)
    assert :absent = Backend.probe(@runner, name)
    assert {:ok, [%{"session_id" => sid}]} = Rex.sessions(@runner)
    assert sid == b["session_id"]
  end
end
