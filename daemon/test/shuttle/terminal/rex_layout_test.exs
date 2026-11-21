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
      assert [%{"block_id" => ^page_bid, "window_id" => ^wid}] = blocks(sid)

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

      # Reconcile rebuilds the desired [page] place for the waiting fiber.
      assert :ok = RexLayout.reconcile(FakeRex, fibers: [waiting_fiber], now: now)
      {:ok, rebuilt} = RexBindings.read()
      new_place = rebuilt["places"][@uid_a]
      assert is_binary(new_place["session_id"])
      assert is_binary(new_place["page_block_id"])
      assert [%{"label" => "rexweb shuttle"}] = blocks(new_place["session_id"])
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

      # Reconcile with empty owner-filtered fibers: the live resume-* binding keeps its page.
      assert :ok = RexLayout.reconcile(FakeRex, fibers: [])
      assert Enum.any?(blocks(sid), &(&1["block_id"] == page_bid))
      assert length(Enum.filter(blocks(sid), &RexPages.page?/1)) == 1
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

      # Enable pages.desk: true -> creates Desk session at index 0 with /desk?in=rex holder.
      File.write!(host, ~s({"pages":{"enabled":true,"base":"http://hub.test:4000","desk":true}}))
      assert :ok = RexLayout.reconcile(FakeRex, fibers: [])

      {:ok, doc1} = RexBindings.read()
      desk = doc1["desk"]
      assert %{"session_id" => desk_sid, "window_id" => desk_wid, "page_block_id" => desk_bid} =
               desk

      state1 = FakeRex.state()
      assert hd(state1.order) == desk_sid
      assert state1.order == [desk_sid, existing_sid]
      assert state1.sessions[desk_sid].label == "Desk"
      assert [desk_block] = blocks(desk_sid)
      assert desk_block["block_id"] == desk_bid
      assert desk_block["window_id"] == desk_wid
      assert RexPages.page?(desk_block)

      assert Enum.any?(FakeRex.calls(), fn {_cmd, args, opts} ->
               "session.create" in args and
                 String.contains?(opts[:input] || "", "http://hub.test:4000/desk?in=rex")
             end)

      # Second reconcile is idempotent: preserves the Desk session without recreating or moving it.
      calls_before = length(FakeRex.calls())
      assert :ok = RexLayout.reconcile(FakeRex, fibers: [])
      new_args = FakeRex.calls() |> Enum.drop(calls_before) |> Enum.map(&elem(&1, 1))
      refute Enum.any?(new_args, &("session.create" in &1))
      refute Enum.any?(new_args, &("move" in &1))
      {:ok, doc2} = RexBindings.read()
      assert doc2["desk"] == desk

      # Closing the Desk page block -> reconcile restores a Desk window in the same session.
      assert {:ok, _} = Rex.call(FakeRex, "block.close", %{"block_id" => desk_bid}, session: desk_sid)
      assert :ok = RexLayout.reconcile(FakeRex, fibers: [])
      {:ok, doc3} = RexBindings.read()
      assert doc3["desk"]["session_id"] == desk_sid
      refute doc3["desk"]["page_block_id"] == desk_bid
      assert Enum.any?(blocks(desk_sid), &(&1["block_id"] == doc3["desk"]["page_block_id"]))

      # Rex server restart (new instance_id) -> retires stale Desk and rebuilds a fresh one.
      FakeRex.reply(
        "whoami",
        {Jason.encode!(Map.put(FakeRex.fixture("whoami"), "instance_id", "desk-after-restart")), 0}
      )

      assert :ok = RexLayout.reconcile(FakeRex, fibers: [])
      {:ok, doc4} = RexBindings.read()
      refute doc4["desk"]["session_id"] == desk_sid
      refute Map.has_key?(FakeRex.state().sessions, desk_sid)
      assert Map.has_key?(FakeRex.state().sessions, doc4["desk"]["session_id"])

      # Turning pages.desk off -> removes Desk session and clears rex.json desk entry.
      new_desk_sid = doc4["desk"]["session_id"]
      File.write!(host, ~s({"pages":{"enabled":true,"base":"http://hub.test:4000","desk":false}}))
      assert :ok = RexLayout.reconcile(FakeRex, fibers: [])
      {:ok, doc5} = RexBindings.read()
      assert doc5["desk"] == nil
      refute Map.has_key?(FakeRex.state().sessions, new_desk_sid)
      assert Map.has_key?(FakeRex.state().sessions, existing_sid)
    end
  end
end
