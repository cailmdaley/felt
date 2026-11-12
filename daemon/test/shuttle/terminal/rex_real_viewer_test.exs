defmodule Shuttle.Terminal.RexRealViewerTest do
  # Real Rex: viewers and tmux attach viewers.
  use Shuttle.Test.RexRealCase, async: true

  test "real viewers and workers share a family whose label survives the root viewer's exit", %{
    root: root
  } do
    Env.put_app_env(:terminal_backend, Backend)
    Shuttle.Test.RexFamilyStore.write(root, ["a/design/rex", "a/design/rex/thread"])
    gate = Path.join(root, "viewer-done")
    command = ["/bin/bash", "-c", "while [ ! -e '#{gate}' ]; do /bin/sleep 0.05; done"]

    assert {:ok, sid} =
             Backend.viewer(@runner, "probe-parent@tmux", command, fiber: "a/design/rex")

    thread = Shuttle.Test.FiberUid.name("probe-tree-thread")

    assert :ok =
             Terminal.launch(
               @runner,
               thread,
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
    assert {"", 0} = Terminal.stop(@runner, thread)
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
end
