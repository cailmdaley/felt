defmodule ShuttleWeb.PaletteControllerTest do
  use ExUnit.Case, async: true
  import Phoenix.ConnTest
  import Shuttle.Test.ApiConn
  import Shuttle.Test.PollerHelpers
  alias Shuttle.Palette
  alias Shuttle.Terminal.{Rex, RexBindings}
  alias Shuttle.Test.{Env, FakeRex, FiberUid}

  @endpoint ShuttleWeb.Endpoint
  @moduletag :tmp_dir

  defmodule QuietRunner do
    @behaviour Shuttle.Runner
    def cmd(_command, _args, _opts), do: {"", 1}
  end

  defp make_entry(id, opts) do
    uid = Keyword.get(opts, :uid, FiberUid.for(id))
    status = Keyword.get(opts, :status, "active")
    kind = Keyword.get(opts, :kind, "oneshot")
    origin = Keyword.get(opts, :origin, "host-a")
    column = Keyword.get(opts, :column)
    turn = Keyword.get(opts, :turn)
    runtime = Keyword.get(opts, :runtime)
    modified_at = Keyword.get(opts, :modified_at, "2026-11-20T12:00:00Z")

    shuttle =
      %{"host" => origin, "kind" => kind}
      |> maybe_put("channel", Keyword.get(opts, :channel))
      |> maybe_put("seat", Keyword.get(opts, :seat))
      |> maybe_put("ask", Keyword.get(opts, :ask))
      |> maybe_put("project_dir", Keyword.get(opts, :project_dir))

    fiber =
      %{
        "uid" => uid,
        "id" => id,
        "slug" => id,
        "name" => Keyword.get(opts, :name, String.capitalize(id)),
        "status" => status,
        "modified_at" => modified_at,
        "shuttle" => shuttle
      }
      |> maybe_put("tempered", Keyword.get(opts, :tempered))
      |> maybe_put("horizon", Keyword.get(opts, :horizon))

    %{
      fiber: fiber,
      origin: origin,
      column: column,
      turn: turn,
      runtime: runtime
    }
  end

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)

  describe "Palette.build/2" do
    test "includes Desk, Fleet Map (when pages.desk is enabled), and New thread… before focused actions", %{
      tmp_dir: dir
    } do
      entries = [
        make_entry("alpha", runtime: %{phase: "working"}, project_dir: dir),
        make_entry("remote-beta", runtime: %{phase: "working"}, project_dir: "/no/such/remote/path")
      ]

      with_desk = Palette.build(entries, desk?: true, default_project_dir: "/stores/loom")

      assert with_desk.default_project_dir == "/stores/loom"

      assert [
               %{id: "desk", kind: "desk", fiber_id: nil, origin: nil},
               %{
                 id: "map",
                 kind: "map",
                 title: "Fleet Map",
                 detail: "map",
                 icon: "map",
                 fiber_id: nil,
                 origin: nil
               },
               %{
                 id: "new_thread",
                 kind: "new_thread",
                 title: "New thread…",
                 subtitle: "Start a capture session from a prompt",
                 detail: "capture",
                 icon: "plus",
                 fiber_id: nil,
                 origin: nil
               }
               | _
             ] = with_desk.items

      without_desk = Palette.build(entries, desk?: false, fiber_id: FiberUid.for("alpha"))
      refute Enum.any?(without_desk.items, &(&1.kind in ["desk", "map"]))
      assert [%{id: "new_thread", kind: "new_thread"}, %{kind: "action"} | _] = without_desk.items
      assert without_desk.focused.project_dir == dir

      remote_focus = Palette.build(entries, desk?: false, fiber_id: FiberUid.for("remote-beta"))
      assert remote_focus.focused.project_dir == nil
    end

    test "orders threads by attention with tempered then discarded at the bottom" do
      entries = [
        make_entry("kept-old",
          status: "closed",
          tempered: true,
          column: "tempered",
          modified_at: "2026-11-18T10:00:00Z"
        ),
        make_entry("kept-new",
          status: "closed",
          tempered: true,
          column: "tempered",
          channel: "ops",
          modified_at: "2026-11-22T10:00:00Z"
        ),
        make_entry("dropped",
          status: "closed",
          tempered: false,
          column: "discarded",
          modified_at: "2026-11-22T12:00:00Z"
        ),
        make_entry("recent-old",
          status: "open",
          column: "drafts",
          turn: "none",
          modified_at: "2026-11-18T10:00:00Z"
        ),
        make_entry("recent-new",
          status: "open",
          column: "drafts",
          turn: "none",
          modified_at: "2026-11-21T10:00:00Z"
        ),
        make_entry("live-work",
          status: "active",
          column: "in_flight",
          turn: "working",
          runtime: %{phase: "working", started_at: 1_700_000_000_000}
        ),
        make_entry("waiting-ask",
          status: "active",
          column: "in_flight",
          turn: "question",
          ask: %{"text" => "Ship this?"},
          runtime: %{phase: "attention", started_at: 1_700_000_000_000}
        ),
        make_entry("awaiting-rev",
          status: "closed",
          column: "awaiting_review",
          turn: "none",
          modified_at: "2026-11-21T09:00:00Z"
        ),
        make_entry("chan-root",
          status: "open",
          horizon: "stashed",
          column: "resting",
          turn: "none",
          channel: "ops",
          modified_at: "2026-11-19T10:00:00Z"
        )
      ]

      result = Palette.build(entries, desk?: false)
      slugs = Enum.map(result.items, & &1.title)

      # Waiting on human (ask + review) before live, before channel, before recent,
      # before tempered (newest first), before discarded.
      waiting_idx = Enum.find_index(slugs, &(&1 == "Waiting-ask"))
      review_idx = Enum.find_index(slugs, &(&1 == "Awaiting-rev"))
      live_idx = Enum.find_index(slugs, &(&1 == "Live-work"))
      chan_idx = Enum.find_index(slugs, &(&1 == "Chan-root"))
      new_idx = Enum.find_index(slugs, &(&1 == "Recent-new"))
      old_idx = Enum.find_index(slugs, &(&1 == "Recent-old"))
      kept_new_idx = Enum.find_index(slugs, &(&1 == "Kept-new"))
      kept_old_idx = Enum.find_index(slugs, &(&1 == "Kept-old"))
      dropped_idx = Enum.find_index(slugs, &(&1 == "Dropped"))

      assert waiting_idx < live_idx
      assert review_idx < live_idx
      assert live_idx < chan_idx
      assert chan_idx < new_idx
      assert new_idx < old_idx
      assert old_idx < kept_new_idx
      assert kept_new_idx < kept_old_idx
      assert kept_old_idx < dropped_idx

      chan_item = Enum.find(result.items, &(&1.title == "Chan-root"))
      assert chan_item.kind == "channel"

      kept_item = Enum.find(result.items, &(&1.title == "Kept-new"))
      assert kept_item.kind == "thread"
      assert kept_item.detail == "tempered"
      assert kept_item.icon == "document"

      dropped_item = Enum.find(result.items, &(&1.title == "Dropped"))
      assert dropped_item.kind == "thread"
      assert dropped_item.detail == "discarded"
      assert dropped_item.icon == "document"
    end

    test "offers new_session action when focused on a tempered or discarded thread" do
      kept_uid = FiberUid.for("kept-focus")
      dropped_uid = FiberUid.for("dropped-focus")

      entries = [
        make_entry("kept-focus", uid: kept_uid, status: "closed", tempered: true, column: "tempered"),
        make_entry("dropped-focus",
          uid: dropped_uid,
          status: "closed",
          tempered: false,
          column: "discarded"
        )
      ]

      for uid <- [kept_uid, dropped_uid] do
        result = Palette.build(entries, fiber_id: uid)
        assert result.focused.fiber_id == uid

        actions = Enum.filter(result.items, &(&1.kind == "action"))
        assert [%{action: "new_session", icon: "plus", fiber_id: ^uid}] = actions
      end
    end

    test "includes focused thread lifecycle actions when matched by fiber_id" do
      uid = FiberUid.for("focus-me")

      entries = [
        make_entry("focus-me",
          uid: uid,
          status: "active",
          column: "in_flight",
          turn: "working",
          runtime: %{phase: "working"}
        )
      ]

      result = Palette.build(entries, fiber_id: uid)
      assert result.focused.fiber_id == uid
      assert result.focused.slug == "focus-me"
      assert result.focused.standing == false

      actions =
        result.items
        |> Enum.filter(&(&1.kind == "action"))

      assert Enum.map(actions, & &1.action) == ["temper", "review", "rest", "discard", "new_session"]
      assert Enum.all?(actions, &(&1.standing == false))
    end

    test "omits review for standing constitutions and omits rest when already resting" do
      standing_uid = FiberUid.for("stand")
      resting_uid = FiberUid.for("rested")

      entries = [
        make_entry("stand",
          uid: standing_uid,
          status: "active",
          kind: "standing",
          column: "in_flight"
        ),
        make_entry("rested",
          uid: resting_uid,
          status: "open",
          horizon: "stashed",
          column: "resting"
        )
      ]

      standing_result = Palette.build(entries, fiber_id: standing_uid)
      assert standing_result.focused.standing == true

      standing_items = Enum.filter(standing_result.items, &(&1.kind == "action"))
      standing_actions = Enum.map(standing_items, & &1.action)

      assert Enum.all?(standing_items, &(&1.standing == true))
      refute "review" in standing_actions
      assert "temper" in standing_actions
      assert "rest" in standing_actions
      assert "discard" in standing_actions
      assert "new_session" in standing_actions

      resting_actions =
        Palette.build(entries, fiber_id: resting_uid).items
        |> Enum.filter(&(&1.kind == "action"))
        |> Enum.map(& &1.action)

      refute "rest" in resting_actions
      assert "temper" in resting_actions
      assert "review" in resting_actions
    end

    test "resolves focused thread from Rex places, bindings, and views by session_id + window_id" do
      place_uid = FiberUid.for("placed-thread")
      bound_uid = FiberUid.for("bound-thread")
      view_uid = FiberUid.for("fam-root")

      entries = [
        make_entry("placed-thread", uid: place_uid, column: "in_flight"),
        make_entry("bound-thread", uid: bound_uid, column: "in_flight"),
        make_entry("fam-root", uid: view_uid, column: "in_flight")
      ]

      bindings_doc = %{
        "places" => %{
          place_uid => %{
            "session_id" => "session:fam1",
            "window_id" => "window:w1",
            "family" => "fam-root"
          }
        },
        "bindings" => %{
          "bound-thread-#{bound_uid}-shuttle" => %{
            "session_id" => "session:fam1",
            "window_id" => "window:w2",
            "block_id" => "block:b2",
            "fiber" => "bound-thread"
          }
        },
        "views" => %{
          "fam-root" => %{
            "session_id" => "session:fam1",
            "window_id" => "window:w0",
            "uid" => view_uid
          }
        }
      }

      assert Palette.build(entries,
               bindings: bindings_doc,
               session_id: "session:fam1",
               window_id: "window:w1"
             ).focused.fiber_id == place_uid

      assert Palette.build(entries,
               bindings: bindings_doc,
               session_id: "session:fam1",
               window_id: "window:w2"
             ).focused.fiber_id == bound_uid

      assert Palette.build(entries,
               bindings: bindings_doc,
               session_id: "session:fam1",
               window_id: "window:w0"
             ).focused.fiber_id == view_uid

      # Unmatched window in the same session does not falsely focus another tab.
      assert Palette.build(entries,
               bindings: bindings_doc,
               session_id: "session:fam1",
               window_id: "window:other"
             ).focused == nil
    end

    test "resolves a view-only place by window or page block, with or without its session" do
      place_uid = FiberUid.for("placed-thread")
      other_uid = FiberUid.for("other-thread")

      entries = [
        make_entry("placed-thread", uid: place_uid, column: "in_flight"),
        make_entry("other-thread", uid: other_uid, column: "in_flight")
      ]

      bindings_doc = %{
        "places" => %{
          place_uid => %{
            "session_id" => "session:fam1",
            "window_id" => "window:w1",
            "page_block_id" => "block:p1"
          },
          # A place with no page block of its own is no match for an absent block.
          other_uid => %{"session_id" => "session:fam2", "window_id" => "window:w2"}
        }
      }

      focused = fn target ->
        Palette.build(entries, [bindings: bindings_doc] ++ target).focused
      end

      for target <- [
            [session_id: "session:fam1", window_id: "window:w1"],
            [window_id: "window:w1"],
            [block_id: "block:p1"],
            [session_id: "session:fam1", block_id: "block:p1"],
            # A page block names its place when the window Rex reports is another.
            [session_id: "session:fam1", window_id: "window:gone", block_id: "block:p1"],
            [window_id: "window:w1", block_id: "block:terminal"]
          ] do
        assert focused.(target).fiber_id == place_uid, inspect(target)
      end

      assert focused.(window_id: "window:w2").fiber_id == other_uid
      assert focused.(session_id: "session:fam2", window_id: "window:w1") == nil
      assert focused.(window_id: "window:gone") == nil
      assert focused.(block_id: "block:gone") == nil
      assert focused.([]) == nil
    end

    test "a block wins over another thread sharing its window, in any table, and an entry with no session matches no session" do
      place_uid = FiberUid.for("placed-thread")
      bound_uid = FiberUid.for("bound-thread")
      loose_uid = FiberUid.for("loose-thread")

      entries =
        for {id, uid} <- [
              {"placed-thread", place_uid},
              {"bound-thread", bound_uid},
              {"loose-thread", loose_uid}
            ],
            do: make_entry(id, uid: uid, column: "in_flight")

      bindings_doc = %{
        "places" => %{
          place_uid => %{"session_id" => "session:s", "window_id" => "window:w"},
          loose_uid => %{"window_id" => "window:loose", "page_block_id" => "block:loose"}
        },
        "bindings" => %{
          "bound-thread-#{bound_uid}-shuttle" => %{
            "session_id" => "session:s",
            "window_id" => "window:w",
            "block_id" => "block:b",
            "fiber" => "bound-thread"
          }
        }
      }

      focused = fn target ->
        Palette.build(entries, [bindings: bindings_doc] ++ target).focused
      end

      both = [session_id: "session:s", window_id: "window:w"]
      assert focused.([block_id: "block:b"] ++ both).fiber_id == bound_uid
      assert focused.(window_id: "window:w", block_id: "block:b").fiber_id == bound_uid
      # A block no thread is known by leaves its window to name one.
      assert focused.([block_id: "block:split"] ++ both).fiber_id == place_uid
      # A session that holds the window does not lend it another session's block.
      assert focused.(session_id: "session:other", window_id: "window:w", block_id: "block:b") == nil

      assert focused.(window_id: "window:loose").fiber_id == loose_uid
      assert focused.(session_id: "session:s", window_id: "window:loose") == nil
      assert focused.(session_id: "session:s", block_id: "block:loose") == nil
    end

    test "offers Temper on a standing constitution whose run is active" do
      uid = FiberUid.for("watch")

      entries = [
        make_entry("watch",
          uid: uid,
          status: "active",
          kind: "standing",
          column: "in_flight",
          turn: "question",
          ask: %{"text" => "Keep the cut?"}
        )
      ]

      result =
        Palette.build(entries,
          bindings: %{
            "places" => %{uid => %{"session_id" => "session:s", "window_id" => "window:w"}}
          },
          window_id: "window:w"
        )

      temper = Enum.find(result.items, &(&1[:action] == "temper"))
      assert temper.title == "Temper — Watch"
      assert temper.fiber_id == uid
      assert temper.standing
    end
  end

  describe "GET /api/v1/palette and POST /api/v1/go desk" do
    setup %{tmp_dir: dir} do
      host_config = Path.join(dir, "host.json")

      File.write!(
        host_config,
        Jason.encode!(%{
          "pages" => %{"enabled" => true, "base" => "http://127.0.0.1:4000", "desk" => true}
        })
      )

      Env.put_env("SHUTTLE_HOST_CONFIG_FILE", host_config)
      Env.put_env("SHUTTLE_DATA_DIR", dir)
      Env.put_env("SHUTTLE_REX_BIN", "/bin/echo")
      Env.put_app_env(:own_host_id, "test-host")
      Env.put_app_env(:fake_rex, start_supervised!({FakeRex, []}))
      Env.put_app_env(:rex_runner, FakeRex)
      Env.put_app_env(:terminal_backend, Rex)
      Env.put_app_env(:os_type, {:unix, :darwin})
      Env.put_app_env(:remotes, [])

      FakeRex.clients([
        %{"client_id" => "client:mac", "info" => %{"kind" => "app", "platform" => "macos"}}
      ])

      {:ok, poller} =
        start_poller!(runner: QuietRunner, poll_interval_ms: 60_000, felt_stores: [])

      await_boot_cycle!(poller)

      uid_live = FiberUid.for("live-tab")
      uid_wait = FiberUid.for("wait-tab")

      now = DateTime.utc_now()

      doc_cache = %{
        "live-tab.md" => %{
          entry: %{
            felt_store: dir,
            fiber: %{
              "uid" => uid_live,
              "id" => "live-tab",
              "slug" => "live-tab",
              "name" => "Live Tab",
              "status" => "active",
              "shuttle" => %{"host" => "test-host", "kind" => "oneshot"}
            }
          }
        },
        "wait-tab.md" => %{
          entry: %{
            felt_store: dir,
            fiber: %{
              "uid" => uid_wait,
              "id" => "wait-tab",
              "slug" => "wait-tab",
              "name" => "Wait Tab",
              "status" => "active",
              "shuttle" => %{
                "host" => "test-host",
                "kind" => "oneshot",
                "ask" => %{"text" => "Ready?"}
              }
            }
          }
        }
      }

      running = %{
        uid_live => %{
          pid: nil,
          session: "live-tab-#{uid_live}-shuttle",
          uid: uid_live,
          fiber_id: "live-tab",
          agent_id: nil,
          phase: "working",
          started_at: now,
          last_activity_at: now
        }
      }

      :sys.replace_state(poller, fn state ->
        %{state | document_cache: doc_cache, owner_feed_cache: nil, running: running}
      end)

      GenServer.call(poller, :sync)

      :ok =
        RexBindings.put_place(
          uid_live,
          %{
            "session_id" => "session:s1",
            "window_id" => "window:w1",
            "family" => "live-tab",
            "page_block_id" => "block:p1"
          },
          "host-test"
        )

      {:ok, uid_live: uid_live, uid_wait: uid_wait, host_config: host_config}
    end

    test "GET /api/v1/palette returns desk, focused actions, and attention-ordered threads", %{
      uid_live: uid_live
    } do
      conn = get(api_conn(), "/api/v1/palette?session_id=session:s1&window_id=window:w1")
      assert conn.status == 200
      body = Jason.decode!(conn.resp_body)

      assert body["focused"]["fiber_id"] == uid_live
      assert is_binary(body["default_project_dir"]) and body["default_project_dir"] != ""
      items = body["items"]

      assert Enum.take(items, 3) |> Enum.map(& &1["kind"]) == ["desk", "map", "new_thread"]

      actions = Enum.filter(items, &(&1["kind"] == "action"))
      assert Enum.map(actions, & &1["action"]) == ["temper", "review", "rest", "discard", "new_session"]
      assert Enum.all?(actions, &(&1["fiber_id"] == uid_live and &1["origin"] == "test-host"))

      threads = Enum.filter(items, &(&1["kind"] in ["thread", "channel"]))
      assert Enum.map(threads, & &1["title"]) == ["Wait Tab", "Live Tab"]
    end

    test "POST /api/v1/go with target desk creates and selects Desk when enabled", %{
      host_config: host_config
    } do
      conn = post(api_conn(), "/api/v1/go", Jason.encode!(%{"target" => "desk"}))
      assert conn.status == 200
      assert %{"went" => true, "place" => "desk"} = Jason.decode!(conn.resp_body)

      # Disabling pages.desk returns went: false, place: none.
      File.write!(
        host_config,
        Jason.encode!(%{"pages" => %{"enabled" => true, "desk" => false}})
      )

      conn2 = post(api_conn(), "/api/v1/go", Jason.encode!(%{"target" => "desk"}))
      assert conn2.status == 200
      assert %{"went" => false, "place" => "none"} = Jason.decode!(conn2.resp_body)
    end

    test "POST /api/v1/go with target map creates and selects Fleet Map when enabled", %{
      host_config: host_config
    } do
      conn = post(api_conn(), "/api/v1/go", Jason.encode!(%{"target" => "map"}))
      assert conn.status == 200
      assert %{"went" => true, "place" => "map"} = Jason.decode!(conn.resp_body)

      File.write!(
        host_config,
        Jason.encode!(%{"pages" => %{"enabled" => true, "desk" => false}})
      )

      conn2 = post(api_conn(), "/api/v1/go", Jason.encode!(%{"target" => "map"}))
      assert conn2.status == 200
      assert %{"went" => false, "place" => "none"} = Jason.decode!(conn2.resp_body)
    end
  end
end
