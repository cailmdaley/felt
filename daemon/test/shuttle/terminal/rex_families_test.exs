defmodule Shuttle.Terminal.RexFamiliesTest do
  use ExUnit.Case, async: true
  alias Shuttle.{Rex, Test.Env, Test.FakeRex, Test.RexFamilyStore}
  alias Shuttle.Terminal.{RexBindings, RexTree}
  alias Shuttle.Terminal.Rex, as: Backend
  @moduletag :tmp_dir
  @root "work/design/family"

  setup %{tmp_dir: dir} do
    Env.put_env("SHUTTLE_DATA_DIR", dir)
    Env.put_env("SHUTTLE_REX_BIN", "/bin/echo")
    Env.put_app_env(:fake_rex, start_supervised!({FakeRex, []}))
    Env.put_app_env(:rex_runner, FakeRex)
    Env.put_app_env(:paste_submit_delay_ms, 0)
    RexFamilyStore.write(dir, [@root, @root <> "/a", @root <> "/b"], [@root <> "/notes"])
    :ok
  end

  test "family resolution uses constitution ancestors even with no live root" do
    rows = [
      %{"id" => "work", "tags" => []},
      %{"id" => @root, "tags" => ["constitution"]},
      %{"id" => @root <> "/a", "shuttle" => %{}},
      %{"id" => @root <> "/a/note", "tags" => []}
    ]

    assert %{family: @root, depth: 2} = RexTree.family(@root <> "/a/note/child", rows)
    assert %{family: @root, depth: 1} = RexTree.family(@root <> "/notes/child", rows)
    assert %{family: @root, depth: 0} = RexTree.family(@root, rows)

    assert %{family: "work/design/family-other/a", depth: 0} =
             RexTree.family("work/design/family-other/a", rows)

    assert RexTree.session_label(@root) == "design/family"
    assert RexTree.session_label("solo") == "solo"
    assert {:ok, %{family: @root, depth: 1}} = RexTree.resolve(@root <> "/notes")
  end

  test "launch adds a tab to a recorded family without needing its root worker" do
    assert :ok = launch("b", @root <> "/b")
    assert :ok = launch("a", @root <> "/a")
    assert {:ok, doc} = RexBindings.read()
    a = doc["bindings"]["a"]
    b = doc["bindings"]["b"]
    assert a["session_id"] == b["session_id"]
    refute a["window_id"] == b["window_id"]
    assert a["family"] == @root
    assert b["depth"] == 1
    assert RexTree.refresh(FakeRex) == :ok
    assert {:ok, [%{"label" => "design/family"}]} = Rex.sessions(FakeRex)

    assert {:ok, [%{"label" => "└ a"}, %{"label" => "└ b"}]} =
             Rex.windows(FakeRex, a["session_id"])

    assert Enum.count(FakeRex.calls(), fn {_, args, _} -> "session.create" in args end) == 1
    assert Enum.count(FakeRex.calls(), fn {_, args, _} -> "session.new_window" in args end) == 1
    assert :present = Backend.probe(FakeRex, "a")
    assert :present = Backend.probe(FakeRex, "b")
    assert :ok = Backend.paste(FakeRex, "a", "message")
    assert {:ok, names} = Backend.list(FakeRex)
    assert Enum.sort(names) == ["a", "b"]
  end

  test "concurrent sibling launches create exactly one family session" do
    tasks = for n <- 1..6, do: Task.async(fn -> launch("worker-#{n}", @root <> "/a") end)
    for task <- tasks, do: assert(Task.await(task, 30_000) == :ok)
    assert {:ok, doc} = RexBindings.read()
    assert map_size(doc["bindings"]) == 6
    assert [_] = doc["bindings"] |> Map.values() |> Enum.map(& &1["session_id"]) |> Enum.uniq()
    assert {:ok, [%{"session_id" => sid}]} = Rex.sessions(FakeRex)
    assert {:ok, windows} = Rex.windows(FakeRex, sid)
    assert length(windows) == 6
    assert Enum.count(FakeRex.calls(), fn {_, args, _} -> "session.create" in args end) == 1
  end

  test "closing one worker keeps its sibling and the final window retires the owned session" do
    assert :ok = launch("a", @root <> "/a")
    assert :ok = launch("b", @root <> "/b")
    assert {:ok, doc} = RexBindings.read()
    b = doc["bindings"]["b"]
    assert :ok = Backend.close(FakeRex, "a")
    assert :present = Backend.probe(FakeRex, "b")
    assert {:ok, [%{"window_id" => wid}]} = Rex.windows(FakeRex, b["session_id"])
    assert wid == b["window_id"]
    assert :ok = Backend.close(FakeRex, "b")
    assert {:ok, []} = Rex.sessions(FakeRex)
    assert {:ok, %{"bindings" => bindings, "families" => families}} = RexBindings.read()
    assert bindings == %{}
    assert families == %{}
    assert :absent = Backend.close(FakeRex, "b")
  end

  test "reveal selects the exact session and window through the app client" do
    assert :ok = launch("a", @root <> "/a")
    assert :ok = launch("b", @root <> "/b")
    assert {:ok, doc} = RexBindings.read()
    a = doc["bindings"]["a"]
    FakeRex.clients([%{"client_id" => "client:app", "info" => %{"kind" => "app"}}])
    assert :ok = Backend.reveal("a", nil)
    {_, _, opts} = Enum.find(FakeRex.calls(), fn {_, args, _} -> "client.perform" in args end)
    assert %{"action" => "session.select", "args" => args} = Jason.decode!(opts[:input])
    assert args == Map.take(a, ["session_id", "window_id"])
  end

  test "a remote viewer shares the worker family and retains its host in the tab label" do
    assert :ok = launch("a", @root <> "/a")
    assert {:ok, sid} = Backend.viewer(FakeRex, "b@remote", ["sleep", "60"], fiber: @root <> "/b")
    assert {:ok, [%{"label" => "└ a"}, %{"label" => "└ b @remote"}]} = Rex.windows(FakeRex, sid)
    assert :ok = Backend.close(FakeRex, "a")
    assert {:ok, [%{"label" => "└ b @remote"}]} = Rex.windows(FakeRex, sid)
    assert {:ok, doc} = RexBindings.read()
    b = doc["viewers"]["b@remote"]
    assert {:ok, _} = Rex.close_window(FakeRex, sid, b["window_id"])
    assert :ok = Backend.sweep(FakeRex)
    assert {:ok, []} = Rex.sessions(FakeRex)
  end

  test "an unowned human window prevents destruction of an otherwise empty family" do
    assert :ok = launch("a", @root <> "/a")
    assert {:ok, doc} = RexBindings.read()
    sid = doc["bindings"]["a"]["session_id"]

    sessions =
      Map.update!(FakeRex.state().sessions, sid, fn s ->
        s
        |> Map.put(
          :blocks,
          s.blocks ++ [%{"block_id" => "block:human", "window_id" => "window:human"}]
        )
        |> Map.put(:windows, s.windows ++ [%{"window_id" => "window:human", "label" => "human"}])
      end)

    FakeRex.sessions(sessions)
    assert :ok = Backend.close(FakeRex, "a")
    assert {:ok, [%{"window_id" => "window:human"}]} = Rex.windows(FakeRex, sid)
    assert :ok = Backend.sweep(FakeRex)
    assert {:ok, [%{"session_id" => ^sid}]} = Rex.sessions(FakeRex)
  end

  test "refiling an active worker keeps its recorded family and session" do
    assert :ok = launch("a", @root <> "/a")
    assert {:ok, doc} = RexBindings.read()
    b = doc["bindings"]["a"]
    assert :ok = RexBindings.put_fiber("a", "another/family/refiled")
    assert :ok = RexTree.refresh(FakeRex)
    assert {:ok, [%{"session_id" => sid, "label" => "design/family"}]} = Rex.sessions(FakeRex)
    assert sid == b["session_id"]
    refute Enum.any?(FakeRex.calls(), fn {_, args, _} -> "session.move" in args end)
  end

  defp launch(name, fiber), do: Backend.launch(FakeRex, name, "/tmp", "worker.sh", fiber: fiber)
end
