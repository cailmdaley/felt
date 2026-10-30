defmodule Shuttle.Terminal.RexRealTest do
  use ExUnit.Case, async: true
  alias Shuttle.{Rex, Terminal, WorkerProcess, Test.Env}
  alias Shuttle.Terminal.RexBindings
  alias Shuttle.Terminal.Rex, as: Backend
  @moduletag :tmp_dir
  @moduletag skip: Shuttle.Test.IsolatedRex.skip?()
  @moduletag timeout: 60_000
  @runner Shuttle.Runner.Default
  import Shuttle.Test.IsolatedRex, only: [await: 1]
  import Shuttle.Test.PollerHelpers

  defmodule ClaimRunner do
    def cmd(command, args, opts) when command in ["shuttle", "felt"],
      do: Shuttle.Test.FeltStoreRunner.cmd(command, args, opts)

    def cmd(command, args, opts), do: Shuttle.Runner.Default.cmd(command, args, opts)
  end

  setup %{tmp_dir: dir} do
    root = Shuttle.Test.IsolatedRex.start(dir)
    Env.put_env("SHUTTLE_HOST", "probe-isolated-sentinel")
    Env.put_app_env(:paste_submit_delay_ms, 0)
    {:ok, root: root}
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

  test "two real workers with no live root share one family session and stopping both removes it",
       %{root: root} do
    Env.put_app_env(:terminal_backend, Backend)

    Shuttle.Test.RexFamilyStore.write(root, [
      "work/design/family",
      "work/design/family/a",
      "work/design/family/b"
    ])

    names = ["probe-family-b", "probe-family-a"]
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
    assert doc["bindings"]["probe-family-a"]["session_id"] == sid
    assert doc["bindings"]["probe-family-b"]["session_id"] == sid
    assert {:ok, blocks} = Rex.blocks(@runner, sid)
    assert Enum.sort(Enum.map(blocks, & &1["label"])) == Enum.sort(names)
    assert {"", 0} = Terminal.stop(@runner, "probe-family-a", backends: [Backend])
    assert :present = Backend.probe(@runner, "probe-family-b")
    assert {:ok, [%{"label" => "└ b"}]} = Rex.windows(@runner, sid)
    assert {"", 0} = Terminal.stop(@runner, "probe-family-b", backends: [Backend])
    assert {:ok, []} = Rex.sessions(@runner)
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

  @tag skip: Shuttle.Test.IsolatedRex.skip?(["tmux"])
  test "the auxiliary anchor answers on the daemon's custom TMUX_TMPDIR without an explicit socket" do
    # Keep the default socket short enough for macOS's Unix-socket path limit.
    tmpdir =
      Path.join(
        "/tmp",
        "rex-anchor-" <> Base.url_encode64(:crypto.strong_rand_bytes(9), padding: false)
      )

    File.mkdir_p!(tmpdir)
    tmux = Shuttle.Env.find_executable("tmux")
    Env.put_env("TMUX_TMPDIR", tmpdir)
    Env.put_app_env(:os_type, {:unix, :darwin})
    Env.put_app_env(:terminal_backend, Backend)

    on_exit(fn ->
      System.cmd(tmux, ["kill-server"],
        env: [{"TMUX_TMPDIR", tmpdir}, {"TMUX", nil}, {"TMUX_PANE", nil}],
        stderr_to_stdout: true
      )

      File.rm_rf!(tmpdir)
    end)

    assert :absent = Shuttle.TmuxServer.presence(@runner)
    assert :ok = Shuttle.TmuxServer.ensure_available(@runner)
    assert :present = Shuttle.TmuxServer.presence(@runner)
    assert {"shuttle-anchor\n", 0} = @runner.cmd("tmux", ["ls", "-F", "\#{session_name}"], [])
    await(fn -> Rex.sessions(@runner) == {:ok, []} end)
  end

  @tag skip: Shuttle.Test.IsolatedRex.skip?(["tmux"])
  test "a Rex background anchor outlives its launcher with no Rex identity in tmux", %{root: root} do
    tmux = Shuttle.Env.find_executable("tmux")
    socket = Path.join(root, "anchor.sock")
    receipt = Path.join(root, "anchor-env")

    argv = [
      tmux,
      "-S",
      socket,
      "new-session",
      "-d",
      "-s",
      "probe-anchor",
      "--",
      "/bin/sh",
      "-c",
      "printf '%s\\n' \"${REX_SESSION-unset}\" \"${REX_BLOCK-unset}\" \"${REX_CLIENT-unset}\" > '#{receipt}'; exec sleep 60"
    ]

    on_exit(fn -> System.cmd(tmux, ["-S", socket, "kill-server"], stderr_to_stdout: true) end)
    assert :ok = Rex.run_background(argv, @runner)
    await(fn -> File.exists?(receipt) end)
    assert File.read!(receipt) == "unset\nunset\nunset\n"
    await(fn -> Rex.sessions(@runner) == {:ok, []} end)

    assert {"probe-anchor\n", 0} =
             System.cmd(tmux, ["-S", socket, "ls", "-F", "\#{session_name}"])

    assert {:ok, %{"bindings" => bindings}} = RexBindings.read()
    assert bindings == %{}
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

  test "real viewers and workers share a family whose label survives the root viewer's exit", %{
    root: root
  } do
    Env.put_app_env(:terminal_backend, Backend)
    Shuttle.Test.RexFamilyStore.write(root, ["a/design/rex", "a/design/rex/thread"])
    gate = Path.join(root, "viewer-done")
    command = ["/bin/bash", "-c", "while [ ! -e '#{gate}' ]; do /bin/sleep 0.05; done"]

    assert {:ok, sid} =
             Backend.viewer(@runner, "probe-parent@tmux", command, fiber: "a/design/rex")

    assert :ok =
             Terminal.launch(
               @runner,
               "probe-tree-thread",
               root,
               "trap 'rm -f \"$0\"' EXIT\nsleep 60\n",
               fiber: "a/design/rex/thread"
             )

    assert {:ok, sessions} = Rex.sessions(@runner)
    assert Enum.map(sessions, & &1["label"]) == ["design/rex"]

    assert {:ok, [%{"label" => "rex @tmux"}, %{"label" => "└ thread"}]} =
             Rex.windows(@runner, sid)

    assert {:ok, ^sid} =
             Backend.viewer(@runner, "probe-parent@tmux", command, fiber: "a/design/rex")

    File.write!(gate, "done")
    await(fn -> match?({:ok, [%{"label" => "└ thread"}]}, Rex.windows(@runner, sid)) end)
    assert {:ok, _} = Terminal.list(@runner, "probe-")
    assert {:ok, [%{"session_id" => ^sid, "label" => "design/rex"}]} = Rex.sessions(@runner)
    assert {"", 0} = Terminal.stop(@runner, "probe-tree-thread")
  end

  @tag skip: Shuttle.Test.IsolatedRex.skip?(["tmux"])
  test "a real viewer reaches the daemon's custom tmux socket directory" do
    tmux = Shuttle.Env.find_executable("tmux")

    tmpdir =
      Path.join(
        "/tmp",
        "rex-viewer-" <> Base.url_encode64(:crypto.strong_rand_bytes(9), padding: false)
      )

    File.mkdir_p!(tmpdir)
    Env.put_env("TMUX_TMPDIR", tmpdir)
    env = [{"TMUX_TMPDIR", tmpdir}, {"TMUX", nil}, {"TMUX_PANE", nil}]

    on_exit(fn ->
      System.cmd(tmux, ["kill-server"], env: env, stderr_to_stdout: true)
      File.rm_rf!(tmpdir)
    end)

    assert {_, 0} =
             System.cmd(tmux, ["new-session", "-d", "-s", "probe-viewer", "/bin/sleep", "60"],
               env: env
             )

    assert {:ok, _} =
             Backend.viewer(@runner, "probe-custom@tmux", [tmux, "attach", "-t", "=probe-viewer"])

    await(fn ->
      System.cmd(tmux, ["list-clients", "-F", "\#{client_session}"],
        env: env,
        stderr_to_stdout: true
      ) == {"probe-viewer\n", 0}
    end)

    assert {_, 0} = System.cmd(tmux, ["detach-client", "-s", "probe-viewer"], env: env)

    await(fn ->
      Backend.sweep(@runner)
      Rex.sessions(@runner) == {:ok, []}
    end)
  end

  @tag skip: Shuttle.Test.IsolatedRex.skip?(["tmux"])
  test "a real tmux attach viewer closes without stopping its tmux server", %{root: root} do
    tmux = Shuttle.Env.find_executable("tmux")
    socket = Path.join(root, "tmux.sock")

    assert {_, 0} =
             System.cmd(tmux, [
               "-S",
               socket,
               "new-session",
               "-d",
               "-s",
               "probe-worker",
               "/bin/sleep",
               "60"
             ])

    on_exit(fn -> System.cmd(tmux, ["-S", socket, "kill-server"], stderr_to_stdout: true) end)

    assert {:ok, sid} =
             Backend.viewer(@runner, "probe-worker@tmux", [
               tmux,
               "-S",
               socket,
               "attach",
               "-t",
               "=probe-worker"
             ])

    await(fn ->
      case System.cmd(tmux, ["-S", socket, "list-clients", "-F", "\#{client_session}"],
             stderr_to_stdout: true
           ) do
        {"probe-worker\n", 0} -> true
        _ -> false
      end
    end)

    assert {:ok, ^sid} =
             Backend.viewer(@runner, "probe-worker@tmux", [
               tmux,
               "-S",
               socket,
               "attach",
               "-t",
               "=probe-worker"
             ])

    assert {_, 0} = System.cmd(tmux, ["-S", socket, "detach-client", "-s", "probe-worker"])

    await(fn ->
      Backend.sweep(@runner)
      Rex.sessions(@runner) == {:ok, []}
    end)

    assert {_, 0} = System.cmd(tmux, ["-S", socket, "has-session", "-t", "=probe-worker"])
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

  test "an exited auto-closing block leaves an empty session which the backend removes", %{
    root: root
  } do
    name = "probe-exit-#{System.unique_integer([:positive])}-shuttle"
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
    name = "probe-lost-#{System.unique_integer([:positive])}-shuttle"
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
      tests = Shuttle.Terminal.RexRealTest.__ex_unit__().tests
      assert length(tests) >= 4

      for test <- tests do
        assert test.tags[:skip] == true, "#{test.name} enables setup without Rex"
      end
    end
  end
end
