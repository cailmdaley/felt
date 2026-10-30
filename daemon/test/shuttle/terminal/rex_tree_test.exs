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

    Shuttle.Test.RexFamilyStore.write(dir, [
      "work/design/rex",
      "work/design/rex/thread",
      "work/design/rex/thread/deep",
      "a/design/rex",
      "a/design/rex/thread"
    ])

    :ok
  end

  test "nested fixture orders tabs by path and counts constitutions, not live workers" do
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
          do:
            Map.merge(
              RexTree.family(path, [
                %{"id" => "work/design/rex", "tags" => ["constitution"]},
                %{"id" => "work/design/rex/thread", "shuttle" => %{}},
                %{"id" => "work/design/rex/thread/deep", "tags" => ["constitution"]}
              ]),
              %{suffix: suffix, session_id: "session:family", window_id: path <> suffix}
            )

    assert Enum.map(RexTree.layout(entries), &{&1.fiber, &1.label}) == [
             {"other/alone", "alone"},
             {"work/design/rex", "rex"},
             {"work/design/rex/thread", "└ thread"},
             {"work/design/rex/thread", "└ thread @remote-a"},
             {"work/design/rex/thread/deep", "\u2003└ deep @tmux"},
             {"work/design/rex/thread/deep/leaf", "\u2003\u2003└ leaf"},
             {"work/design/rex-other", "rex-other"}
           ]

    assert [%{label: "leaf"}] = RexTree.layout([%{fiber: "a/deep/leaf", session_id: "s"}])
  end

  test "Codex viewers resolve the App Server thread independently of the transcript id" do
    records = [
      %{"fiber" => "work/source", "session" => "source-transcript", "thread_id" => "fork-thread"},
      %{"fiber" => "work/fork", "session" => "fork-transcript", "thread_id" => "fork-thread"}
    ]

    assert RexTree.fiber_for("codex-terminal-fork-thread", records) == "work/fork"
    assert RexTree.fiber_for("resume-fork-transcript", records) == "work/fork"
    assert RexTree.fiber_for("codex-terminal-unrelated", records) == nil
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
    assert parent["session_id"] == thread["session_id"]
    assert Enum.map(sessions, & &1["label"]) == ["human", "design/rex"]

    assert {:ok, [%{"label" => "rex"}, %{"label" => "└ thread"}]} =
             Rex.windows(FakeRex, parent["session_id"])

    assert [%{"label" => "thread-worker"}] =
             FakeRex.state().sessions[thread["session_id"]].blocks
             |> Enum.filter(&(&1["block_id"] == thread["block_id"]))
             |> Enum.map(&Map.take(&1, ["label"]))

    # Recovery uses block labels even after the display has become a tree.
    assert :ok = RexBindings.delete("thread-worker", thread)
    assert :present = Backend.probe(FakeRex, "thread-worker")
    assert :ok = RexBindings.put_fiber("thread-worker", "work/design/rex/thread")

    # Native claims address the worker block, not an arbitrary family sibling.
    assert :ok =
             Terminal.rename(FakeRex, parent["block_id"], "claimed-parent",
               fiber: "work/design/rex"
             )

    assert {:ok, [%{"label" => "rex"}, %{"label" => "└ thread"}]} =
             Rex.windows(FakeRex, parent["session_id"])

    assert [%{"label" => "claimed-parent"}] =
             FakeRex.state().sessions[parent["session_id"]].blocks
             |> Enum.filter(&(&1["block_id"] == parent["block_id"]))
             |> Enum.map(&Map.take(&1, ["label"]))

    before = FakeRex.calls()
    RexTree.refresh(FakeRex)

    refute Enum.any?(FakeRex.calls() -- before, fn {_, args, _} ->
             "session.set_label" in args or "session.move" in args
           end)

    # A natural exit leaves an empty Rex session until the backend observes it.
    FakeRex.sessions(
      Map.update!(FakeRex.state().sessions, parent["session_id"], fn s ->
        %{s | blocks: Enum.reject(s.blocks, &(&1["block_id"] == parent["block_id"]))}
      end)
    )

    assert :absent = Backend.probe(FakeRex, "claimed-parent")
    assert {:ok, sessions} = Rex.sessions(FakeRex)
    assert Enum.map(sessions, & &1["label"]) == ["human", "design/rex"]
    assert {:ok, [%{"label" => "└ thread"}]} = Rex.windows(FakeRex, thread["session_id"])

    refute Enum.any?(FakeRex.calls(), fn {_, args, _} ->
             "session:human" in args and
               Enum.any?(["session.move", "session.set_label", "session.destroy"], &(&1 in args))
           end)
  end

  test "listing workers observes Rex once without projecting the tree" do
    assert :ok = Terminal.launch(FakeRex, "worker", "/tmp", "sleep 30", fiber: "a/design/rex")
    before = FakeRex.calls()
    assert {:ok, _} = Terminal.list_workers(FakeRex)
    calls = FakeRex.calls() -- before
    assert Enum.count(calls, fn {_, argv, _} -> "session.list" in argv end) == 1

    refute Enum.any?(calls, fn {_, argv, _} ->
             "session.set_label" in argv or "session.move" in argv
           end)
  end

  test "unbound tmux workers and viewers do not scan Rex on status or locate" do
    tools = Path.join(Shuttle.data_dir(), "tools")
    File.mkdir_p!(tools)
    File.write!(Path.join(tools, "tmux"), "#!/bin/sh\nexit 0\n")
    File.chmod!(Path.join(tools, "tmux"), 0o755)
    Env.put_env("PATH", tools)
    FakeRex.reply("tmux", {"", 0})

    for name <- ["old-worker", "resume-session", "codex-terminal-thread"], _ <- 1..3 do
      assert :alive = Terminal.status(FakeRex, name)
      assert Terminal.locate(FakeRex, name) == Terminal.Tmux
    end

    assert Enum.all?(FakeRex.calls(), fn {bin, _, _} -> bin == "tmux" end)
  end

  test "refresh resolves ledger identity once and persists the fiber", %{tmp_dir: dir} do
    Env.put_env("SHUTTLE_SESSIONS_FILE", Path.join(dir, "sessions.jsonl"))

    Shuttle.SessionLedger.record(
      fiber: "work/fork",
      session: "transcript",
      thread_id: "thread",
      kind: :dispatch
    )

    assert :ok = Backend.launch(FakeRex, "codex-terminal-thread", "/tmp", "worker.sh", [])
    RexTree.refresh(FakeRex)

    assert {:ok, %{"bindings" => %{"codex-terminal-thread" => %{"fiber" => "work/fork"}}}} =
             RexBindings.read()

    File.rm!(Path.join(dir, "sessions.jsonl"))
    RexTree.refresh(FakeRex)
    assert {:ok, [%{"label" => "work/fork"}]} = Rex.sessions(FakeRex)
  end

  test "Rex I/O during refresh does not hold the bindings lock" do
    assert :ok = Terminal.launch(FakeRex, "worker", "/tmp", "sleep 30", fiber: "a/design/rex")
    parent = self()

    Env.put_app_env(:fake_rex_hook, fn
      "session.list" ->
        send(parent, {:projection_paused, self()})

        receive do
          :continue -> :ok
        after
          5_000 -> raise "projection barrier timed out"
        end

      _ ->
        :ok
    end)

    projection = Task.async(fn -> RexTree.refresh(FakeRex) end)
    assert_receive {:projection_paused, projector}, 2_000
    update = Task.async(fn -> RexBindings.put_fiber("worker", "a/design/rex/thread") end)
    assert Task.yield(update, 1_000) == {:ok, :ok}
    send(projector, :continue)
    assert Task.await(projection) == :ok
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
    assert Enum.map(sessions, & &1["label"]) == [label, "design/rex"]

    assert {:ok, [%{"label" => "rex"}, %{"label" => "└ thread @remote-a"}]} =
             Rex.windows(FakeRex, sid)

    assert {:ok, ^sid} =
             Backend.viewer(FakeRex, label, ["sleep", "30"], fiber: "a/design/rex/thread")

    assert Enum.count(FakeRex.calls(), fn {_, args, _} -> "session.create" in args end) == 1
    assert FakeRex.state().sessions["session:human"].label == label
    assert :ok = Terminal.close(FakeRex, "parent")
    assert FakeRex.state().sessions[sid].label == "design/rex"
    assert {:ok, [%{"label" => "└ thread @remote-a"}]} = Rex.windows(FakeRex, sid)
  end
end
