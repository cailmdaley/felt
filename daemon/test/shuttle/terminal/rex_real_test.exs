defmodule Shuttle.Terminal.RexRealTest do
  # Real Rex: launch, binding, restore and stop of one worker.
  use Shuttle.Test.RexRealCase, async: true

  @tag skip: not Shuttle.Test.IsolatedRex.restore_supported?()
  test "poll listing starts the default endpoint and preserves the server across ticks", %{
    root: root
  } do
    Env.put_app_env(:os_type, {:unix, :linux})
    Env.put_app_env(:tailscale_socket, Path.join(root, "absent-tailscaled.sock"))
    Env.delete_app_env(:rex_server)
    Env.delete_env("SHUTTLE_REX_SERVER")
    Env.put_env("SHUTTLE_DATA_DIR", root)
    endpoint = Rex.server()
    assert endpoint == "unix://" <> Path.join(root, "rex/server.sock")
    executable = Rex.bin()

    on_exit(fn ->
      # This server and its state belong only to this test.
      System.cmd(executable, ["--autostart=false", "-S", endpoint, "server", "stop"],
        stderr_to_stdout: true
      )
    end)

    assert ExUnit.CaptureLog.capture_log(fn -> assert {:ok, []} = Backend.list(@runner) end) =~
             "local-only"

    assert {:ok, %{"instance_id" => instance}} = Rex.call(@runner, "server.status", %{})
    assert {:ok, []} = Backend.list(@runner)
    assert {:ok, %{"instance_id" => ^instance}} = Rex.call(@runner, "server.status", %{})
  end

  @tag skip: Shuttle.Test.IsolatedRex.skip?() or :os.type() != {:unix, :linux}
  @tag :linux
  test "a live worker receipt answers watcher probes without Rex CLI calls", %{root: root} do
    name = "receipt-01JABCDEFGHJKMNPQRSTVWXYZ-shuttle"
    Env.put_app_env(:terminal_backend, Backend)
    assert :ok = Terminal.launch(@runner, name, root, Backend.script(name).env <> "sleep 300\n")
    {:ok, binding} = RexBindings.read()
    bid = binding["bindings"][name]["block_id"]
    await(fn -> File.exists?(RexBindings.pid_path(bid)) end)

    assert :present = Backend.probe(RexMustNotRun, name)
    assert :present = Backend.probe(RexMustNotRun, name)
  end

  @tag skip: not Shuttle.Test.IsolatedRex.restore_supported?()
  test "restored windows from a restarted server are not adopted as workers", %{root: root} do
    name = "restore-01JABCDEFGHJKMNPQRSTVWXYZ-shuttle"
    script = Path.join(root, "worker.sh")
    File.write!(script, "sleep 300\n")
    assert :ok = Backend.launch(@runner, name, root, script, [])
    assert {:ok, before} = RexBindings.read()
    assert :present = Backend.probe(@runner, name)
    endpoint = "unix://#{root}/rex.sock"
    executable = Rex.bin()

    assert {_, 0} =
             System.cmd(executable, ["--autostart=false", "-S", endpoint, "server", "stop"],
               stderr_to_stdout: true
             )

    port =
      Port.open({:spawn_executable, executable}, [
        :binary,
        :exit_status,
        :stderr_to_stdout,
        args: [
          "server",
          "run",
          "--listen",
          endpoint,
          "--state-dir",
          "#{root}/state"
        ]
      ])

    {:os_pid, pid} = Port.info(port, :os_pid)
    on_exit(fn -> System.cmd("kill", ["-TERM", to_string(pid)], stderr_to_stdout: true) end)
    await(fn -> match?({:ok, _}, Rex.whoami(@runner)) end)
    assert {:ok, %{"instance_id" => instance}} = Rex.whoami(@runner)
    refute instance == before["instance"]
    assert {:ok, blocks} = Rex.blocks(@runner, before["bindings"][name]["session_id"])
    assert Enum.any?(blocks, &(&1["block_id"] == before["bindings"][name]["block_id"]))
    assert {:ok, []} = Backend.list(@runner)
    assert :absent = Backend.probe(@runner, name)
    assert :ok = Backend.launch(@runner, name, root, script, [])
    assert :present = Backend.probe(@runner, name)
  end

  test "isolated launch, immutable binding, environment, bracketed paste, native rename and stop",
       %{root: root} do
    name = "probe-r3-#{System.unique_integer([:positive])}-shuttle"
    path = WorkerProcess.script_path(name)
    receipt = Path.join(root, "env")
    pidfile = Path.join(root, "pid")
    input = Path.join(root, "input")
    snippets = Backend.script(name)
    intended_path = Shuttle.Env.get("PATH")
    intended_sock = Shuttle.Env.get("SSH_AUTH_SOCK", "")

    script =
      snippets.env <>
        "printf '%s\\n' \"$SHUTTLE_HOST\" \"$PATH\" \"$SSH_AUTH_SOCK\" \"${TMUX-unset}\" \"${TMUX_PANE-unset}\" > '#{receipt}'\necho $$ > '#{pidfile}'\nstty raw -echo\nprintf '\\033[?2004h'\n/bin/cat -u > '#{input}'\n"

    File.write!(path, script)
    on_exit(fn -> File.rm(path) end)
    assert :ok = Backend.launch(@runner, name, root, path, [])
    await(fn -> File.exists?(receipt) and File.exists?(pidfile) end)

    assert File.read!(receipt) ==
             Enum.join(
               ["probe-isolated-sentinel", intended_path, intended_sock, "unset", "unset", ""],
               "\n"
             )

    assert :present = Backend.probe(@runner, name)
    assert {:ok, names} = Backend.list(@runner)
    assert name in names

    assert {:ok, %{"session_id" => sid, "block_id" => bid, "child_pid" => pid}} =
             Backend.identity(@runner, name)

    assert pid == File.read!(pidfile) |> String.trim() |> String.to_integer()
    assert {:ok, process} = Rex.process(@runner, sid, bid)
    refute pid == process["child"]["pid"]

    await(fn ->
      case Rex.call(
             @runner,
             "com.superlogical.terminal.modes",
             %{"block_id" => bid, "args" => %{}},
             session: sid
           ) do
        {:ok, %{"modes" => modes}} ->
          Enum.any?(modes, &(&1["name"] == "bracketed_paste" and &1["set"] == true))

        _ ->
          false
      end
    end)

    assert :ok = Backend.paste(@runner, name, "first\nsecond")
    await(fn -> File.read(input) == {:ok, "\e[200~first\nsecond\e[201~\r"} end)
    # Labels can drift without losing the authoritative address.
    assert {:ok, _} =
             Rex.call(@runner, "session.set_label", %{"label" => "probe-human"}, session: sid)

    assert :present = Backend.probe(@runner, name)
    assert :ok = Backend.rename(@runner, sid, name)
    assert :ok = Backend.rename(@runner, sid, name)
    assert Backend.owns_pane?(@runner, name, bid)
    assert {"", 0} = Terminal.stop(@runner, name, backends: [Backend])
    assert :absent = Backend.probe(@runner, name)
    assert {:ok, []} = Rex.sessions(@runner)
    assert {:ok, %{"bindings" => bindings}} = RexBindings.read()
    assert bindings == %{}
  end
