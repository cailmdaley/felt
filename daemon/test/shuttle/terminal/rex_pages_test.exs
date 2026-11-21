defmodule Shuttle.Terminal.RexPagesTest do
  use ExUnit.Case, async: true
  alias Shuttle.{Rex, Test.Env, Test.FakeRex, Test.RexFamilyStore}
  alias Shuttle.Terminal.{RexBindings, RexPages}
  alias Shuttle.Terminal.Rex, as: Backend
  @moduletag :tmp_dir
  @root "work/design/family"
  @uid "01JABCDEFGHJKMNPQRSTVWXYZ0"
  @a "a-#{@uid}-shuttle"
  @b "b-01JABCDEFGHJKMNPQRSTVWXYZ1-shuttle"

  setup %{tmp_dir: dir} do
    Env.put_app_env(:os_type, {:unix, :darwin})
    Env.put_env("SHUTTLE_DATA_DIR", dir)
    Env.put_env("SHUTTLE_REX_BIN", "/bin/echo")
    Env.put_app_env(:fake_rex, start_supervised!({FakeRex, []}))
    Env.put_app_env(:rex_runner, FakeRex)
    host = Path.join(dir, "host.json")
    Env.put_env("SHUTTLE_HOST_CONFIG_FILE", host)
    RexFamilyStore.write(dir, [@root, @root <> "/a", @root <> "/b"])
    %{host: host}
  end

  defp pages_on(%{host: host}),
    do: File.write!(host, ~s({"pages":{"enabled":true,"base":"http://hub.test:4000"}}))

  defp launch(name, fiber), do: Backend.launch(FakeRex, name, "/tmp", "worker.sh", fiber: fiber)

  defp request(method) do
    Enum.find_value(FakeRex.calls(), fn {_, args, opts} ->
      if method in args, do: {args, Jason.decode!(opts[:input])}
    end)
  end

  defp bound(name) do
    {:ok, doc} = RexBindings.read()
    doc["bindings"][name]
  end

  defp blocks(sid), do: FakeRex.state().sessions[sid].blocks
  defp pages(sid), do: Enum.filter(blocks(sid), &RexPages.page?/1)

  defp mutations(since) do
    for {_, args, _} <- Enum.drop(FakeRex.calls(), since),
        method <- ["session.new_split", "block.close", "session.close_window"],
        method in args,
        do: method
  end

  test "with pages off the launch spec is the single worker block it has always been" do
    assert :ok = launch(@a, @root <> "/a")
    {args, spec} = request("session.create")
    assert ["--autostart=false", "--timeout", "5s" | _] = args

    assert spec == %{
             "label" => "design/family",
             "initial_windows" => [
               %{
                 "window_label" => "└ a",
                 "layout" => %{
                   "block" => %{
                     "flavor" => "com.superlogical.terminal.shell",
                     "label" => @a,
                     "options" => %{
                       "shell" => "none",
                       "command" => ["bash", "-l", "worker.sh"],
                       "cwd" => "/tmp",
                       "size" => %{"columns" => 160, "rows" => 48},
                       "exit" => %{"on_completion" => true, "quick_exit_threshold_ms" => 0}
                     }
                   }
                 }
               }
             ]
           }

    refute Map.has_key?(bound(@a), "page_block_id")
    calls = FakeRex.calls()
    assert :ok = RexPages.reconcile(FakeRex)
    assert FakeRex.calls() == calls
  end

  test "with pages on a launch splits its window into the worker and its page", ctx do
    pages_on(ctx)
    assert :ok = launch(@a, @root <> "/a")
    {args, spec} = request("session.create")
    assert ["--autostart=false", "--timeout", "15s" | _] = args
    [window] = spec["initial_windows"]

    assert %{
             "split" => %{
               "direction" => "horizontal",
               "before" => %{"block" => %{"label" => @a}},
               "after" => %{"block" => page}
             }
           } = window["layout"]

    holder = Path.join([ctx.tmp_dir, "rex", "page-holder.sh"])
    url = "http://hub.test:4000/thread?f=#{@uid}@#{Shuttle.Poller.own_host_id()}&in=rex"

    assert page == %{
             "flavor" => "com.superlogical.terminal.shell",
             "label" => "rexweb shuttle",
             "options" => %{
               "shell" => "none",
               "command" => ["sh", holder, url],
               "exit" => %{"on_completion" => false}
             }
           }

    assert File.read!(holder) =~ ~s(printf '\\033]2;rexweb %s\\007)

    b = bound(@a)
    [chat, page_block] = blocks(b["session_id"])
    assert chat["block_id"] == b["block_id"]
    assert page_block["block_id"] == b["page_block_id"]
    assert page_block["window_id"] == b["window_id"]

    calls = length(FakeRex.calls())
    assert :ok = RexPages.reconcile(FakeRex)
    assert mutations(calls) == []
    assert bound(@a) == b
  end

  test "a resumed conversation's page shows its fiber's uid", ctx do
    pages_on(ctx)
    file = Path.join([ctx.tmp_dir, "family-store", ".felt", @root, "a", "a.md"])
    File.write!(file, "---\nname: a\nuid: #{@uid}\ntags: [constitution]\n---\n")
    assert :ok = launch("resume-1234", @root <> "/a")
    {_, spec} = request("session.create")
    [window] = spec["initial_windows"]
    [_, _, url] = window["layout"]["split"]["after"]["block"]["options"]["command"]
    assert url =~ "f=#{@uid}@"
  end

  test "a worker claimed in a human's own session never gets a page, before or after release",
       ctx do
    pages_on(ctx)
    human = %{"block_id" => "block:human", "label" => "human", "window_id" => "window:human"}

    FakeRex.sessions(%{
      "session:human" => %{
        label: "human",
        blocks: [human],
        windows: [%{"window_id" => "window:human", "label" => "human"}]
      }
    })

    assert :ok = Backend.rename(FakeRex, "session:human", @a)
    assert %{"session_owned" => false} = b = bound(@a)
    refute Map.has_key?(b, "family")

    calls = length(FakeRex.calls())
    assert :ok = RexPages.reconcile(FakeRex)
    assert :ok = Backend.release(FakeRex, @a, "leaf")
    assert :ok = RexPages.reconcile(FakeRex)
    assert mutations(calls) == []
    assert pages("session:human") == []

    assert [%{"block_id" => "block:human", "window_id" => "window:human"}] =
             blocks("session:human")
  end

  test "a page's fiber uid is resolved once, so a split that keeps failing does not reread the tree",
       ctx do
    file = Path.join([ctx.tmp_dir, "family-store", ".felt", @root, "a", "a.md"])
    File.write!(file, "---\nname: a\nuid: #{@uid}\ntags: [constitution]\n---\n")
    assert :ok = launch("resume-1234", @root <> "/a")
    pages_on(ctx)
    FakeRex.reply("session.new_split", {"split failed", 1})
    assert {:error, [{_, _}]} = RexPages.reconcile(FakeRex)
    assert bound("resume-1234")["page_uid"] == @uid

    File.write!(file, "---\nname: a\ntags: [constitution]\n---\n")
    FakeRex.clear_reply("session.new_split")
    assert :ok = RexPages.reconcile(FakeRex)
    {_, split} = request("session.new_split")
    [_, _, url] = split["layout"]["block"]["options"]["command"]
    assert url =~ "f=#{@uid}@"
    assert is_binary(bound("resume-1234")["page_block_id"])
  end

  test "an invalid pages setting is reported by reconcile and leaves pages off", ctx do
    assert :ok = launch(@a, @root <> "/a")
    File.write!(ctx.host, ~s({"pages":{"enabled":"yes"}}))
    calls = FakeRex.calls()
    assert {:error, [message]} = RexPages.reconcile(FakeRex)
    assert message =~ "pages disabled"
    assert FakeRex.calls() == calls
  end

  test "reconcile gives a worker launched with pages off its page exactly once", ctx do
    assert :ok = launch(@a, @root <> "/a")
    assert :ok = launch(@b, @root <> "/b")
    pages_on(ctx)
    assert :ok = RexPages.reconcile(FakeRex)
    assert mutations(0) == ["session.new_split", "session.new_split"]
    {args, split} = request("session.new_split")
    assert ["--autostart=false", "--timeout", "60s" | _] = args
    a = bound(@a)

    assert %{
             "anchor_id" => anchor,
             "direction" => "horizontal",
             "side" => "after",
             "focus" => false,
             "layout" => %{"block" => %{"label" => "rexweb shuttle"}}
           } = split

    assert anchor == a["block_id"]
    sid = a["session_id"]
    assert length(pages(sid)) == 2

    for name <- [@a, @b] do
      b = bound(name)
      page = Enum.find(blocks(sid), &(&1["block_id"] == b["page_block_id"]))
      assert page["window_id"] == b["window_id"]
    end

    calls = length(FakeRex.calls())
    assert :ok = RexPages.reconcile(FakeRex)
    assert mutations(calls) == []
  end

  test "a page no worker records is closed: a late duplicate or one left behind", ctx do
    pages_on(ctx)
    assert :ok = launch(@a, @root <> "/a")
    a = bound(@a)
    sid = a["session_id"]

    stray = %{
      "block_id" => "block:late",
      "label" => "rexweb shuttle",
      "window_id" => a["window_id"]
    }

    FakeRex.sessions(
      Map.update!(FakeRex.state().sessions, sid, &%{&1 | blocks: &1.blocks ++ [stray]})
    )

    assert :ok = RexPages.reconcile(FakeRex)
    assert Enum.map(pages(sid), & &1["block_id"]) == [a["page_block_id"]]
    assert bound(@a) == a
  end

  test "a page the human closed stays closed until the worker's next launch", ctx do
    pages_on(ctx)
    assert :ok = launch(@a, @root <> "/a")
    a = bound(@a)
    sid = a["session_id"]

    assert {:ok, _} =
             Rex.call(FakeRex, "block.close", %{"block_id" => a["page_block_id"]}, session: sid)

    assert :ok = RexPages.reconcile(FakeRex)
    assert bound(@a)["page_closed"] == true
    refute Map.has_key?(bound(@a), "page_block_id")
    calls = length(FakeRex.calls())
    assert :ok = RexPages.reconcile(FakeRex)
    assert mutations(calls) == []
    assert pages(sid) == []

    assert :ok = Backend.close(FakeRex, @a)
    assert :ok = launch(@a, @root <> "/a")
    refute bound(@a)["page_closed"]
    assert [_] = pages(bound(@a)["session_id"])
  end

  test "hiding a worker closes its page and placing it back brings a page", ctx do
    pages_on(ctx)
    assert :ok = launch(@a, @root <> "/a")
    assert :ok = launch(@b, @root <> "/b")
    a = bound(@a)
    sid = a["session_id"]

    assert {:ok, _} = Backend.hide(FakeRex, sid, a["block_id"])
    refute Enum.any?(blocks(sid), &(&1["block_id"] == a["page_block_id"]))
    refute Map.has_key?(bound(@a), "page_block_id")
    refute bound(@a)["page_closed"]
    assert {:ok, windows} = Rex.windows(FakeRex, sid)
    refute Enum.any?(windows, &(&1["window_id"] == a["window_id"]))

    calls = length(FakeRex.calls())
    assert :ok = RexPages.reconcile(FakeRex)
    assert mutations(calls) == []

    chat = Enum.find(blocks(sid), &(&1["block_id"] == a["block_id"]))
    assert {:ok, wid} = Backend.place(FakeRex, sid, chat)
    assert :ok = RexPages.reconcile(FakeRex)
    page = bound(@a)["page_block_id"]
    assert %{"window_id" => ^wid} = Enum.find(blocks(sid), &(&1["block_id"] == page))
  end

  test "a new server instance retires the worker's window with its page, wherever the worker sits",
       ctx do
    pages_on(ctx)
    assert :ok = launch(@a, @root <> "/a")
    assert :ok = launch(@b, @root <> "/b")
    a = bound(@a)
    sid = a["session_id"]
    assert {:ok, _} = Backend.hide(FakeRex, sid, a["block_id"])
    chat = Enum.find(blocks(sid), &(&1["block_id"] == a["block_id"]))
    assert {:ok, _} = Backend.place(FakeRex, sid, chat)
    assert :ok = RexPages.reconcile(FakeRex)
    assert length(pages(sid)) == 2

    FakeRex.reply(
      "whoami",
      {Jason.encode!(Map.put(FakeRex.fixture("whoami"), "instance_id", "new-instance")), 0}
    )

    assert {:ok, []} = Backend.list(FakeRex)
    assert {:ok, %{"bindings" => %{}}} = RexBindings.read()
    refute Map.has_key?(FakeRex.state().sessions, sid)
  end

  test "an unrecorded page left in a family session after a restart is closed", ctx do
    pages_on(ctx)
    assert :ok = launch(@a, @root <> "/a")
    a = bound(@a)
    sid = a["session_id"]
    shell = %{"block_id" => "block:shell", "label" => "shell", "window_id" => "window:human"}

    restored = %{
      "block_id" => "block:old",
      "label" => "rexweb shuttle",
      "window_id" => "window:human"
    }

    FakeRex.sessions(
      Map.update!(FakeRex.state().sessions, sid, fn s ->
        %{
          s
          | blocks: s.blocks ++ [shell, restored],
            windows: s.windows ++ [%{"window_id" => "window:human", "label" => "human"}]
        }
      end)
    )

    assert :ok = RexPages.reconcile(FakeRex)
    assert Enum.map(pages(sid), & &1["block_id"]) == [a["page_block_id"]]
    assert Enum.any?(blocks(sid), &(&1["block_id"] == "block:shell"))
  end

  test "turning pages off closes the recorded pages", ctx do
    pages_on(ctx)
    assert :ok = launch(@a, @root <> "/a")
    sid = bound(@a)["session_id"]
    File.write!(ctx.host, ~s({"pages":{"enabled":false}}))
    assert :ok = RexPages.reconcile(FakeRex)
    assert pages(sid) == []
    refute Map.has_key?(bound(@a), "page_block_id")
    assert :present = Backend.probe(FakeRex, @a)
  end

  test "a worker whose block ends retires its window with the page", ctx do
    pages_on(ctx)
    assert :ok = launch(@a, @root <> "/a")
    assert :ok = launch(@b, @root <> "/b")
    a = bound(@a)
    sid = a["session_id"]

    assert {:ok, _} =
             Rex.call(FakeRex, "block.close", %{"block_id" => a["block_id"]}, session: sid)

    assert :absent = Backend.probe(FakeRex, @a)
    refute Enum.any?(blocks(sid), &(&1["window_id"] == a["window_id"]))
    assert :present = Backend.probe(FakeRex, @b)
  end

  test "recovery by label and by session never takes a page for the worker", ctx do
    pages_on(ctx)
    assert :ok = launch(@a, @root <> "/a")
    a = bound(@a)
    assert :ok = RexBindings.delete(@a, a)
    assert {:ok, %{"block_id" => bid}} = Backend.address(FakeRex, a["session_id"])
    assert bid == a["block_id"]

    assert :present = Backend.probe(FakeRex, @a)
    assert bound(@a)["block_id"] == a["block_id"]
  end
end
