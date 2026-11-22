defmodule Shuttle.Terminal.RexLayoutTest do
  use ExUnit.Case, async: true
  use ExUnitProperties

  alias Shuttle.{Rex, Test.Env, Test.FakeRex, Test.RexFamilyStore}
  alias Shuttle.Terminal.{RexBindings, RexLayout, RexPages}
  alias Shuttle.Terminal.Rex, as: Backend

  @moduletag :tmp_dir

  @root "work/design/family"
  @uid_a "01JABCDEFGHJKMNPQRSTVWXYZ0"
  @uid_b "01JABCDEFGHJKMNPQRSTVWXYZ1"
  @uid_c "01JABCDEFGHJKMNPQRSTVWXYZ2"
  @name_a "a-#{@uid_a}-shuttle"
  @name_b "b-#{@uid_b}-shuttle"

  describe "desired/1 place lifetime rule" do
    @now ~U[2026-11-21 12:00:00Z]

    defp fiber(uid, slug, extra) do
      Map.merge(
        %{
          "id" => uid,
          "uid" => uid,
          "slug" => slug,
          "status" => "open",
          "shuttle" => %{"host" => "host-a", "kind" => "oneshot"}
        },
        extra
      )
    end

    test "grants places for live workers, asks, awaiting_review, and recent asked_at; never tempered or discarded" do
      fibers = [
        fiber(@uid_a, @root, %{"status" => "active"}),
        fiber("u-ask", @root <> "/ask", %{
          "status" => "active",
          "shuttle" => %{"host" => "host-a", "kind" => "oneshot", "ask" => %{"text" => "Which?"}}
        }),
        fiber("u-review", @root <> "/review", %{"status" => "closed"}),
        fiber("u-recent", @root <> "/recent", %{"status" => "open"}),
        fiber("u-expired", @root <> "/expired", %{"status" => "open"}),
        fiber("u-tempered", @root <> "/tempered", %{"status" => "closed", "tempered" => true}),
        fiber("u-discarded", @root <> "/discarded", %{"status" => "closed", "tempered" => false})
      ]

      bindings = %{
        @name_a => %{
          "session_id" => "session:1",
          "window_id" => "window:1",
          "block_id" => "block:1",
          "family" => @root,
          "fiber" => @root
        }
      }

      recent_iso = DateTime.add(@now, -3_600, :second) |> DateTime.to_iso8601()
      expired_iso = DateTime.add(@now, -90_000, :second) |> DateTime.to_iso8601()

      places = %{
        "u-recent" => %{"asked_at" => recent_iso, "family" => @root, "fiber" => @root <> "/recent"},
        "u-expired" => %{"asked_at" => expired_iso, "family" => @root, "fiber" => @root <> "/expired"},
        "u-tempered" => %{"asked_at" => recent_iso, "family" => @root, "fiber" => @root <> "/tempered"},
        "u-discarded" => %{"asked_at" => recent_iso, "family" => @root, "fiber" => @root <> "/discarded"}
      }

      des =
        RexLayout.desired(%{
          fibers: fibers,
          bindings: bindings,
          places: places,
          now: @now,
          pages_base: "http://hub.test:4000",
          own_host_id: "host-a"
        })

      uids = Map.keys(des.places_by_uid) |> Enum.sort()
      assert uids == Enum.sort([@uid_a, "u-ask", "u-review", "u-recent"])
      refute Map.has_key?(des.places_by_uid, "u-expired")
      refute Map.has_key?(des.places_by_uid, "u-tempered")
      refute Map.has_key?(des.places_by_uid, "u-discarded")
    end

    test "never re-adds a tempered fiber from bindings, and ignores bindings dead in observed sessions" do
      fibers = [
        fiber(@uid_a, @root <> "/a", %{"status" => "closed", "tempered" => true}),
        fiber(@uid_b, @root <> "/b", %{"status" => "open"})
      ]

      bindings = %{
        @name_a => %{
          "session_id" => "session:1",
          "window_id" => "window:1",
          "block_id" => "block:a",
          "family" => @root,
          "fiber" => @root <> "/a"
        },
        @name_b => %{
          "session_id" => "session:1",
          "window_id" => "window:2",
          "block_id" => "block:dead",
          "family" => @root,
          "fiber" => @root <> "/b"
        }
      }

      sessions = %{
        "session:1" => %{
          session_id: "session:1",
          label: "design/family",
          active_window_id: "window:1",
          windows: [%{window_id: "window:1", label: "└ a", block_ids: ["block:a"]}],
          blocks: [%{block_id: "block:a", label: @name_a, window_id: "window:1", placement: "placed"}]
        }
      }

      des =
        RexLayout.desired(%{
          fibers: fibers,
          bindings: bindings,
          places: %{},
          sessions: sessions,
          now: @now,
          pages_base: "http://hub.test:4000",
          own_host_id: "host-a"
        })

      assert des.places_by_uid == %{}
    end

    test "plan/2 never closes the last remaining stray page block in a protected active window" do
      obs = %{
        sessions: %{
          "session:fam" => %{
            session_id: "session:fam",
            label: "design/family",
            active_window_id: "window:active",
            windows: [%{window_id: "window:active", label: "a", block_ids: ["block:p1", "block:p2"]}],
            blocks: [
              %{block_id: "block:p1", label: RexPages.label(), window_id: "window:active", placement: "placed"},
              %{block_id: "block:p2", label: RexPages.label(), window_id: "window:active", placement: "placed"}
            ]
          }
        },
        focused_sessions: MapSet.new(["session:fam"]),
        families: %{@root => "session:fam"},
        bindings: %{},
        viewers: %{},
        places: %{}
      }

      des = %{families: %{}, places_by_uid: %{}}
      actions = RexLayout.plan(obs, des)
      closed_ids = for {:close_block, %{block_id: bid}} <- actions, do: bid
      assert length(closed_ids) == 1
      after_obs = RexLayout.apply_pure(obs, actions)
      assert length(after_obs.sessions["session:fam"].windows) == 1
      assert length(after_obs.sessions["session:fam"].blocks) == 1
    end
  end

  describe "plan/2 properties" do
    defp scenario_gen do
      gen all(
            # 1..3 fibers in the family
            fiber_states <-
              StreamData.fixed_map(%{
                @uid_a => StreamData.member_of([:live, :waiting, :recent, :expired, :tempered, :discarded, :absent]),
                @uid_b => StreamData.member_of([:live, :waiting, :recent, :expired, :tempered, :absent]),
                @uid_c => StreamData.member_of([:waiting, :recent, :expired, :absent])
              }),
            has_session? <- StreamData.boolean(),
            focused_shuttle? <- StreamData.boolean(),
            active_idx <- StreamData.integer(0..3),
            has_human_session? <- StreamData.boolean(),
            has_human_window_in_family? <- StreamData.boolean(),
            has_stray_page? <- StreamData.boolean(),
            human_closed_a_page? <- StreamData.boolean()
          ) do
        build_scenario(
          fiber_states,
          has_session?,
          focused_shuttle?,
          active_idx,
          has_human_session?,
          has_human_window_in_family?,
          has_stray_page?,
          human_closed_a_page?
        )
      end
    end

    defp build_scenario(
           fiber_states,
           has_session?,
           focused_shuttle?,
           active_idx,
           has_human_session?,
           has_human_window_in_family?,
           has_stray_page?,
           human_closed_a_page?
         ) do
      now = ~U[2026-11-21 12:00:00Z]
      recent_iso = DateTime.add(now, -3_600, :second) |> DateTime.to_iso8601()
      expired_iso = DateTime.add(now, -90_000, :second) |> DateTime.to_iso8601()

      sid = "session:fam"

      {fibers, bindings, places, windows, blocks} =
        Enum.reduce(
          [{@uid_a, "a", @name_a}, {@uid_b, "b", @name_b}, {@uid_c, "c", "c-#{@uid_c}-shuttle"}],
          {[], %{}, %{}, [], []},
          fn {uid, leaf, name}, {fs, bs, ps, ws, blks} ->
            state = fiber_states[uid]
            path = @root <> "/" <> leaf
            wid = "window:#{leaf}"
            chat_bid = "block:chat-#{leaf}"
            page_bid = "block:page-#{leaf}"

            f =
              case state do
                :absent -> nil
                :live -> %{"id" => uid, "uid" => uid, "slug" => path, "status" => "active", "shuttle" => %{"host" => "h", "kind" => "oneshot"}}
                :waiting -> %{"id" => uid, "uid" => uid, "slug" => path, "status" => "closed", "shuttle" => %{"host" => "h", "kind" => "oneshot"}}
                :recent -> %{"id" => uid, "uid" => uid, "slug" => path, "status" => "open", "shuttle" => %{"host" => "h", "kind" => "oneshot"}}
                :expired -> %{"id" => uid, "uid" => uid, "slug" => path, "status" => "open", "shuttle" => %{"host" => "h", "kind" => "oneshot"}}
                :tempered -> %{"id" => uid, "uid" => uid, "slug" => path, "status" => "closed", "tempered" => true, "shuttle" => %{"host" => "h", "kind" => "oneshot"}}
                :discarded -> %{"id" => uid, "uid" => uid, "slug" => path, "status" => "closed", "tempered" => false, "shuttle" => %{"host" => "h", "kind" => "oneshot"}}
              end

            fs = if f, do: [f | fs], else: fs

            cond do
              not has_session? ->
                {fs, bs, ps, ws, blks}

              state == :live ->
                page_present? = not (uid == @uid_a and human_closed_a_page?)

                w_blks =
                  if page_present?,
                    do: [
                      %{block_id: chat_bid, label: name, window_id: wid, placement: "placed"},
                      %{block_id: page_bid, label: RexPages.label(), window_id: wid, placement: "placed"}
                    ],
                    else: [%{block_id: chat_bid, label: name, window_id: wid, placement: "placed"}]

                b =
                  %{
                    "session_id" => sid,
                    "window_id" => wid,
                    "block_id" => chat_bid,
                    "family" => @root,
                    "fiber" => path,
                    "depth" => 1,
                    "page_block_id" => page_bid
                  }

                p = %{
                  "session_id" => sid,
                  "window_id" => wid,
                  "page_block_id" => page_bid,
                  "family" => @root,
                  "fiber" => path,
                  "depth" => 1,
                  "asked_at" => recent_iso,
                  "page_closed" => false
                }

                w = %{window_id: wid, label: "└ #{leaf}", block_ids: Enum.map(w_blks, & &1.block_id)}
                {fs, Map.put(bs, name, b), Map.put(ps, uid, p), ws ++ [w], blks ++ w_blks}

              state in [:recent, :expired, :tempered, :discarded] ->
                asked = if state == :expired, do: expired_iso, else: recent_iso

                p = %{
                  "session_id" => sid,
                  "window_id" => wid,
                  "page_block_id" => page_bid,
                  "family" => @root,
                  "fiber" => path,
                  "depth" => 1,
                  "asked_at" => asked,
                  "page_closed" => false
                }

                w = %{window_id: wid, label: "└ #{leaf}", block_ids: [page_bid]}
                blk = %{block_id: page_bid, label: RexPages.label(), window_id: wid, placement: "placed"}
                {fs, bs, Map.put(ps, uid, p), ws ++ [w], blks ++ [blk]}

              true ->
                {fs, bs, ps, ws, blks}
            end
          end
        )

      {windows, blocks} =
        if has_session? and has_human_window_in_family? do
          hw = %{window_id: "window:human-in-fam", label: "zsh", block_ids: ["block:human-shell"]}
          hb = %{block_id: "block:human-shell", label: "zsh", window_id: "window:human-in-fam", placement: "placed"}
          {windows ++ [hw], blocks ++ [hb]}
        else
          {windows, blocks}
        end

      blocks =
        if has_session? and has_stray_page? and windows != [] do
          first_wid = hd(windows).window_id
          blocks ++ [%{block_id: "block:stray-page", label: RexPages.label(), window_id: first_wid, placement: "placed"}]
        else
          blocks
        end

      sessions = %{}

      sessions =
        if has_session? do
          active_wid =
            case Enum.at(windows, rem(active_idx, max(length(windows), 1))) do
              nil -> nil
              w -> w.window_id
            end

          Map.put(sessions, sid, %{
            session_id: sid,
            label: "design/family",
            active_window_id: active_wid,
            windows: windows,
            blocks: blocks
          })
        else
          sessions
        end

      sessions =
        if has_human_session? do
          Map.put(sessions, "session:human", %{
            session_id: "session:human",
            label: "my-shell",
            active_window_id: "window:h1",
            windows: [%{window_id: "window:h1", label: "vim", block_ids: ["block:h1", "block:h-page"]}],
            blocks: [
              %{block_id: "block:h1", label: "vim", window_id: "window:h1", placement: "placed"},
              %{block_id: "block:h-page", label: RexPages.label(), window_id: "window:h1", placement: "placed"}
            ]
          })
        else
          sessions
        end

      observed = %{
        sessions: sessions,
        focused_sessions: if(focused_shuttle? and has_session?, do: MapSet.new([sid]), else: MapSet.new()),
        families: if(has_session?, do: %{@root => sid}, else: %{}),
        bindings: bindings,
        viewers: %{},
        places: places
      }

      desired =
        RexLayout.desired(%{
          fibers: fibers,
          bindings: bindings,
          places: places,
          now: now,
          pages_base: "http://hub.test:4000",
          own_host_id: "h"
        })

      {observed, desired}
    end

    property "idempotence: plan(apply_pure(obs, plan(obs, des)), des) == []" do
      check all({obs, des} <- scenario_gen(), max_runs: 100) do
        actions = RexLayout.plan(obs, des)
        after_obs = RexLayout.apply_pure(obs, actions)
        assert RexLayout.plan(after_obs, des) == []
      end
    end

    property "never closes a chat block, human block, or non-Shuttle session, and never closes the active window of a focused session" do
      check all({obs, des} <- scenario_gen(), max_runs: 100) do
        actions = RexLayout.plan(obs, des)
        shuttle_sids = MapSet.new(Map.values(obs.families))

        for action <- actions do
          case action do
            {:close_block, %{session_id: sid, block_id: bid}} ->
              assert MapSet.member?(shuttle_sids, sid)
              block = Enum.find(obs.sessions[sid].blocks, &(&1.block_id == bid))
              assert block.label == RexPages.label()

            {:close_window, %{session_id: sid, window_id: wid}} ->
              assert MapSet.member?(shuttle_sids, sid)
              session = obs.sessions[sid]

              refute MapSet.member?(obs.focused_sessions, sid) and session.active_window_id == wid

              win_blocks = Enum.filter(session.blocks, &(&1.window_id == wid))
              assert Enum.all?(win_blocks, &(&1.label == RexPages.label()))

            {:close_session, %{session_id: sid}} ->
              assert MapSet.member?(shuttle_sids, sid)
              refute sid == "session:human"

            {:set_label, %{session_id: sid}} ->
              assert MapSet.member?(shuttle_sids, sid)

            _ ->
              :ok
          end
        end

        # Non-Shuttle session is completely untouched.
        if Map.has_key?(obs.sessions, "session:human") do
          after_obs = RexLayout.apply_pure(obs, actions)
          assert after_obs.sessions["session:human"] == obs.sessions["session:human"]
        end
      end
    end
  end

  describe "FakeRex end-to-end place lifecycle" do
    setup %{tmp_dir: dir} do
      Env.put_app_env(:os_type, {:unix, :darwin})
      Env.put_env("SHUTTLE_DATA_DIR", dir)
      Env.put_env("SHUTTLE_REX_BIN", "/bin/echo")
      Env.put_app_env(:own_host_id, "test-host")
      Env.put_app_env(:fake_rex, start_supervised!({FakeRex, []}))
      Env.put_app_env(:rex_runner, FakeRex)
      Env.put_app_env(:terminal_backend, Backend)

      host = Path.join(dir, "host.json")
      File.write!(host, ~s({"pages":{"enabled":true,"base":"http://hub.test:4000"}}))
      Env.put_env("SHUTTLE_HOST_CONFIG_FILE", host)

      RexFamilyStore.write(dir, [@root, @root <> "/a", @root <> "/b"])

      FakeRex.clients([
        %{"client_id" => "client:mac", "info" => %{"kind" => "app", "platform" => "macos"}}
      ])

      %{dir: dir, host: host}
    end

    defp blocks(sid), do: FakeRex.state().sessions[sid].blocks

    test "quiet thread -> ensure_place [page] -> launch splits [chat|page] -> worker exit leaves [page] -> grace expiry closes it" do
      now = ~U[2026-11-21 12:00:00Z]

      root_fiber = %{
        "id" => "root-uid",
        "uid" => "root-uid",
        "slug" => @root,
        "status" => "open",
        "tags" => ["constitution"],
        "shuttle" => %{"host" => "test-host", "kind" => "oneshot"}
      }

      quiet_fiber = %{
        "id" => @uid_a,
        "uid" => @uid_a,
        "slug" => @root <> "/a",
        "status" => "open",
        "shuttle" => %{"host" => "test-host", "kind" => "oneshot"}
      }

      fibers = [root_fiber, quiet_fiber]

      # 1. `go` / ensure_place on a quiet thread creates a [page] window.
      assert {:ok, place} = RexLayout.ensure_place(FakeRex, quiet_fiber, now: now)
      sid = place["session_id"]
      wid = place["window_id"]
      page_bid = place["page_block_id"]

      assert [%{"block_id" => ^page_bid, "label" => "rexweb shuttle", "window_id" => ^wid}] =
               blocks(sid)

      # 2. Launching a worker for that fiber reuses the same window and splits chat on the left (`side: "before"`).
      assert :ok = Backend.launch(FakeRex, @name_a, "/tmp", "worker.sh", fiber: @root <> "/a")

      split_call =
        Enum.find_value(FakeRex.calls(), fn {_, args, opts} ->
          if "session.new_split" in args, do: Jason.decode!(opts[:input])
        end)

      assert %{
               "anchor_id" => ^page_bid,
               "direction" => "horizontal",
               "side" => "before",
               "ratio" => 0.5,
               "focus" => false,
               "layout" => %{"block" => %{"label" => @name_a}}
             } = split_call

      {:ok, doc} = RexBindings.read()
      b = doc["bindings"][@name_a]
      assert b["session_id"] == sid
      assert b["window_id"] == wid
      assert b["page_block_id"] == page_bid
      assert length(blocks(sid)) == 2

      # 3. Worker exit (chat block closes) leaves [page] intact.
      assert {:ok, _} = Rex.call(FakeRex, "block.close", %{"block_id" => b["block_id"]}, session: sid)
      assert :absent = Backend.probe(FakeRex, @name_a)
      assert [%{"block_id" => ^page_bid, "window_id" => ^wid}] = blocks(sid)

      # 4. Within 24h grace, reconcile keeps the [page] tab.
      assert :ok =
               RexLayout.reconcile(FakeRex,
                 fibers: fibers,
                 now: DateTime.add(now, 3_600, :second)
               )

      assert Map.has_key?(FakeRex.state().sessions, sid)
      assert Enum.any?(blocks(sid), &(&1["block_id"] == page_bid and &1["window_id"] == wid))
      # Tab 1 family view is also present for the family root.
      {:ok, mid_doc} = RexBindings.read()
      assert mid_doc["views"][@root]["session_id"] == sid

      # 5. Past 24h grace while focused on this session's active window: still protected!
      FakeRex.clients([
        %{
          "client_id" => "client:mac",
          "info" => %{"kind" => "app", "platform" => "macos"},
          "focused_session_id" => sid
        }
      ])

      expired = DateTime.add(now, 90_000, :second)
      assert :ok = RexLayout.reconcile(FakeRex, fibers: fibers, now: expired)
      assert Map.has_key?(FakeRex.state().sessions, sid)

      # 6. Once unfocused, grace expiry closes the [page] window and the empty family session.
      FakeRex.clients([
        %{"client_id" => "client:mac", "info" => %{"kind" => "app", "platform" => "macos"}}
      ])

      assert :ok = RexLayout.reconcile(FakeRex, fibers: fibers, now: expired)
      refute Map.has_key?(FakeRex.state().sessions, sid)
      {:ok, final_doc} = RexBindings.read()
      assert final_doc["places"] == %{}
      assert final_doc["families"] == %{}
    end

    test "Rex.close on a live worker with pages on closes only the chat block, leaving [page] intact" do
      assert :ok = Backend.launch(FakeRex, @name_a, "/tmp", "worker.sh", fiber: @root <> "/a")
      {:ok, doc} = RexBindings.read()
      b = doc["bindings"][@name_a]
      sid = b["session_id"]
      wid = b["window_id"]
      page_bid = b["page_block_id"]

      assert :ok = Backend.close(FakeRex, @name_a)
      assert [%{"block_id" => ^page_bid, "label" => "rexweb shuttle", "window_id" => ^wid}] =
               blocks(sid)

      {:ok, after_doc} = RexBindings.read()
      assert after_doc["bindings"] == %{}
      assert after_doc["places"][@uid_a]["page_block_id"] == page_bid
    end

    test "server instance change clears places and shells, and reconcile rebuilds desired places" do
      now = ~U[2026-11-21 12:00:00Z]

      waiting_fiber = %{
        "id" => @uid_a,
        "uid" => @uid_a,
        "slug" => @root <> "/a",
        "status" => "closed",
        "shuttle" => %{"host" => "test-host", "kind" => "oneshot"}
      }

      assert {:ok, place} = RexLayout.ensure_place(FakeRex, waiting_fiber, now: now)
      old_sid = place["session_id"]

      # Simulate Rex server restart (new instance_id).
      FakeRex.reply(
        "whoami",
        {Jason.encode!(Map.put(FakeRex.fixture("whoami"), "instance_id", "restarted-instance")), 0}
      )

      assert {:ok, []} = Backend.list(FakeRex)
      {:ok, cleared} = RexBindings.read()
      assert cleared["places"] == %{}
      assert cleared["bindings"] == %{}
      refute Map.has_key?(FakeRex.state().sessions, old_sid)

      # Reconcile rebuilds the desired [page] place for the waiting fiber (plus Tab 1 family view).
      assert :ok = RexLayout.reconcile(FakeRex, fibers: [waiting_fiber], now: now)
      {:ok, rebuilt} = RexBindings.read()
      new_place = rebuilt["places"][@uid_a]
      assert is_binary(new_place["session_id"])
      assert is_binary(new_place["page_block_id"])
      assert Enum.any?(blocks(new_place["session_id"]), &(&1["block_id"] == new_place["page_block_id"] and &1["label"] == "rexweb shuttle"))
      assert rebuilt["views"][@root]["session_id"] == new_place["session_id"]
    end

    test "cold Poller cache at boot never wipes existing places" do
      now = ~U[2026-11-21 12:00:00Z]

      quiet_fiber = %{
        "id" => @uid_a,
        "uid" => @uid_a,
        "slug" => @root <> "/a",
        "status" => "open",
        "shuttle" => %{"host" => "test-host", "kind" => "oneshot"}
      }

      assert {:ok, place} = RexLayout.ensure_place(FakeRex, quiet_fiber, now: now)
      sid = place["session_id"]

      # Even past grace, when fibers_loaded? is false (cold cache), reconcile keeps the place.
      expired = DateTime.add(now, 90_000, :second)

      assert :ok =
               RexLayout.reconcile(FakeRex,
                 fibers: [],
                 fibers_loaded?: false,
                 now: expired
               )

      assert Map.has_key?(FakeRex.state().sessions, sid)
      {:ok, doc} = RexBindings.read()
      assert Map.has_key?(doc["places"], @uid_a)
    end

    test "ensure_place arriving first after a Rex server restart reconciles stale places before creating a fresh one" do
      now = ~U[2026-11-21 12:00:00Z]

      quiet_fiber = %{
        "id" => @uid_a,
        "uid" => @uid_a,
        "slug" => @root <> "/a",
        "status" => "open",
        "shuttle" => %{"host" => "test-host", "kind" => "oneshot"}
      }

      assert {:ok, old_place} = RexLayout.ensure_place(FakeRex, quiet_fiber, now: now)
      old_sid = old_place["session_id"]
      old_wid = old_place["window_id"]

      # Rex server restarts with a new instance_id; ensure_place is the very first call.
      FakeRex.reply(
        "whoami",
        {Jason.encode!(Map.put(FakeRex.fixture("whoami"), "instance_id", "after-restart")), 0}
      )

      assert {:ok, new_place} = RexLayout.ensure_place(FakeRex, quiet_fiber, now: now)
      refute new_place["window_id"] == old_wid
      refute Map.has_key?(FakeRex.state().sessions, old_sid)
      assert Map.has_key?(FakeRex.state().sessions, new_place["session_id"])
    end

    test "resume-<uuid> worker keeps its page during reconcile and is not treated as stray", ctx do
      file = Path.join([ctx.dir, "family-store", ".felt", @root, "a", "a.md"])
      File.write!(file, "---\nname: a\nuid: #{@uid_a}\ntags: [constitution]\n---\n")

      assert :ok = Backend.launch(FakeRex, "resume-1234", "/tmp", "worker.sh", fiber: @root <> "/a")
      {:ok, doc} = RexBindings.read()
      b = doc["bindings"]["resume-1234"]
      assert b["page_uid"] == @uid_a
      sid = b["session_id"]
      page_bid = b["page_block_id"]

      # Reconcile with empty owner-filtered fibers: the live resume-* binding keeps its page
      # (alongside Tab 1's family view page).
      assert :ok = RexLayout.reconcile(FakeRex, fibers: [])
      assert Enum.any?(blocks(sid), &(&1["block_id"] == page_bid))
      assert Enum.count(blocks(sid), &(&1["window_id"] == b["window_id"] and RexPages.page?(&1))) == 1
    end

    test "ensure_place restores a human-closed page block in an existing live window" do
      now = ~U[2026-11-21 12:00:00Z]

      fiber_a = %{
        "id" => @uid_a,
        "uid" => @uid_a,
        "slug" => @root <> "/a",
        "status" => "active",
        "shuttle" => %{"host" => "test-host", "kind" => "oneshot"}
      }

      assert :ok = Backend.launch(FakeRex, @name_a, "/tmp", "worker.sh", fiber: @root <> "/a")
      {:ok, doc} = RexBindings.read()
      b = doc["bindings"][@name_a]
      sid = b["session_id"]
      wid = b["window_id"]
      old_page_bid = b["page_block_id"]

      # Human closes the page block (⌘W); chat block remains in the window.
      assert {:ok, _} = Rex.call(FakeRex, "block.close", %{"block_id" => old_page_bid}, session: sid)
      assert :ok = RexLayout.reconcile(FakeRex, fibers: [fiber_a], now: now)
      {:ok, after_close} = RexBindings.read()
      assert after_close["places"][@uid_a]["page_closed"] == true

      # `go` / ensure_place restores the page split in that same window.
      assert {:ok, restored} = RexLayout.ensure_place(FakeRex, fiber_a, now: now)
      assert restored["session_id"] == sid
      assert restored["window_id"] == wid
      assert is_binary(restored["page_block_id"])
      refute restored["page_block_id"] == old_page_bid
      assert restored["page_closed"] == false
      assert Enum.any?(blocks(sid), &(&1["block_id"] == restored["page_block_id"]))
    end

    test "pages.desk: false leaves no Desk session; pages.desk: true creates, preserves, rebuilds, and removes it",
         %{host: host} do
      # Default (desk: false): no Desk session is created.
      assert :ok = RexLayout.reconcile(FakeRex, fibers: [])
      {:ok, doc0} = RexBindings.read()
      assert doc0["desk"] == nil
      assert FakeRex.state().sessions == %{}

      # Create a pre-existing session so we can verify Desk moves to index 0.
      assert {:ok, %{"session_id" => existing_sid}} =
               Rex.create(FakeRex, %{
                 "label" => "human",
                 "initial_windows" => [
                   %{"window_label" => "shell", "layout" => %{"block" => %{"label" => "shell"}}}
                 ]
               })

      # Enable pages.desk: true -> creates Desk session at index 0 with Desk + Fleet Map tabs.
      File.write!(host, ~s({"pages":{"enabled":true,"base":"http://hub.test:4000","desk":true}}))
      assert :ok = RexLayout.reconcile(FakeRex, fibers: [])

      {:ok, doc1} = RexBindings.read()
      desk = doc1["desk"]
      map_tab = doc1["map"]

      assert %{"session_id" => desk_sid, "window_id" => desk_wid, "page_block_id" => desk_bid} =
               desk

      assert %{
               "session_id" => ^desk_sid,
               "window_id" => map_wid,
               "page_block_id" => map_bid,
               "url" => "http://hub.test:4000/map?in=rex"
             } = map_tab

      refute map_wid == desk_wid
      refute map_bid == desk_bid

      state1 = FakeRex.state()
      assert hd(state1.order) == desk_sid
      assert state1.order == [desk_sid, existing_sid]
      assert state1.sessions[desk_sid].label == "Desk"
      assert [desk_block, map_block] = blocks(desk_sid)
      assert desk_block["block_id"] == desk_bid
      assert desk_block["window_id"] == desk_wid
      assert RexPages.page?(desk_block)
      assert map_block["block_id"] == map_bid
      assert map_block["window_id"] == map_wid
      assert RexPages.page?(map_block)

      assert Enum.any?(FakeRex.calls(), fn {_cmd, args, opts} ->
               "session.create" in args and
                 String.contains?(opts[:input] || "", "http://hub.test:4000/desk?in=rex")
             end)

      assert Enum.any?(FakeRex.calls(), fn {_cmd, args, opts} ->
               "session.new_window" in args and
                 String.contains?(opts[:input] || "", "http://hub.test:4000/map?in=rex") and
                 String.contains?(opts[:input] || "", "Fleet Map")
             end)

      # Second reconcile is idempotent: preserves both Desk and Fleet Map without recreating or moving.
      calls_before = length(FakeRex.calls())
      assert :ok = RexLayout.reconcile(FakeRex, fibers: [])
      new_args = FakeRex.calls() |> Enum.drop(calls_before) |> Enum.map(&elem(&1, 1))
      refute Enum.any?(new_args, &("session.create" in &1))
      refute Enum.any?(new_args, &("session.new_window" in &1))
      refute Enum.any?(new_args, &("move" in &1))
      {:ok, doc2} = RexBindings.read()
      assert doc2["desk"] == desk
      assert doc2["map"] == map_tab

      # Closing the Desk page block -> reconcile restores Desk window while preserving Fleet Map.
      assert {:ok, _} = Rex.call(FakeRex, "block.close", %{"block_id" => desk_bid}, session: desk_sid)
      assert :ok = RexLayout.reconcile(FakeRex, fibers: [])
      {:ok, doc3} = RexBindings.read()
      assert doc3["desk"]["session_id"] == desk_sid
      refute doc3["desk"]["page_block_id"] == desk_bid
      assert doc3["map"] == map_tab
      assert Enum.any?(blocks(desk_sid), &(&1["block_id"] == doc3["desk"]["page_block_id"]))

      # Closing the Fleet Map page block -> reconcile records map_closed and does not reopen it.
      assert {:ok, _} = Rex.call(FakeRex, "block.close", %{"block_id" => map_bid}, session: desk_sid)
      assert :ok = RexLayout.reconcile(FakeRex, fibers: [])
      {:ok, doc3b} = RexBindings.read()
      assert doc3b["desk"] == doc3["desk"]
      assert doc3b["map"] == %{"session_id" => desk_sid, "map_closed" => true}
      refute Enum.any?(blocks(desk_sid), &(&1["block_id"] == map_bid))

      # Subsequent reconciles continue respecting map_closed without opening a new window.
      calls_closed = length(FakeRex.calls())
      assert :ok = RexLayout.reconcile(FakeRex, fibers: [])
      closed_args = FakeRex.calls() |> Enum.drop(calls_closed) |> Enum.map(&elem(&1, 1))
      refute Enum.any?(closed_args, &("session.new_window" in &1))
      assert {:ok, ^doc3b} = RexBindings.read()

      # Explicit ensure_map clears map_closed and reopens Fleet Map in the live Desk session.
      assert {:ok, reopened_map} = RexLayout.ensure_map(FakeRex)
      assert reopened_map["session_id"] == desk_sid
      refute reopened_map["page_block_id"] == map_bid
      refute Map.has_key?(reopened_map, "map_closed")
      assert Enum.any?(blocks(desk_sid), &(&1["block_id"] == reopened_map["page_block_id"]))

      # Close Fleet Map again, record map_closed, then verify a Rex server restart clears it
      # and rebuilds both Desk and Fleet Map.
      assert {:ok, _} =
               Rex.call(FakeRex, "block.close", %{"block_id" => reopened_map["page_block_id"]},
                 session: desk_sid
               )

      assert :ok = RexLayout.reconcile(FakeRex, fibers: [])
      assert {:ok, %{"map" => %{"session_id" => ^desk_sid, "map_closed" => true}}} = RexBindings.read()

      # Rex server restart (new instance_id) -> retires stale Desk + closed Map and rebuilds both.
      FakeRex.reply(
        "whoami",
        {Jason.encode!(Map.put(FakeRex.fixture("whoami"), "instance_id", "desk-after-restart")), 0}
      )

      assert :ok = RexLayout.reconcile(FakeRex, fibers: [])
      {:ok, doc4} = RexBindings.read()
      refute doc4["desk"]["session_id"] == desk_sid
      assert doc4["map"]["session_id"] == doc4["desk"]["session_id"]
      assert is_binary(doc4["map"]["window_id"])
      assert is_binary(doc4["map"]["page_block_id"])
      refute Map.has_key?(doc4["map"], "map_closed")
      refute Map.has_key?(FakeRex.state().sessions, desk_sid)
      assert Map.has_key?(FakeRex.state().sessions, doc4["desk"]["session_id"])

      # Turning pages.desk off -> removes Desk + Fleet Map, destroys session, clears rex.json entries.
      new_desk_sid = doc4["desk"]["session_id"]
      File.write!(host, ~s({"pages":{"enabled":true,"base":"http://hub.test:4000","desk":false}}))
      assert :ok = RexLayout.reconcile(FakeRex, fibers: [])
      {:ok, doc5} = RexBindings.read()
      assert doc5["desk"] == nil
      assert doc5["map"] == nil
      refute Map.has_key?(FakeRex.state().sessions, new_desk_sid)
      assert Map.has_key?(FakeRex.state().sessions, existing_sid)
    end

    test "cold Poller cache at boot preserves persisted chosen_roots and quiet chosen Tab 1 views without reordering" do
      now = ~U[2026-11-21 12:00:00Z]

      root_fiber = %{
        "id" => "u-root",
        "uid" => "u-root",
        "slug" => @root,
        "status" => "open",
        "shuttle" => %{"host" => "test-host", "kind" => "oneshot"}
      }

      # Warm reconcile creates the quiet chosen family's Tab 1 session and persists chosen_roots.
      assert :ok =
               RexLayout.reconcile(FakeRex,
                 fibers: [root_fiber],
                 chosen_roots: [@root],
                 now: now
               )

      {:ok, doc1} = RexBindings.read()
      sid = doc1["families"][@root]
      assert is_binary(sid)
      assert doc1["chosen_roots"] == [@root]
      assert doc1["views"][@root]["session_id"] == sid

      calls_before = length(FakeRex.calls())

      # Cold Poller cache at boot (fibers: [], fibers_loaded?: false, no explicit chosen_roots):
      # preserves chosen_roots, keeps the quiet chosen session/view, and issues no session moves.
      assert :ok =
               RexLayout.reconcile(FakeRex,
                 fibers: [],
                 fibers_loaded?: false,
                 now: now
               )

      assert Map.has_key?(FakeRex.state().sessions, sid)
      {:ok, doc2} = RexBindings.read()
      assert doc2["chosen_roots"] == [@root]
      assert doc2["views"][@root]["session_id"] == sid

      new_calls = Enum.drop(FakeRex.calls(), calls_before)
      refute Enum.any?(new_calls, fn {_, args, _} -> "move" in args end)
    end

    test "ensure_place restores a closed Tab 1 family view page and keeps views[root] in sync" do
      now = ~U[2026-11-21 12:00:00Z]

      root_fiber = %{
        "id" => @uid_a,
        "uid" => @uid_a,
        "slug" => @root,
        "status" => "active",
        "shuttle" => %{"host" => "test-host", "kind" => "oneshot"}
      }

      # Launch root worker -> creates [chat | page] in Tab 1; reconcile records views[@root].
      assert :ok = Backend.launch(FakeRex, @name_a, "/tmp", "worker.sh", fiber: @root)
      assert :ok = RexLayout.reconcile(FakeRex, fibers: [root_fiber], chosen_roots: [@root], now: now)
      {:ok, doc1} = RexBindings.read()
      view1 = doc1["views"][@root]
      sid = view1["session_id"]
      old_page_bid = view1["page_block_id"]
      assert is_binary(old_page_bid)

      # Human closes Tab 1's page block -> reconcile marks views[@root].page_closed = true.
      assert {:ok, _} = Rex.call(FakeRex, "block.close", %{"block_id" => old_page_bid}, session: sid)
      assert :ok = RexLayout.reconcile(FakeRex, fibers: [root_fiber], chosen_roots: [@root], now: now)
      {:ok, doc2} = RexBindings.read()
      assert doc2["views"][@root]["page_closed"] == true

      # `go` / ensure_place restores Tab 1's page split and updates views[@root].
      assert {:ok, restored} = RexLayout.ensure_place(FakeRex, root_fiber, now: now)
      {:ok, doc3} = RexBindings.read()
      assert doc3["views"][@root]["page_closed"] == false
      assert doc3["views"][@root]["page_block_id"] == restored["page_block_id"]
      refute doc3["views"][@root]["page_block_id"] == old_page_bid
    end

    test "when a child window exists first, adding Tab 1 family view moves it to index 0" do
      now = ~U[2026-11-21 12:00:00Z]

      root_fiber = %{
        "id" => "u-root",
        "uid" => "u-root",
        "slug" => @root,
        "status" => "open",
        "tags" => ["constitution"],
        "shuttle" => %{"host" => "test-host", "kind" => "oneshot"}
      }

      child_fiber = %{
        "id" => @uid_a,
        "uid" => @uid_a,
        "slug" => @root <> "/a",
        "status" => "open",
        "shuttle" => %{"host" => "test-host", "kind" => "oneshot"}
      }

      # 1. Child window is created first (no Tab 1 yet).
      assert {:ok, child_place} = RexLayout.ensure_place(FakeRex, child_fiber, now: now)
      sid = child_place["session_id"]
      child_wid = child_place["window_id"]

      # 2. Reconcile adds Tab 1 family view into that existing session and moves it to index 0.
      assert :ok = RexLayout.reconcile(FakeRex, fibers: [root_fiber, child_fiber], now: now)
      {:ok, doc} = RexBindings.read()
      view_wid = doc["views"][@root]["window_id"]
      assert is_binary(view_wid)
      refute view_wid == child_wid

      {:ok, wins} = Rex.windows(FakeRex, sid)
      assert Enum.map(wins, & &1["window_id"]) == [view_wid, child_wid]
    end
  end

  describe "S4: session ordering, marks, chosen channels, and Tab 1 family view" do
    defp apply_moves(order, moves) do
      Enum.reduce(moves, order, fn {:move_session, %{session_id: sid, index: idx}}, list ->
        without = List.delete(list, sid)
        List.insert_at(without, max(0, min(idx, length(without))), sid)
      end)
    end

    property "plan_session_order/2 only moves Desk/Shuttle/retained sessions, preserves human order, and is idempotent" do
      check all(
              has_desk? <- StreamData.boolean(),
              chosen_count <- StreamData.integer(0..3),
              other_count <- StreamData.integer(0..3),
              human_count <- StreamData.integer(0..4),
              retained_count <- StreamData.integer(0..2),
              shuffle_seed <- StreamData.integer(1..10_000),
              max_runs: 100
            ) do
        desk_sids = if has_desk?, do: ["session:desk"], else: []
        chosen_roots = for i <- 1..chosen_count//1, do: "work/chosen-#{i}"
        chosen_sids = for i <- 1..chosen_count//1, do: "session:chosen-#{i}"
        other_sids = for i <- 1..other_count//1, do: "session:other-#{i}"
        human_sids = for i <- 1..human_count//1, do: "session:human-#{i}"
        retained_sids = for i <- 1..retained_count//1, do: "session:retained-#{i}"

        families =
          Map.merge(
            Map.new(Enum.zip(chosen_roots, chosen_sids)),
            Map.new(Enum.with_index(other_sids, 1), fn {sid, i} -> {"work/other-#{i}", sid} end)
          )

        all = desk_sids ++ chosen_sids ++ other_sids ++ human_sids ++ retained_sids
        :rand.seed(:exsss, {shuffle_seed, shuffle_seed * 3, shuffle_seed * 7})
        current = Enum.shuffle(all)

        opts = %{
          desk_sids: desk_sids,
          families: families,
          chosen_roots: chosen_roots,
          retained_sids: retained_sids
        }

        moves = RexLayout.plan_session_order(current, opts)

        # Invariant 1: never moves a human session.
        human_set = MapSet.new(human_sids)

        for {:move_session, %{session_id: sid}} <- moves do
          refute MapSet.member?(human_set, sid), "moved human session #{sid}"
        end

        after_order = apply_moves(current, moves)

        # Invariant 2: human sessions keep their exact relative order.
        human_before = Enum.filter(current, &MapSet.member?(human_set, &1))
        human_after = Enum.filter(after_order, &MapSet.member?(human_set, &1))
        assert human_after == human_before

        # Invariant 3: Desk -> chosen (in rail order) -> other Shuttle -> human -> retained.
        other_before = Enum.filter(current, &(&1 in other_sids))
        retained_before = Enum.filter(current, &(&1 in retained_sids))
        expected = desk_sids ++ chosen_sids ++ other_before ++ human_before ++ retained_before
        assert after_order == expected

        # Invariant 4: idempotent.
        assert RexLayout.plan_session_order(after_order, opts) == []
      end
    end

    test "plan/2 applies session order only on session creation or chosen-set change, never undoing human drags" do
      now = ~U[2026-11-21 12:00:00Z]

      root_a = %{"id" => "u-a", "uid" => "u-a", "slug" => "work/a", "status" => "open", "shuttle" => %{"host" => "h", "kind" => "oneshot"}}
      root_b = %{"id" => "u-b", "uid" => "u-b", "slug" => "work/b", "status" => "open", "shuttle" => %{"host" => "h", "kind" => "oneshot"}}

      obs = %{
        sessions: %{
          "session:human" => %{session_id: "session:human", label: "my-shell", active_window_id: "w:h", windows: [], blocks: []},
          "session:rc" => %{session_id: "session:rc", label: "shuttle-remote-control@1", active_window_id: "w:rc", windows: [], blocks: []}
        },
        session_order: ["session:human", "session:rc"],
        retained_session_ids: ["session:rc"],
        focused_sessions: MapSet.new(),
        families: %{},
        bindings: %{},
        viewers: %{},
        places: %{},
        views: %{},
        chosen_roots: []
      }

      des =
        RexLayout.desired(%{
          fibers: [root_a, root_b],
          chosen_roots: ["work/b", "work/a"],
          now: now,
          pages_base: "http://hub.test:4000",
          own_host_id: "h"
        })

      actions = RexLayout.plan(obs, des)
      assert Enum.any?(actions, &match?({:move_session, _}, &1))
      assert Enum.any?(actions, &match?({:record_chosen_roots, %{chosen_roots: ["work/b", "work/a"]}}, &1))

      obs2 = RexLayout.apply_pure(obs, actions)
      sid_a = obs2.families["work/a"]
      sid_b = obs2.families["work/b"]
      assert obs2.session_order == [sid_b, sid_a, "session:human", "session:rc"]
      assert RexLayout.plan(obs2, des) == []

      # Human drags their shell to the top: with no new session and unchanged chosen set, plan emits nothing.
      obs_dragged = %{obs2 | session_order: ["session:human", sid_b, sid_a, "session:rc"]}
      assert RexLayout.plan(obs_dragged, des) == []

      # When chosen order changes to ["work/a", "work/b"], ordering re-applies.
      des_reordered =
        RexLayout.desired(%{
          fibers: [root_a, root_b],
          chosen_roots: ["work/a", "work/b"],
          now: now,
          pages_base: "http://hub.test:4000",
          own_host_id: "h"
        })

      actions2 = RexLayout.plan(obs_dragged, des_reordered)
      obs3 = RexLayout.apply_pure(obs_dragged, actions2)
      assert obs3.session_order == [sid_a, sid_b, "session:human", "session:rc"]
      assert RexLayout.plan(obs3, des_reordered) == []
    end

    test "marks prefix family session labels with '● ' while waiting on human and strip it when clear" do
      now = ~U[2026-11-21 12:00:00Z]

      root = %{"id" => "u-root", "uid" => "u-root", "slug" => @root, "status" => "open", "shuttle" => %{"host" => "h", "kind" => "oneshot"}}
      asking = %{"id" => @uid_a, "uid" => @uid_a, "slug" => @root <> "/a", "status" => "active", "shuttle" => %{"host" => "h", "kind" => "oneshot", "ask" => %{"text" => "Proceed?"}}}
      clear = %{"id" => @uid_a, "uid" => @uid_a, "slug" => @root <> "/a", "status" => "active", "shuttle" => %{"host" => "h", "kind" => "oneshot"}}

      des_waiting =
        RexLayout.desired(%{
          fibers: [root, asking],
          chosen_roots: [@root],
          now: now,
          pages_base: "http://hub.test:4000",
          own_host_id: "h"
        })

      assert des_waiting.families[@root].waiting? == true
      assert des_waiting.families[@root].label == "● design/family"

      obs = %{sessions: %{}, focused_sessions: MapSet.new(), families: %{}, bindings: %{}, viewers: %{}, places: %{}, views: %{}}
      obs_waiting = RexLayout.apply_pure(obs, RexLayout.plan(obs, des_waiting))
      sid = obs_waiting.families[@root]
      assert obs_waiting.sessions[sid].label == "● design/family"

      des_clear =
        RexLayout.desired(%{
          fibers: [root, clear],
          chosen_roots: [@root],
          now: now,
          pages_base: "http://hub.test:4000",
          own_host_id: "h"
        })

      assert des_clear.families[@root].waiting? == false
      assert des_clear.families[@root].label == "design/family"

      clear_actions = RexLayout.plan(obs_waiting, des_clear)
      assert {:set_label, %{target: :session, session_id: sid, label: "design/family"}} in clear_actions
      obs_clear = RexLayout.apply_pure(obs_waiting, clear_actions)
      assert obs_clear.sessions[sid].label == "design/family"
    end

    test "chosen_roots_from_channels/4 maps pinned channels in rail order to family roots, honoring unpins" do
      fibers = [
        %{"id" => "u1", "uid" => "u1", "slug" => "work/alpha", "status" => "open", "shuttle" => %{"host" => "h", "channel" => "Alpha"}},
        %{"id" => "u2", "uid" => "u2", "slug" => "work/beta", "status" => "open", "shuttle" => %{"host" => "h", "channel" => "Beta"}},
        %{"id" => "u3", "uid" => "u3", "slug" => "work/gamma", "status" => "open", "shuttle" => %{"host" => "h", "channel" => "Gamma"}},
        %{"id" => "u4", "uid" => "u4", "slug" => "work/other-host", "status" => "open", "shuttle" => %{"host" => "remote", "channel" => "Alpha"}}
      ]

      records = [
        %{"kind" => "pinned", "text" => "channel:alpha", "timestamp" => 100},
        %{"kind" => "pinned", "text" => "channel:beta", "timestamp" => 200},
        %{"kind" => "pinned", "text" => "channel:gamma", "timestamp" => 300},
        %{"kind" => "dismissed", "text" => "pin:channel:gamma:350"},
        %{"kind" => "ordered", "keys" => ["channel:beta", "channel:alpha"], "timestamp" => 400}
      ]

      assert RexLayout.chosen_roots_from_channels(records, fibers, fibers, "h") == [
               "work/beta",
               "work/alpha"
             ]
    end

    test "Tab 1 family view is created on new family session, reused by root worker launch, and preserved when child closes" do
      now = ~U[2026-11-21 12:00:00Z]

      root_fiber = %{"id" => "u-root", "uid" => "u-root", "slug" => @root, "status" => "open", "shuttle" => %{"host" => "h", "kind" => "oneshot"}}
      child_fiber = %{"id" => @uid_a, "uid" => @uid_a, "slug" => @root <> "/a", "status" => "closed", "shuttle" => %{"host" => "h", "kind" => "oneshot"}}

      obs = %{sessions: %{}, focused_sessions: MapSet.new(), families: %{}, bindings: %{}, viewers: %{}, places: %{}, views: %{}}

      des1 =
        RexLayout.desired(%{
          fibers: [root_fiber, child_fiber],
          chosen_roots: [@root],
          now: now,
          pages_base: "http://hub.test:4000",
          own_host_id: "h"
        })

      obs1 = RexLayout.apply_pure(obs, RexLayout.plan(obs, des1))
      sid = obs1.families[@root]
      view = obs1.views[@root]
      assert view["session_id"] == sid
      assert view["uid"] == "u-root"
      # Tab 1 is the first window in the newly created family session.
      assert hd(obs1.sessions[sid].windows).window_id == view["window_id"]
      assert length(obs1.sessions[sid].windows) == 2

      # Child becomes tempered: child window closes, but Tab 1 family view stays (chosen channel).
      tempered_child = Map.put(child_fiber, "tempered", true)

      des2 =
        RexLayout.desired(%{
          fibers: [root_fiber, tempered_child],
          chosen_roots: [@root],
          now: now,
          pages_base: "http://hub.test:4000",
          own_host_id: "h"
        })

      obs2 = RexLayout.apply_pure(obs1, RexLayout.plan(obs1, des2))
      assert length(obs2.sessions[sid].windows) == 1
      assert hd(obs2.sessions[sid].windows).window_id == view["window_id"]
      assert RexLayout.plan(obs2, des2) == []
    end
  end
end