end

defmodule Shuttle.Terminal.RexPrerequisitesTest do
  use ExUnit.Case, async: true
  @moduletag :rex_prerequisites
  alias Shuttle.Test.{Env, IsolatedRex}

  for rex_present <- [false, true], extra_present <- [false, true] do
    test "Rex present=#{rex_present}, additional executable present=#{extra_present}" do
      Env.put_env(
        "SHUTTLE_REX_BIN",
        if(unquote(rex_present), do: "/bin/sh", else: "/no-such-rex-test-binary")
      )

      extra = if unquote(extra_present), do: "/bin/sh", else: "/no-such-rex-test-extra"
      assert IsolatedRex.skip?([extra]) == not (unquote(rex_present) and unquote(extra_present))
      assert IsolatedRex.skip?() == not unquote(rex_present)
    end
  end

  test "effective real-test tags never enable setup without Rex" do
    if IsolatedRex.skip?() do
      tests =
        Enum.flat_map(
          [
            Shuttle.Terminal.RexRealTest,
            Shuttle.Terminal.RexRealFamilyTest,
            Shuttle.Terminal.RexRealViewerTest,
            Shuttle.Terminal.RexRealClaimTest
          ],
          & &1.__ex_unit__().tests
        )

      assert length(tests) >= 16

      for test <- tests do
        assert test.tags[:skip] == true, "#{test.name} enables setup without Rex"
      end
    end
  end
end
