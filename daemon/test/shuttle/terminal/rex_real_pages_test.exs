defmodule Shuttle.Terminal.RexRealPagesTest do
  # Real Rex: a worker's window split with its thread page holder.
  use Shuttle.Test.RexRealCase, async: true
  alias Shuttle.Terminal.RexPages

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
end
