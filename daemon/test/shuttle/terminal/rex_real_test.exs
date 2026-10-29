defmodule Shuttle.Terminal.RexRealTest do
  use ExUnit.Case, async: true
  alias Shuttle.{Rex, Terminal, WorkerProcess, Test.Env}
  alias Shuttle.Terminal.RexBindings
  alias Shuttle.Terminal.Rex, as: Backend
  @moduletag :tmp_dir
  @moduletag skip: is_nil(Shuttle.Rex.bin())
  @moduletag timeout: 60_000
  @runner Shuttle.Runner.Default
  import Shuttle.Test.IsolatedRex, only: [await: 1]

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

  test "an empty worker session is reclaimed after its binding is lost", %{root: root} do
    name = "probe-lost-#{System.unique_integer([:positive])}-shuttle"
    path = WorkerProcess.script_path(name)
    File.write!(path, "exit 0\n")
    on_exit(fn -> File.rm(path) end)
    assert :ok = Backend.launch(@runner, name, root, path, [])
    assert {:ok, %{"bindings" => %{^name => b}}} = RexBindings.read()
    assert :ok = RexBindings.delete(name, b)
    await(fn -> Rex.blocks(@runner, b["session_id"]) == {:ok, []} end)
    assert :absent = Backend.probe(@runner, name)
    assert {:ok, []} = Rex.sessions(@runner)
  end
end
