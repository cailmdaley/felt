defmodule Shuttle.Terminal.RexFamiliesTest do
  use ExUnit.Case, async: true
  alias Shuttle.{Rex, Test.Env, Test.FakeRex, Test.RexFamilyStore}
  alias Shuttle.Terminal.{RexBindings, RexTree}
  alias Shuttle.Terminal.Rex, as: Backend
  @moduletag :tmp_dir
  @root "work/design/family"

  setup %{tmp_dir: dir} do
    Env.put_app_env(:os_type, {:unix, :darwin})
    Env.put_env("SHUTTLE_DATA_DIR", dir)
    Env.put_env("SHUTTLE_REX_BIN", "/bin/echo")
    Env.put_app_env(:fake_rex, start_supervised!({FakeRex, []}))
    Env.put_app_env(:rex_runner, FakeRex)
    Env.put_app_env(:paste_submit_delay_ms, 0)
    RexFamilyStore.write(dir, [@root, @root <> "/a", @root <> "/b"], [@root <> "/notes"])
    :ok
  end

  @tag :launch_attempt
  test "an ambiguous sibling-window launch reserves its name without a Rex binding", %{
    tmp_dir: dir
  } do
    Env.put_app_env(:terminal_backend, Backend)

    on_exit(fn ->
      for name <- ["attempt-sibling-a", "attempt-sibling-b"],
          path <- Path.wildcard(Path.join(System.tmp_dir!(), "shuttle-run-#{name}.*.sh")),
          do: File.rm(path)
    end)

    assert :ok =
             Shuttle.Terminal.launch(FakeRex, "attempt-sibling-a", dir, "sleep 60\n",
               fiber: @root <> "/a",
               launch_evidence: false
             )

    FakeRex.reply("session.new_window", {"request timed out", :timeout})

    assert {:error, {:unknown, _}} =
             Shuttle.Terminal.launch(FakeRex, "attempt-sibling-b", dir, "sleep 60\n",
               fiber: @root <> "/b",
               launch_evidence: false
             )

    assert {:ok, %{"bindings" => bindings}} = RexBindings.read()
    refute Map.has_key?(bindings, "attempt-sibling-b")
    FakeRex.reply("session.list_blocks", {"request timed out", :timeout})
    FakeRex.reply("ps", {"ps timed out", :timeout})

    assert {:error, {:launch_reserved, _}} =
             Shuttle.Terminal.launch(FakeRex, "attempt-sibling-b", dir, "duplicate",
               fiber: @root <> "/b",
               launch_evidence: false
             )

    assert Enum.count(FakeRex.calls(), fn {_, args, _} -> "session.new_window" in args end) == 1
  end

  defmodule CrashAfterWindowRunner do
    def cmd(command, args, opts) do
      result = FakeRex.cmd(command, args, opts)
      if "session.new_window" in args, do: throw(:crash_after_window)
      result
    end
  end

  @tag :owned_binding
  test "a reserved script proves ownership after Rex creates a sibling but before its binding lands",
       %{tmp_dir: dir} do
    Env.put_app_env(:terminal_backend, Backend)
    assert :ok = launch("a", @root <> "/a")

    assert catch_throw(
             Shuttle.Terminal.launch(CrashAfterWindowRunner, "b", dir, "sleep 300\n",
               fiber: @root <> "/b"
             )
           ) == :crash_after_window

    assert {:ok, %{"script" => script}} = Shuttle.Terminal.LaunchAttempts.get("b")
    assert {:ok, doc} = RexBindings.read()
    refute doc["bindings"]["b"]
    assert :present = Backend.probe(FakeRex, "b")
    assert {:error, _} = Backend.close(FakeRex, "b")
    sid = doc["bindings"]["a"]["session_id"]
    block = Enum.find(FakeRex.state().sessions[sid].blocks, &(&1["label"] == "b"))
    path = RexBindings.pid_path(block["block_id"])
    File.mkdir_p!(Path.dirname(path))
    File.write!(path, "812\n#{sid}\n#{block["block_id"]}\n")
    FakeRex.reply("ps", {"812 1 bash -l /tmp/shuttle-run-b.999.sh\n", 0})
    assert {:error, _} = Backend.close(FakeRex, "b")
    FakeRex.reply("ps", {"812 1 bash -l #{script}\n", 0})

    FakeRex.reply(
      "whoami",
      {Jason.encode!(Map.put(FakeRex.fixture("whoami"), "instance_id", "different-instance")), 0}
    )

    assert {:error, _} = Backend.close(FakeRex, "b")
    FakeRex.reply("whoami", {Jason.encode!(FakeRex.fixture("whoami")), 0})
    assert :present = Backend.probe(FakeRex, "b")
    assert {:ok, recovered} = RexBindings.read()
    refute recovered["bindings"]["b"]["recovered"]
    assert recovered["bindings"]["b"]["family"] == @root
    assert :ok = Backend.close(FakeRex, "b")
    assert :present = Backend.probe(FakeRex, "a")
  end

  test "a new server instance retires restored worker and viewer windows before recovery" do
    assert :ok = launch("a", @root <> "/a")
    assert {:ok, sid} = Backend.viewer(FakeRex, "b@remote", ["sleep", "60"], fiber: @root <> "/b")
    assert {:ok, before} = RexBindings.read()
    assert before["instance"] == FakeRex.fixture("whoami")["instance_id"]

    FakeRex.reply(
      "whoami",
      {Jason.encode!(Map.put(FakeRex.fixture("whoami"), "instance_id", "new-instance")), 0}
    )

    assert {:ok, []} = Backend.list(FakeRex)

    assert {:ok, %{"instance" => "new-instance", "bindings" => %{}, "viewers" => %{}}} =
             RexBindings.read()

    assert :absent = Backend.probe(FakeRex, "a")
    refute Map.has_key?(FakeRex.state().sessions, sid)
    assert :ok = launch("a", @root <> "/a")
    assert :present = Backend.probe(FakeRex, "a")
  end

  test "same instance preserves bindings and an unobservable server changes nothing" do
    assert :ok = launch("a", @root <> "/a")
    assert {:ok, before} = RexBindings.read()
    assert :ok = Backend.ensure_ready(FakeRex)
    assert {:ok, ["a"]} = Backend.list(FakeRex)
    assert {:ok, ^before} = RexBindings.read()
    FakeRex.reply("whoami", {"request timed out", :timeout})
    assert :ok = Backend.ensure_ready(FakeRex)
    assert {:error, :unknown} = Backend.list(FakeRex)
    assert {:ok, ^before} = RexBindings.read()
    assert :present = Backend.probe(FakeRex, "a")
  end

  test "a document without an instance adopts the live server without retiring windows" do
    assert :ok = launch("a", @root <> "/a")
    assert {:ok, before} = RexBindings.read()
    File.write!(RexBindings.path(), Jason.encode!(Map.delete(before, "instance")))
    assert :ok = Backend.ensure_ready(FakeRex)
    assert {:ok, ^before} = RexBindings.read()
    assert :present = Backend.probe(FakeRex, "a")
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

  test "per-worker session bindings remain addressable and do not join a new family session" do
    assert {:ok, %{"session_id" => old_sid, "initial_windows" => [window]}} =
             Rex.create(FakeRex, Backend.create_spec("old-worker", "/tmp", "worker.sh"))

    [bid] = window["block_ids"]

    old = %{
      "session_id" => old_sid,
      "block_id" => bid,
      "created_at" => "2026-10-29T00:00:00Z",
      "fiber" => @root
    }

    assert :ok = RexBindings.put("old-worker", old, FakeRex.fixture("whoami")["host_id"])
    assert :ok = launch("a", @root <> "/a")
    assert {:ok, doc} = RexBindings.read()
    refute doc["bindings"]["a"]["session_id"] == old_sid
    assert doc["bindings"]["old-worker"] == old
    assert :present = Backend.probe(FakeRex, "old-worker")
    assert :ok = Backend.paste(FakeRex, "old-worker", "still addressed by block")
    FakeRex.clients([%{"client_id" => "client:app", "info" => %{"kind" => "app"}}])
    assert :ok = Backend.reveal("old-worker", nil)
    {_, _, opts} = Enum.find(FakeRex.calls(), fn {_, args, _} -> "client.perform" in args end)

    assert Jason.decode!(opts[:input])["args"] == %{
             "session_id" => old_sid,
             "window_id" => window["window_id"]
           }

    assert :ok = Backend.close(FakeRex, "old-worker")
    assert :present = Backend.probe(FakeRex, "a")
    refute Map.has_key?(FakeRex.state().sessions, old_sid)
  end

  test "last-window cleanup and a new sibling launch share the family lock" do
    assert :ok = launch("a", @root <> "/a")
    parent = self()

    Env.put_app_env(:fake_rex_hook, fn
      "session.view" ->
        send(parent, {:cleanup_paused, self()})

        receive do
          :continue -> :ok
        after
          5_000 -> raise "cleanup barrier timed out"
        end

      _ ->
        :ok
    end)

    closing = Task.async(fn -> Backend.close(FakeRex, "a") end)
    assert_receive {:cleanup_paused, closer}
    launching = Task.async(fn -> launch("b", @root <> "/b") end)
    assert Task.yield(launching, 100) == nil
    send(closer, :continue)
    assert Task.await(closing) == :ok
    assert Task.await(launching) == :ok
    assert {:ok, [%{"session_id" => sid}]} = Rex.sessions(FakeRex)
    assert {:ok, %{"bindings" => %{"b" => %{"session_id" => ^sid}}}} = RexBindings.read()
  end

  test "a worker recovered by block label never closes or destroys its family session" do
    assert :ok = launch("a", @root <> "/a")
    assert :ok = launch("b", @root <> "/b")
    assert {:ok, doc} = RexBindings.read()
    a = doc["bindings"]["a"]
    assert :ok = RexBindings.delete("a", a)
    assert :present = Backend.probe(FakeRex, "a")
    assert {:ok, %{"bindings" => %{"a" => %{"recovered" => true}}}} = RexBindings.read()
    assert {:error, message} = Backend.close(FakeRex, "a")
    assert message =~ "recovered only by block label"
    assert :ok = Backend.close(FakeRex, "b")
    assert :ok = Backend.sweep(FakeRex)
    assert {:ok, [%{"session_id" => sid}]} = Rex.sessions(FakeRex)
    assert sid == a["session_id"]
    assert {:ok, [%{"window_id" => wid}]} = Rex.windows(FakeRex, sid)
    assert wid == a["window_id"]
  end

  defp launch(name, fiber), do: Backend.launch(FakeRex, name, "/tmp", "worker.sh", fiber: fiber)
end
