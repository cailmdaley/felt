defmodule Shuttle.Terminal.RexRealPagesTest do
  # Real Rex: a worker's window split with its thread page holder.
  use Shuttle.Test.RexRealCase, async: true
  alias Shuttle.Terminal.RexPages

  defp pages_on(root) do
    host = Path.join(root, "host.json")
    File.write!(host, ~s({"pages":{"enabled":true,"base":"http://127.0.0.1:4000"}}))
    Env.put_env("SHUTTLE_HOST_CONFIG_FILE", host)
  end

  defp launch(root, fiber) do
    name = Shuttle.Test.FiberUid.session(fiber)
    on_exit(fn -> File.rm(WorkerProcess.script_path(name)) end)

    assert :ok =
             Terminal.launch(@runner, name, root, Backend.script(name).env <> "sleep 300\n",
               fiber: fiber
             )

    assert {:ok, %{"bindings" => %{^name => b}}} = RexBindings.read()
    {name, b}
  end

  defp split(sid, wid) do
    assert {:ok, view} = Rex.call(@runner, "session.view", %{}, session: sid)
    window = Enum.find(view["windows"], &(&1["window_id"] == wid))
    [%{"layout" => %{"split" => split}}] = window["layers"]
    split
  end

  test "a real launch splits the window and the holder titles its block with the page URL",
       %{root: root} do
    Env.put_app_env(:terminal_backend, Backend)
    host = Path.join(root, "host.json")
    File.write!(host, ~s({"pages":{"enabled":true,"base":"http://127.0.0.1:4000"}}))
    Env.put_env("SHUTTLE_HOST_CONFIG_FILE", host)
    family = "work/pages-family"
    Shuttle.Test.RexFamilyStore.write(root, [family, family <> "/a"])
    name = Shuttle.Test.FiberUid.session(family <> "/a")
    on_exit(fn -> File.rm(WorkerProcess.script_path(name)) end)

    assert :ok =
             Terminal.launch(@runner, name, root, Backend.script(name).env <> "sleep 300\n",
               fiber: family <> "/a"
             )

    assert {:ok, %{"bindings" => %{^name => b}}} = RexBindings.read()
    sid = b["session_id"]
    assert {:ok, view} = Rex.call(@runner, "session.view", %{}, session: sid)
    [window] = view["windows"]
    [%{"layout" => %{"split" => split}}] = window["layers"]
    assert split["direction"] == "horizontal"
    assert split["before"]["block_id"] == b["block_id"]
    assert split["after"]["block_id"] == b["page_block_id"]

    url = RexPages.url("http://127.0.0.1:4000", Shuttle.ULID.from_tmux(name))

    await(fn ->
      match?(
        {:ok, %{"title" => "rexweb " <> ^url}},
        Rex.call(
          @runner,
          "block.method",
          %{"block_id" => b["page_block_id"], "method" => "title"},
          session: sid
        )
      )
    end)

    before = RexBindings.read()
    assert :ok = RexPages.reconcile(@runner)
    assert RexBindings.read() == before
    assert {:ok, blocks} = Rex.blocks(@runner, sid)
    assert length(blocks) == 2

    assert {:ok, _} = Backend.hide(@runner, sid, b["block_id"])
    assert {:ok, [%{"block_id" => chat}]} = Rex.blocks(@runner, sid)
    assert chat == b["block_id"]
    assert {"", 0} = Terminal.stop(@runner, name, backends: [Backend])
  end

  test "a second worker's window in its family session is split worker first", %{root: root} do
    Env.put_app_env(:terminal_backend, Backend)
    pages_on(root)
    family = "work/pages-pair"
    Shuttle.Test.RexFamilyStore.write(root, [family, family <> "/a", family <> "/b"])
    {a, ba} = launch(root, family <> "/a")
    {b, bb} = launch(root, family <> "/b")
    assert ba["session_id"] == bb["session_id"]
    split = split(bb["session_id"], bb["window_id"])
    assert split["before"]["block_id"] == bb["block_id"]
    assert split["after"]["block_id"] == bb["page_block_id"]
    assert {"", 0} = Terminal.stop(@runner, a, backends: [Backend])
    assert {"", 0} = Terminal.stop(@runner, b, backends: [Backend])
  end

  test "reconcile splits a page beside a worker launched with pages off, once", %{root: root} do
    Env.put_app_env(:terminal_backend, Backend)
    family = "work/pages-late"
    Shuttle.Test.RexFamilyStore.write(root, [family, family <> "/a"])
    {a, _} = launch(root, family <> "/a")
    pages_on(root)
    assert :ok = RexPages.reconcile(@runner)
    assert {:ok, %{"bindings" => %{^a => b}}} = RexBindings.read()
    split = split(b["session_id"], b["window_id"])
    assert split["before"]["block_id"] == b["block_id"]
    assert split["after"]["block_id"] == b["page_block_id"]

    before = RexBindings.read()
    assert :ok = RexPages.reconcile(@runner)
    assert RexBindings.read() == before
    assert {:ok, blocks} = Rex.blocks(@runner, b["session_id"])
    assert length(blocks) == 2
    assert {"", 0} = Terminal.stop(@runner, a, backends: [Backend])
  end

  test "keep_last moves a retained session to the end of Rex's list", %{tmp_dir: dir} do
    window = %{
      "layout" => %{
        "block" => %{
          "flavor" => "com.superlogical.terminal.shell",
          "options" => %{"shell" => "none", "command" => ["sleep", "60"]}
        }
      }
    }

    [retained, _] =
      for label <- ["retained", "other"] do
        assert {:ok, %{"session_id" => sid}} =
                 Rex.create(@runner, %{"label" => label, "initial_windows" => [window]})

        sid
      end

    state = Path.join(dir, "retained-state")
    File.mkdir_p!(state)
    File.write!(Path.join(state, "x.json"), Jason.encode!(%{"session_id" => retained}))
    assert :ok = Shuttle.RetainedTerminal.keep_last(@runner, state_dir: state)
    assert {:ok, sessions} = Rex.sessions(@runner)
    assert List.last(sessions)["session_id"] == retained
  end
end
