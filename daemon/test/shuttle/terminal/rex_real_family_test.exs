defmodule Shuttle.Terminal.RexRealFamilyTest do
  # Real Rex: family sessions, crash recovery and display.
  use Shuttle.Test.RexRealCase, async: true

  test "two real workers with no live root share one family session and stopping both removes it",
       %{root: root} do
    Env.put_app_env(:terminal_backend, Backend)

    Shuttle.Test.RexFamilyStore.write(root, [
      "work/design/family",
      "work/design/family/a",
      "work/design/family/b"
    ])

    suffix = Base.encode16(:crypto.strong_rand_bytes(4), case: :lower)
    a = "probe-family-#{suffix}-a"
    b = "probe-family-#{suffix}-b"
    names = [b, a]
    on_exit(fn -> Enum.each(names, &File.rm(WorkerProcess.script_path(&1))) end)

    for {name, leaf} <- Enum.zip(names, ["b", "a"]) do
      assert :ok =
               Terminal.launch(@runner, name, root, "sleep 60\n",
                 fiber: "work/design/family/" <> leaf
               )
    end

    assert {:ok, [%{"session_id" => sid, "label" => "design/family"}]} = Rex.sessions(@runner)
    assert {:ok, [%{"label" => "└ a"}, %{"label" => "└ b"}]} = Rex.windows(@runner, sid)
    assert {:ok, doc} = RexBindings.read()
    assert doc["bindings"][a]["session_id"] == sid
    assert doc["bindings"][b]["session_id"] == sid
    assert {:ok, blocks} = Rex.blocks(@runner, sid)
    assert Enum.sort(Enum.map(blocks, & &1["label"])) == Enum.sort(names)
    assert {"", 0} = Terminal.stop(@runner, a, backends: [Backend])
    assert :present = Backend.probe(@runner, b)
    assert {:ok, [%{"label" => "└ b"}]} = Rex.windows(@runner, sid)
    assert {"", 0} = Terminal.stop(@runner, b, backends: [Backend])
    assert {:ok, []} = Rex.sessions(@runner)
  end

  for operation <- ["session.create", "session.new_window"] do
    test "a crash after real Rex #{operation} preserves provable native ownership", %{root: root} do
      Env.put_app_env(:terminal_backend, Backend)
      family = "work/crash-family"
      Shuttle.Test.RexFamilyStore.write(root, [family, family <> "/a", family <> "/b"])

      if unquote(operation) == "session.new_window" do
        assert :ok =
                 Terminal.launch(
                   @runner,
                   "crash-sibling-a",
                   root,
                   Backend.script("crash-sibling-a").env <> "sleep 300\n",
                   fiber: family <> "/a"
                 )
      end

      name = "crash-binding-b"
      Env.put_app_env(:rex_crash_operation, unquote(operation))

      assert catch_throw(
               Terminal.launch(
                 CrashAfterCreateRunner,
                 name,
                 root,
                 Backend.script(name).env <> "sleep 300\n",
                 fiber: family <> "/b"
               )
             ) == :rex_launch_crash

      assert {:ok, %{"rex" => intent, "script" => reserved_script}} =
               Terminal.LaunchAttempts.get(name)

      assert is_binary(intent["instance"]), inspect(intent)
      await(fn -> match?({:ok, _}, Backend.identity(@runner, name)) end)
      assert {:ok, procs} = WorkerProcess.scan(@runner)
      assert {:ok, %{"child_pid" => script_pid}} = Backend.identity(@runner, name)

      assert %{pid: ^script_pid} =
               WorkerProcess.script_process(
                 Enum.filter(procs, &(&1.pid == script_pid)),
                 reserved_script
               )

      assert {:ok, identity} = Rex.whoami(@runner)
      assert identity["instance_id"] == intent["instance"]
      assert {:ok, doc} = RexBindings.read()
      assert doc["instance"] in [nil, intent["instance"]], inspect({doc, intent})
      assert doc["server"] in [nil, intent["server"]], inspect({doc, intent})

      assert get_in(doc, ["families", intent["family"]]) in [
               nil,
               doc["bindings"][name]["session_id"]
             ],
             inspect({doc, intent})

      refute doc["bindings"][name]["recovered"]
      assert doc["bindings"][name]["family"] == family
      assert {:ok, attempt} = Terminal.LaunchAttempts.get(name)
      refute attempt["rex"]
      assert {"", 0} = Terminal.stop(@runner, name, backends: [Backend])

      if unquote(operation) == "session.new_window" do
        assert :present = Backend.probe(@runner, "crash-sibling-a")
        assert {"", 0} = Terminal.stop(@runner, "crash-sibling-a", backends: [Backend])
      end

      assert {:ok, []} = Rex.sessions(@runner)
    end
  end

  test "a worker leaves the view behind another window with its program running, opens back into a window, and stops while hidden",
       %{root: root} do
    # Not macOS, so the open never reaches for the operator's Rex app.
    Env.put_app_env(:os_type, {:unix, :linux})
    Env.put_app_env(:terminal_backend, Backend)
    name = "hide-#{System.unique_integer([:positive])}-shuttle"
    path = WorkerProcess.script_path(name)
    pidfile = Path.join(root, "hidden-pid")
    File.write!(path, Backend.script(name).env <> "echo $$ > '#{pidfile}'\nsleep 300\n")
    on_exit(fn -> File.rm(path) end)
    assert :ok = Backend.launch(@runner, name, root, path, [])
    await(fn -> File.exists?(pidfile) end)
    pid = File.read!(pidfile) |> String.trim()

    {:ok, %{"bindings" => %{^name => %{"session_id" => sid, "block_id" => bid}}}} =
      RexBindings.read()

    shell = %{
      "window_label" => "shell",
      "layout" => %{
        "block" => %{
          "flavor" => "com.superlogical.terminal.shell",
          "options" => %{"shell" => "none", "command" => ["sleep", "300"]}
        }
      }
    }

    assert {:ok, %{"window_id" => other}} =
             Rex.call(@runner, "session.new_window", shell, session: sid)

    assert {:ok, _} =
             Rex.call(@runner, "session.focus_window", %{"window_id" => other}, session: sid)

    assert {:ok, %{}} = Shuttle.RexView.sweep(@runner, %{}, grace_ms: 0)
    assert {:ok, [%{"window_id" => ^other}]} = Rex.windows(@runner, sid)
    assert {:ok, blocks} = Rex.blocks(@runner, sid)
    assert %{"placement" => "detached"} = Enum.find(blocks, &(&1["block_id"] == bid))
    assert {_, 0} = System.cmd("kill", ["-0", pid])

    assert {:ok, names} = Backend.list(@runner)
    assert name in names

    # No app client is attached to the isolated server, so the open stops short
    # of selecting, after putting the worker back in a window of its own.
    assert {:error, _no_app_client} = Shuttle.Opener.open(name)
    assert {:ok, windows} = Rex.windows(@runner, sid)
    assert length(windows) == 2
    assert {:ok, blocks} = Rex.blocks(@runner, sid)
    placed = Enum.find(blocks, &(&1["block_id"] == bid))
    assert placed["placement"] == "placed"
    assert length(blocks) == 2
    assert {_, 0} = System.cmd("kill", ["-0", pid])

    # Hidden again, the worker stops: its block and program end, the other window stays.
    assert {:ok, _} =
             Rex.call(@runner, "session.focus_window", %{"window_id" => other}, session: sid)

    assert {:ok, %{}} = Shuttle.RexView.sweep(@runner, %{}, grace_ms: 0)
    assert {:ok, blocks} = Rex.blocks(@runner, sid)
    assert %{"placement" => "detached"} = Enum.find(blocks, &(&1["block_id"] == bid))
    assert :ok = Backend.close(@runner, name)
    assert {:ok, [%{"placement" => "placed"}]} = Rex.blocks(@runner, sid)
    assert {:ok, [%{"window_id" => ^other}]} = Rex.windows(@runner, sid)
    await(fn -> match?({_, 1}, System.cmd("kill", ["-0", pid], stderr_to_stdout: true)) end)
    assert {:ok, %{"bindings" => bindings}} = RexBindings.read()
    refute Map.has_key?(bindings, name)
  end

  test "a 120-character fiber leaf launches with bounded display and block labels", %{root: root} do
    Env.put_app_env(:terminal_backend, Backend)
    fiber = "work/" <> String.duplicate("x", 120)
    name = Shuttle.Dispatcher.session_name(fiber, "01KVBR5K0FZHZQK18845TZ01Q2")
    assert :ok = Terminal.launch(@runner, name, root, "sleep 60\n", fiber: fiber)
    on_exit(fn -> File.rm(WorkerProcess.script_path(name)) end)
    assert {:ok, %{"bindings" => %{^name => binding}}} = RexBindings.read()
    assert {:ok, [%{"label" => display}]} = Rex.sessions(@runner)
    assert String.length(display) <= 127
    assert {:ok, [%{"label" => index}]} = Rex.blocks(@runner, binding["session_id"])
    assert index == Backend.worker_label(name)
    assert String.length(index) == 127
    assert {"", 0} = Terminal.stop(@runner, name, backends: [Backend])
  end

  test "display-only viewers dedupe while live and observation retires empty owned sessions", %{
    root: root
  } do
    label = String.duplicate("probe-viewer-", 10) <> "long-name@tmux"
    receipt = Path.join(root, "viewer-env")
    gate = Path.join(root, "viewer-exit")
    Env.put_env("SSH_AUTH_SOCK", "/tmp/probe-daemon-agent")

    command = [
      "/bin/bash",
      "-c",
      "printf '%s' \"$SSH_AUTH_SOCK\" > '#{receipt}'; while [ ! -e '#{gate}' ]; do /bin/sleep 0.05; done"
    ]

    assert {:ok, sid} = Backend.viewer(@runner, label, command)
    await(fn -> File.exists?(receipt) end)
    assert File.read!(receipt) == "/tmp/probe-daemon-agent"
    assert {:ok, ^sid} = Backend.viewer(@runner, label, command)
    assert {:ok, [%{"session_id" => ^sid, "label" => display_label}]} = Rex.sessions(@runner)
    assert String.length(display_label) == 127
    assert String.ends_with?(display_label, "@tmux")
    assert {:ok, %{"bindings" => bindings}} = RexBindings.read()
    assert bindings == %{}
    File.write!(gate, "exit")

    await(fn ->
      Backend.sweep(@runner)
      Rex.sessions(@runner) == {:ok, []}
    end)
  end
end
