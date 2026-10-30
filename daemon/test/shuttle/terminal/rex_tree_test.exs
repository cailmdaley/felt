defmodule Shuttle.Terminal.RexTreeTest do
  use ExUnit.Case, async: true
  alias Shuttle.{Terminal, Rex, Test.Env, Test.FakeRex}
  alias Shuttle.Terminal.{RexBindings, RexTree}
  alias Shuttle.Terminal.Rex, as: Backend
  @moduletag :tmp_dir

  setup %{tmp_dir: dir} do
    Env.put_env("SHUTTLE_DATA_DIR", dir)
    Env.put_env("SHUTTLE_REX_BIN", "/bin/echo")
    Env.put_app_env(:fake_rex, start_supervised!({FakeRex, []}))
    Env.put_app_env(:terminal_backend, Backend)
    :ok
  end

  test "nested fixture orders by path segments and counts live ancestors, not missing levels" do
    entries =
      for {path, suffix} <- [
            {"work/design/rex/thread/deep/leaf", ""},
            {"other/alone", ""},
            {"work/design/rex-other", ""},
            {"work/design/rex/thread", ""},
            {"work/design/rex", ""},
            {"work/design/rex/thread", " @remote-a"},
            {"work/design/rex/thread/deep", " @tmux"}
          ],
          do: %{fiber: path, suffix: suffix, session_id: path <> suffix}

    assert Enum.map(RexTree.layout(entries), &{&1.fiber, &1.label}) == [
             {"other/alone", "other/alone"},
             {"work/design/rex", "design/rex"},
             {"work/design/rex/thread", "└ thread"},
             {"work/design/rex/thread", "└ thread @remote-a"},
             {"work/design/rex/thread/deep", "\u2003└ deep @tmux"},
             {"work/design/rex/thread/deep/leaf", "\u2003\u2003└ leaf"},
             {"work/design/rex-other", "design/rex-other"}
           ]

    assert [%{label: "deep/leaf"}] = RexTree.layout([%{fiber: "a/deep/leaf", session_id: "s"}])
  end

  test "launch, claim and observed exit refresh only bound sessions; worker recovery labels survive" do
    FakeRex.sessions(%{
      "session:human" => %{
        label: "human",
        blocks: [%{"block_id" => "block:human", "label" => "human"}]
      }
    })

    assert :ok =
             Terminal.launch(FakeRex, "thread-worker", "/tmp", "sleep 30",
               fiber: "work/design/rex/thread"
             )

    assert :ok =
             Terminal.launch(FakeRex, "parent-worker", "/tmp", "sleep 30",
               fiber: "work/design/rex"
             )

    assert {:ok, doc} = RexBindings.read()
    parent = doc["bindings"]["parent-worker"]
    thread = doc["bindings"]["thread-worker"]
    assert {:ok, sessions} = Rex.sessions(FakeRex)
    assert Enum.map(sessions, & &1["label"]) == ["human", "design/rex", "└ thread"]
    assert FakeRex.state().sessions[parent["session_id"]].window_label == "parent-worker"

    assert [%{"label" => "thread-worker"}] =
             FakeRex.state().sessions[thread["session_id"]].blocks
             |> Enum.map(&Map.take(&1, ["label"]))

    # Recovery uses block labels even after the display has become a tree.
    assert :ok = RexBindings.delete("thread-worker", thread)
    assert :present = Backend.probe(FakeRex, "thread-worker")
    assert :ok = RexBindings.put_fiber("thread-worker", "work/design/rex/thread")

    # Native claim makes the window/block the recovery index, then projects display.
    assert :ok =
             Terminal.rename(FakeRex, parent["session_id"], "claimed-parent",
               fiber: "work/design/rex"
             )

    assert FakeRex.state().sessions[parent["session_id"]].window_label == "claimed-parent"

    assert [%{"label" => "claimed-parent"}] =
             FakeRex.state().sessions[parent["session_id"]].blocks
             |> Enum.map(&Map.take(&1, ["label"]))

    before = FakeRex.calls()
    RexTree.refresh(FakeRex)

    refute Enum.any?(FakeRex.calls() -- before, fn {_, args, _} ->
             "session.set_label" in args or "session.move" in args
           end)

    # A natural exit leaves an empty Rex session until the backend observes it.
    FakeRex.sessions(
      Map.update!(FakeRex.state().sessions, parent["session_id"], &%{&1 | blocks: []})
    )

    assert :absent = Backend.probe(FakeRex, "claimed-parent")
    assert {:ok, sessions} = Rex.sessions(FakeRex)
    assert Enum.map(sessions, & &1["label"]) == ["human", "rex/thread"]

    refute Enum.any?(FakeRex.calls(), fn {_, args, _} ->
             "session:human" in args and
               Enum.any?(["session.move", "session.set_label", "session.destroy"], &(&1 in args))
           end)
  end

  test "viewer bindings survive display drift and never reuse same-labelled unowned sessions" do
    label = "worker@remote-a"

    FakeRex.sessions(%{
      "session:human" => %{label: label, blocks: [%{"block_id" => "block:human"}]}
    })

    assert {:ok, sid} =
             Backend.viewer(FakeRex, label, ["sleep", "30"], fiber: "a/design/rex/thread")

    assert :ok = Terminal.launch(FakeRex, "parent", "/tmp", "sleep 30", fiber: "a/design/rex")
    assert {:ok, sessions} = Rex.sessions(FakeRex)
    assert Enum.map(sessions, & &1["label"]) == [label, "design/rex", "└ thread @remote-a"]

    assert {:ok, ^sid} =
             Backend.viewer(FakeRex, label, ["sleep", "30"], fiber: "a/design/rex/thread")

    assert Enum.count(FakeRex.calls(), fn {_, args, _} -> "session.create" in args end) == 2
    assert FakeRex.state().sessions["session:human"].label == label
    assert :ok = Terminal.close(FakeRex, "parent")
    assert FakeRex.state().sessions[sid].label == "rex/thread @remote-a"
  end
end
