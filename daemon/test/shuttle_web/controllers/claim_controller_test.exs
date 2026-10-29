defmodule ShuttleWeb.ClaimControllerTest do
  use ExUnit.Case, async: true
  import Shuttle.Test.ApiConn
  import Phoenix.ConnTest

  alias Shuttle.Test.{Env, FakeRex, FeltStoreRunner, FiberUid, ForwardStub, StubPostClient}
  alias Shuttle.Terminal.RexBindings
  import Shuttle.Test.PollerHelpers

  defmodule RexRunner do
    def cmd(command, args, opts) when command in ["shuttle", "felt"],
      do: FeltStoreRunner.cmd(command, args, opts)

    def cmd(command, args, opts), do: FakeRex.cmd(command, args, opts)
  end

  @endpoint ShuttleWeb.Endpoint

  describe "Rex native claims" do
    setup do
      FeltStoreRunner.start!()
      root = FeltStoreRunner.felt_root()
      on_exit(fn -> File.rm_rf(root) end)
      Env.put_env("SHUTTLE_DATA_DIR", Path.join(root, "data"))
      Env.put_env("SHUTTLE_STORES", root)
      Env.delete_env("SHUTTLE_SESSIONS_FILE")
      Env.put_env("SHUTTLE_REX_BIN", "/bin/echo")
      tools = Path.join(root, "tools")
      File.mkdir_p!(tools)
      File.write!(Path.join(tools, "tmux"), "#!/bin/sh\nexit 1\n")
      File.chmod!(Path.join(tools, "tmux"), 0o755)
      Env.put_env("PATH", tools <> ":" <> Shuttle.Env.get("PATH"))
      Env.put_app_env(:terminal_backend, Shuttle.Terminal.Rex)
      Env.put_app_env(:fake_rex, start_supervised!({FakeRex, []}))
      FeltStoreRunner.set_fiber("claimed", make_fiber("claimed"))
      FeltStoreRunner.set_shuttle("claimed", "kind: oneshot\nagent: claude-sonnet\n", "open")

      {:ok, poller} =
        start_poller!(
          runner: RexRunner,
          own_host_id: "test-host",
          felt_stores: [root],
          poll_interval_ms: 600_000,
          heartbeat_interval_ms: 600_000
        )

      await_boot_cycle!(poller)
      sid = FakeRex.fixture("session_create")["session_id"]
      [window] = FakeRex.fixture("session_create")["initial_windows"]
      [bid] = window["block_ids"]

      FakeRex.sessions(%{
        sid => %{label: "probe-human", blocks: [%{"block_id" => bid, "label" => "human"}]}
      })

      %{poller: poller, sid: sid, bid: bid, canonical: FiberUid.session("claimed")}
    end

    test "session refs become canonical bindings and native retries keep the watcher", ctx do
      body = %{
        fiber_id: "claimed",
        tmux_session: ctx.sid,
        tmux_pane: ctx.bid,
        session_uuid: "rex-native-claim"
      }

      conn = post(api_conn(), "/api/v1/claim", Jason.encode!(body))
      assert conn.status == 200, conn.resp_body
      assert %{"claimed" => true, "tmux_session" => name} = Jason.decode!(conn.resp_body)
      assert name == ctx.canonical
      assert FakeRex.state().sessions[ctx.sid].label == name

      assert {:ok, %{"bindings" => %{^name => %{"session_id" => sid, "block_id" => bid}}}} =
               RexBindings.read()

      assert {sid, bid} == {ctx.sid, ctx.bid}
      before = Shuttle.Poller.worker_status(ctx.poller, "claimed")
      renamed = Map.put(FakeRex.state().sessions[ctx.sid], :label, "human display")
      FakeRex.sessions(%{ctx.sid => renamed})
      retry = post(api_conn(), "/api/v1/claim", Jason.encode!(body))
      assert retry.status == 200, retry.resp_body
      assert Shuttle.Poller.worker_status(ctx.poller, "claimed").pid == before.pid
      assert FakeRex.state().sessions[ctx.sid].label == "human display"
      # The same native session with a different block is not the worker.
      session = FakeRex.state().sessions[ctx.sid]

      FakeRex.sessions(%{
        ctx.sid => %{
          session
          | blocks: session.blocks ++ [%{"block_id" => "block:human", "label" => "human"}]
        }
      })

      wrong = post(api_conn(), "/api/v1/claim", Jason.encode!(%{body | tmux_pane: "block:human"}))
      assert wrong.status == 409
    end

    test "multi-block claim selects the supplied block and rejects a block from another session",
         ctx do
      session = FakeRex.state().sessions[ctx.sid]

      FakeRex.sessions(%{
        ctx.sid => %{
          session
          | blocks: session.blocks ++ [%{"block_id" => "block:human", "label" => "human"}]
        },
        "session:other" => %{
          label: "other",
          blocks: [%{"block_id" => "block:other", "label" => "other"}]
        }
      })

      body = %{fiber_id: "claimed", tmux_session: ctx.sid, tmux_pane: "block:other"}
      wrong = post(api_conn(), "/api/v1/claim", Jason.encode!(body))
      assert wrong.status == 500
      assert FakeRex.state().sessions[ctx.sid].label == "probe-human"
      good = post(api_conn(), "/api/v1/claim", Jason.encode!(%{body | tmux_pane: ctx.bid}))
      assert good.status == 200, good.resp_body

      assert Enum.find(FakeRex.state().sessions[ctx.sid].blocks, &(&1["block_id"] == ctx.bid))[
               "label"
             ] == ctx.canonical

      assert Enum.find(
               FakeRex.state().sessions[ctx.sid].blocks,
               &(&1["block_id"] == "block:human")
             )["label"] == "human"
    end

    test "a sibling block cannot displace the same session's claimed live worker", ctx do
      body = %{fiber_id: "claimed", tmux_session: ctx.sid, tmux_pane: ctx.bid}
      assert post(api_conn(), "/api/v1/claim", Jason.encode!(body)).status == 200
      FeltStoreRunner.set_fiber("sibling", make_fiber("sibling"))
      FeltStoreRunner.set_shuttle("sibling", "kind: oneshot\nagent: claude-sonnet\n", "open")
      session = FakeRex.state().sessions[ctx.sid]

      FakeRex.sessions(%{
        ctx.sid => %{
          session
          | blocks: session.blocks ++ [%{"block_id" => "block:sibling", "label" => "human"}]
        }
      })

      {:ok, original} = RexBindings.read()

      sibling =
        post(
          api_conn(),
          "/api/v1/claim",
          Jason.encode!(%{fiber_id: "sibling", tmux_session: ctx.sid, tmux_pane: "block:sibling"})
        )

      assert sibling.status == 500
      assert RexBindings.read() == {:ok, original}
      assert Shuttle.Terminal.Rex.probe(RexRunner, ctx.canonical) == :present
      assert Shuttle.Poller.worker_status(ctx.poller, "claimed").session == ctx.canonical
      assert Shuttle.Poller.worker_status(ctx.poller, "sibling") == nil
      refute Enum.any?(FakeRex.calls(), fn {_, args, _} -> "session.destroy" in args end)
    end

    test "block references are claimable and canonical bindings recover untracked claims", ctx do
      assert :ok = Shuttle.Terminal.Rex.rename(RexRunner, ctx.bid, ctx.canonical)
      body = %{fiber_id: "claimed", tmux_session: ctx.bid, session_uuid: "block-claim"}
      conn = post(api_conn(), "/api/v1/claim", Jason.encode!(body))
      assert conn.status == 200, conn.resp_body
      assert Shuttle.Poller.worker_status(ctx.poller, "claimed").session == ctx.canonical
      assert post(api_conn(), "/api/v1/claim", Jason.encode!(body)).status == 200
    end

    test "native claim cannot take a canonical name held by tmux", ctx do
      FakeRex.reply("tmux", {"", 0})

      conn =
        post(
          api_conn(),
          "/api/v1/claim",
          Jason.encode!(%{fiber_id: "claimed", tmux_session: ctx.sid, tmux_pane: ctx.bid})
        )

      assert conn.status == 409
      assert FakeRex.state().sessions[ctx.sid].label == "probe-human"
      assert Shuttle.Poller.worker_status(ctx.poller, "claimed") == nil
    end

    test "native claim refuses a canonical name held by another live Rex session", ctx do
      FakeRex.sessions(
        Map.put(FakeRex.state().sessions, "session:other", %{
          label: ctx.canonical,
          blocks: [%{"block_id" => "block:other", "label" => ctx.canonical}]
        })
      )

      conn =
        post(
          api_conn(),
          "/api/v1/claim",
          Jason.encode!(%{fiber_id: "claimed", tmux_session: ctx.sid, tmux_pane: ctx.bid})
        )

      assert conn.status == 500
      assert FakeRex.state().sessions[ctx.sid].label == "probe-human"
      assert Shuttle.Poller.worker_status(ctx.poller, "claimed") == nil
    end
  end

  test "POST /api/v1/claim without fiber_id is a 400" do
    conn =
      api_conn()
      |> post("/api/v1/claim", Jason.encode!(%{tmux_session: "capture-x"}))

    assert conn.status == 400
    assert Jason.decode!(conn.resp_body)["error"] =~ "fiber_id"
  end

  test "POST /api/v1/claim without tmux_session is a 400" do
    conn =
      api_conn()
      |> post("/api/v1/claim", Jason.encode!(%{fiber_id: "tests/x"}))

    assert conn.status == 400
    assert Jason.decode!(conn.resp_body)["error"] =~ "tmux_session"
  end

  test "forwards a remote-origin claim to the owning daemon, origin stripped, relaying its response" do
    ForwardStub.stub_forward(
      "candide",
      "http://localhost:4001",
      {:ok, 200,
       Jason.encode!(%{
         "claimed" => true,
         "fiber_id" => "tests/x",
         "tmux_session" => "capture-x"
       })},
      StubPostClient
    )

    conn =
      api_conn()
      |> post(
        "/api/v1/claim",
        Jason.encode!(%{
          fiber_id: "tests/x",
          tmux_session: "capture-x",
          origin: "candide"
        })
      )

    # The owning daemon's response is relayed verbatim (status + JSON body).
    assert conn.status == 200
    assert %{"claimed" => true, "fiber_id" => "tests/x"} = Jason.decode!(conn.resp_body)

    # Forwarded to the owning remote's identical /claim with origin stripped —
    # only the owner can see the tmux session and run the watcher.
    last = StubPostClient.last()
    assert last.url == "http://localhost:4001/api/v1/claim"
    forwarded = Jason.decode!(last.body)
    refute Map.has_key?(forwarded, "origin")
    assert forwarded["fiber_id"] == "tests/x"
    assert forwarded["tmux_session"] == "capture-x"
  end
end
