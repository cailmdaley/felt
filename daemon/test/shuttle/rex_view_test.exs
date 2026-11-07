defmodule Shuttle.RexViewTest do
  use ExUnit.Case, async: true
  alias Shuttle.{Opener, RexView, Test.Env, Test.FakeRex}
  alias Shuttle.Terminal.{Rex, RexBindings}
  @moduletag :tmp_dir

  @hub "hub-01JABCDEFGHJKMNPQRSTVWXYZ-shuttle"
  @kid "kid-01JABCDEFGHJKMNPQRSTVWXY0-shuttle"

  setup %{tmp_dir: dir} do
    Env.put_env("SHUTTLE_DATA_DIR", dir)
    Env.put_env("SHUTTLE_REX_BIN", "/bin/echo")
    Env.put_app_env(:fake_rex, start_supervised!({FakeRex, []}))
    Env.put_app_env(:rex_runner, FakeRex)
    Env.put_app_env(:terminal_backend, Rex)
    FakeRex.clients([%{"client_id" => "client:app", "info" => %{"kind" => "app"}}])
    :ok
  end

  # Two workers of one family share a session; the human's shell is a third window.
  defp family do
    assert :ok = Rex.launch(FakeRex, @hub, "/tmp", "worker.sh", [])
    [{sid, session}] = Map.to_list(FakeRex.state().sessions)
    kid = %{"block_id" => "block:kid", "label" => @kid, "window_id" => "window:kid"}
    shell = %{"block_id" => "block:shell", "label" => "shell", "window_id" => "window:shell"}
    windows = for w <- ["window:kid", "window:shell"], do: %{"window_id" => w, "label" => w}

    FakeRex.sessions(%{
      sid => %{
        session
        | blocks: session.blocks ++ [kid, shell],
          windows: session.windows ++ windows
      }
    })

    {:ok, doc} = RexBindings.read()

    kid_binding =
      Map.merge(doc["bindings"][@hub], %{"block_id" => "block:kid", "window_id" => "window:kid"})

    :ok = RexBindings.put(@kid, kid_binding, doc["server"])
    sid
  end

  defp placed(sid),
    do: for(b <- FakeRex.state().sessions[sid].blocks, b["window_id"], do: b["label"])

  defp show(sid, label) do
    wid = Enum.find(FakeRex.state().sessions[sid].blocks, &(&1["label"] == label))["window_id"]
    FakeRex.sessions(Map.update!(FakeRex.state().sessions, sid, &Map.put(&1, :active, wid)))
  end

  test "a window of ours behind the one its session shows leaves the view after the grace, and its program runs on" do
    sid = family()
    show(sid, @hub)
    assert {:ok, seen} = RexView.sweep(FakeRex, %{}, now: 0, grace_ms: 120_000)
    assert Map.keys(seen) |> length() == 1
    assert placed(sid) |> Enum.sort() == Enum.sort([@hub, @kid, "shell"])

    assert {:ok, %{}} = RexView.sweep(FakeRex, seen, now: 120_000, grace_ms: 120_000)
    assert Enum.sort(placed(sid)) == Enum.sort([@hub, "shell"])
    assert Enum.any?(FakeRex.state().sessions[sid].blocks, &(&1["label"] == @kid))
    assert requests("block.close") == []
    assert requests("session.close_window") == []
  end

  test "coming back to a window before the grace keeps it, and the shown window and a human's never go" do
    sid = family()
    show(sid, @hub)
    {:ok, seen} = RexView.sweep(FakeRex, %{}, now: 0, grace_ms: 120_000)
    show(sid, @kid)
    assert {:ok, again} = RexView.sweep(FakeRex, seen, now: 60_000, grace_ms: 120_000)
    assert Map.values(again) == [60_000]
    assert Enum.sort(placed(sid)) == Enum.sort([@hub, @kid, "shell"])
    assert {:ok, _} = RexView.sweep(FakeRex, %{}, now: 0, grace_ms: 0)
    assert Enum.sort(placed(sid)) == Enum.sort([@kid, "shell"])
  end

  test "a click on a hidden worker puts its own window back, and the next sweep hides the one left" do
    sid = family()
    show(sid, @hub)
    {:ok, _} = RexView.sweep(FakeRex, %{}, now: 0, grace_ms: 0)
    refute @kid in placed(sid)
    assert {:ok, true} = Opener.select(@kid)
    assert Enum.sort(placed(sid)) == Enum.sort([@hub, @kid, "shell"])
    show(sid, @kid)
    {:ok, _} = RexView.sweep(FakeRex, %{}, now: 0, grace_ms: 0)
    assert Enum.sort(placed(sid)) == Enum.sort([@kid, "shell"])
  end

  test "a worker with a raised ask stays in view, and one that raises an ask while hidden comes back" do
    sid = family()
    show(sid, @hub)
    asking = MapSet.new([@kid])
    {:ok, _} = RexView.sweep(FakeRex, %{}, now: 0, grace_ms: 0, asking: asking)
    assert @kid in placed(sid)
    {:ok, _} = RexView.sweep(FakeRex, %{}, now: 0, grace_ms: 0)
    refute @kid in placed(sid)
    {:ok, _} = RexView.sweep(FakeRex, %{}, now: 0, grace_ms: 0, asking: asking)
    assert @kid in placed(sid)
  end

  test "a raised ask is a question in an active fiber, a harness prompt, or a block; waiting is not" do
    ask = %{"status" => "active", "shuttle" => %{"ask" => %{"text" => "Which?", "at" => "now"}}}
    plain = %{"status" => "active", "shuttle" => %{}}
    assert RexView.raised?(ask, %{phase: "waiting"})
    refute RexView.raised?(%{ask | "status" => "closed"}, %{phase: "waiting"})

    for phase <- ["attention", "blocked", "identity_failed"],
        do: assert(RexView.raised?(plain, %{phase: phase}))

    assert RexView.raised?(plain, %{state: "blocked"})
    assert RexView.raised?(plain, %{launch_error: "no such agent"})
    refute RexView.raised?(plain, %{phase: "waiting", state: "running", launch_error: nil})
    refute RexView.raised?(plain, %{phase: "working"})
  end

  test "a resumed conversation's pane names its fiber, while a worker's keeps its recovery index" do
    resume = "resume-2bea56c2-31a7-4537-a2ac-db77c58cde24"
    assert Rex.block_label(resume, "work/positions/career-futures") == "career-futures"
    assert Rex.block_label(resume, nil) == resume
    assert Rex.block_label(@hub, "hub") == @hub

    spec = Rex.create_spec(resume, "/tmp", "resume.sh", fiber: "work/positions/career-futures")
    assert spec["label"] == "career-futures"

    assert get_in(spec, ["initial_windows", Access.at(0), "layout", "block", "label"]) ==
             "career-futures"
  end

  defp requests(method) do
    for {_bin, args, opts} <- FakeRex.calls(), method in args, do: Jason.decode!(opts[:input])
  end
end
