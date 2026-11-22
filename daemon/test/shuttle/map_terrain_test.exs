defmodule Shuttle.MapTerrainTest do
  use ExUnit.Case, async: true

  alias Shuttle.MapTerrain
  alias Shuttle.Test.{Env, FiberUid}

  @moduletag :tmp_dir

  defmodule CountingRunner do
    @behaviour Shuttle.Runner

    def cmd("shuttle", args, _opts) do
      if agent = Shuttle.Env.app(:map_terrain_counter) do
        Agent.update(agent, fn n -> n + 1 end)
      end

      store = store_arg(args)

      case Shuttle.Env.app(:map_terrain_responses) do
        %{} = responses when is_map_key(responses, store) ->
          responses[store]

        _ ->
          rows = Shuttle.Env.app(:map_terrain_rows, %{})
          {Jason.encode!(Map.get(rows, store, [])), 0}
      end
    end

    defp store_arg(["-C", store | _]), do: store
    defp store_arg([_ | rest]), do: store_arg(rest)
    defp store_arg([]), do: nil
  end

  defp write_fiber(felt_dir, id, content) do
    leaf = Path.basename(id)
    path = Path.join([felt_dir, id, leaf <> ".md"])
    File.mkdir_p!(Path.dirname(path))
    File.write!(path, content)
    path
  end

  defp fiber_row(id, overrides \\ %{}) do
    Map.merge(
      %{
        "id" => id,
        "uid" => FiberUid.for(id),
        "name" => id |> Path.basename() |> String.capitalize(),
        "status" => "open",
        "created_at" => "2026-11-15T12:00:00Z",
        "modified_at" => "2026-11-20T12:00:00Z",
        "tags" => []
      },
      overrides
    )
  end

  describe "pure-Elixir .gitignore matching" do
    test "supports directory rules, globs, anchored paths, and negation" do
      rules =
        MapTerrain.parse_gitignore("""
        # comment
        .felt/life/secret/
        *.tmp
        /root-only.md
        drafts/*.md
        !drafts/keep.md
        **/cache/**
        """)

      assert MapTerrain.ignored?(".felt/life/secret/note.md", rules)
      assert MapTerrain.ignored?(".felt/life/secret/sub/deep.md", rules)
      refute MapTerrain.ignored?(".felt/life/public/note.md", rules)

      assert MapTerrain.ignored?("any/dir/scratch.tmp", rules)
      refute MapTerrain.ignored?("any/dir/scratch.md", rules)

      assert MapTerrain.ignored?("root-only.md", rules)
      refute MapTerrain.ignored?("nested/root-only.md", rules)

      assert MapTerrain.ignored?("drafts/drop.md", rules)
      refute MapTerrain.ignored?("drafts/keep.md", rules)

      assert MapTerrain.ignored?("a/b/cache/x.md", rules)
      assert MapTerrain.ignored?("cache/x.md", rules)
    end

    test "escapes regex metacharacters in character classes cleanly" do
      rules =
        MapTerrain.parse_gitignore("""
        note-[a-z].md
        item-[!0-9].md
        special-[a^b\\[].md
        literal-[]x].md
        """)

      assert MapTerrain.ignored?("note-k.md", rules)
      refute MapTerrain.ignored?("note-5.md", rules)

      assert MapTerrain.ignored?("item-a.md", rules)
      refute MapTerrain.ignored?("item-3.md", rules)

      assert MapTerrain.ignored?("special-^.md", rules)
      assert MapTerrain.ignored?("special-[.md", rules)
      refute MapTerrain.ignored?("special-z.md", rules)

      assert MapTerrain.ignored?("literal-].md", rules)
      assert MapTerrain.ignored?("literal-x.md", rules)
      refute MapTerrain.ignored?("literal-y.md", rules)
    end

    test "fails closed when a .gitignore pattern fails to compile" do
      # Out-of-order range [z-a] fails PCRE compilation: non-negated rule fails closed
      # (ignores conservatively), negated rule does not un-ignore anything.
      rules = MapTerrain.parse_gitignore("[z-a].md\n")
      assert MapTerrain.ignored?("anything/secret.md", rules)

      neg_rules = MapTerrain.parse_gitignore("*.md\n![z-a].md\n")
      assert MapTerrain.ignored?("keep.md", neg_rules)
    end
  end

  describe "ms_to_iso/1" do
    test "formats valid millisecond timestamps and safely returns nil for out-of-range values" do
      assert MapTerrain.ms_to_iso(1_700_000_000_000) == "2023-11-14T22:13:20.000Z"
      assert MapTerrain.ms_to_iso(0) == nil
      assert MapTerrain.ms_to_iso(-1) == nil
      assert MapTerrain.ms_to_iso(nil) == nil
      # Year > 9999 (e.g. max 48-bit ULID timestamp) returns nil instead of raising.
      assert MapTerrain.ms_to_iso(281_474_976_710_655) == nil
      assert MapTerrain.ms_to_iso(999_999_999_999_999_999) == nil
    end
  end

  describe "city_state/5" do
    test "maps live columns, turns, and fallback document status" do
      assert MapTerrain.city_state("tempered", nil, "closed", nil, "oneshot") == "closed"
      assert MapTerrain.city_state("discarded", nil, "closed", nil, "oneshot") == "closed"
      assert MapTerrain.city_state("in_flight", "question", "active", nil, "oneshot") == "ask"
      assert MapTerrain.city_state("in_flight", "blocked", "active", nil, "oneshot") == "ask"
      assert MapTerrain.city_state("in_flight", "idle", "active", nil, "oneshot") == "ask"
      assert MapTerrain.city_state("awaiting_review", "none", "closed", nil, "oneshot") == "ask"
      assert MapTerrain.city_state("in_flight", "working", "active", nil, "oneshot") == "working"
      assert MapTerrain.city_state("drafts", "none", "open", nil, "oneshot") == "draft"
      assert MapTerrain.city_state("resting", "none", "open", "stashed", "oneshot") == "resting"

      assert MapTerrain.city_state(nil, nil, "closed", nil, "oneshot") == "closed"
      assert MapTerrain.city_state(nil, nil, "open", "stashed", "oneshot") == "resting"
      assert MapTerrain.city_state(nil, nil, "open", nil, "standing") == "resting"
      assert MapTerrain.city_state(nil, nil, "active", nil, "oneshot") == "resting"
      assert MapTerrain.city_state(nil, nil, "open", nil, "oneshot") == "draft"
    end
  end

  describe "build/1" do
    test "filters .gitignore rules, configured exclude entries, and escaping symlinks across base and mounted substores",
         %{tmp_dir: dir} do
      store = Path.join(dir, "main-store")
      felt = Path.join(store, ".felt")
      shared_store = Path.join(dir, "shared-store")
      shared_felt = Path.join(shared_store, ".felt")
      outside = Path.join(dir, "outside-secret.md")

      File.mkdir_p!(felt)
      File.mkdir_p!(shared_felt)
      File.write!(outside, "---\nname: Outside\n---\nsecret")
      File.ln_s!(shared_felt, Path.join(felt, "shared"))

      File.write!(Path.join(store, ".gitignore"), ".felt/ignored-dir/\n*.secret.md\n")
      File.write!(Path.join(felt, ".gitignore"), "felt-ignored/\n")
      File.write!(Path.join(shared_store, ".gitignore"), ".felt/hidden/\n")

      # Allowed base fibers (5 fibers under alpha -> full continent)
      for n <- 1..5 do
        id = "alpha/note-#{n}"
        write_fiber(felt, id, "---\nname: Note #{n}\n---\nbody #{n}\n")
      end

      # Configured exclude & gitignored base fibers
      write_fiber(felt, "life/private-zone/diary", "---\nname: Diary\n---\nprivate")
      write_fiber(felt, "scratch/drafts/note", "---\nname: Draft\n---\nprivate")
      write_fiber(felt, "ignored-dir/skip", "---\nname: Ignored\n---\nskip")
      write_fiber(felt, "felt-ignored/skip2", "---\nname: Felt Ignored\n---\nskip")

      # Escaping symlink directly inside .felt
      File.mkdir_p!(Path.join(felt, "escape"))
      File.ln_s!(outside, Path.join(felt, "escape/escape.md"))

      # Mounted substore fibers (5 fibers under shared/beta -> shared continent)
      for n <- 1..5 do
        write_fiber(shared_felt, "beta/item-#{n}", "---\nname: Shared #{n}\n---\nshared body")
      end

      # Gitignored in mounted substore
      write_fiber(shared_felt, "hidden/secret", "---\nname: Hidden\n---\nsecret")

      rows =
        Enum.map(1..5, &fiber_row("alpha/note-#{&1}")) ++
          [
            fiber_row("life/private-zone/diary"),
            fiber_row("scratch/drafts/note"),
            fiber_row("ignored-dir/skip"),
            fiber_row("felt-ignored/skip2"),
            fiber_row("escape"),
            fiber_row("shared/hidden/secret")
          ] ++
          Enum.map(1..5, &fiber_row("shared/beta/item-#{&1}"))

      Env.put_app_env(:map_terrain_rows, %{store => rows})

      assert {:ok, terrain} =
               MapTerrain.build(
                 stores: [store],
                 runner: CountingRunner,
                 composite: {%{}, %{}},
                 map_config: %{
                   merge: %{},
                   display: %{},
                   seas: %{},
                   pins: %{},
                   shared_rollup: nil,
                   exclude: ["private-zone", "scratch/drafts"],
                   guild_roots: []
                 }
               )

      continent_ids = Enum.map(terrain["continents"], & &1["id"])
      assert continent_ids == ["alpha", "shared/beta"]

      alpha = Enum.find(terrain["continents"], &(&1["id"] == "alpha"))
      beta = Enum.find(terrain["continents"], &(&1["id"] == "shared/beta"))

      assert alpha["total"] == 5
      assert alpha["shared"] == false
      assert beta["total"] == 5
      assert beta["shared"] == true

      all_item_ids =
        terrain["areas"]
        |> Enum.flat_map(& &1["fiberItems"])
        |> Enum.map(& &1["id"])

      refute "life/private-zone/diary" in all_item_ids
      refute "scratch/drafts/note" in all_item_ids
      refute "ignored-dir/skip" in all_item_ids
      refute "felt-ignored/skip2" in all_item_ids
      refute "escape" in all_item_ids
      refute "shared/hidden/secret" in all_item_ids
    end

    test "computes wikilinks, code-fence stripping, citedBy, areaLinks, domainLinks, guild, shoals, and live overlay",
         %{tmp_dir: dir} do
      store = Path.join(dir, "store")
      felt = Path.join(store, ".felt")
      File.mkdir_p!(felt)

      # Continent A with two areas (a1, a2) and two constitutions (parent + child)
      a1_uid = FiberUid.for("alpha/a1")
      a2_uid = FiberUid.for("alpha/a1/sub")
      b1_uid = FiberUid.for("beta/b1")

      a1_path =
        write_fiber(
          felt,
          "alpha/a1",
          """
          ---
          name: Alpha Hub
          see: "[[alpha/a2|A2]]"
          ---
          Links to [[alpha/a2#section]] and [[beta/b1]].
          Ignored in code: `[[alpha/ignored-inline]]`
          ```
          [[alpha/ignored-fence]]
          ```
          """
        )

      # Sibling tapestry.html triggers hasTapestry: true
      File.write!(Path.join(Path.dirname(a1_path), "tapestry.html"), "<html></html>")

      write_fiber(felt, "alpha/a1/sub", "---\nname: Sub\n---\nLinks back to [[alpha/a2]].\n")
      write_fiber(felt, "alpha/a2", "---\nname: Area Two\n---\nPlain note.\n")
      write_fiber(felt, "alpha/a3", "---\nname: Area Three\n---\nPlain note.\n")
      write_fiber(felt, "alpha/a4", "---\nname: Area Four\n---\nPlain note.\n")

      # Continent B (5 fibers)
      for n <- 1..5 do
        write_fiber(felt, "beta/b#{n}", "---\nname: Beta #{n}\n---\nRef [[alpha/a1]].\n")
      end

      # Guild root
      write_fiber(felt, "roles/steward", "---\nname: Steward\n---\nGuild role.\n")
      write_fiber(felt, "practices/testing", "---\nname: Testing\n---\nGuild practice.\n")

      # Small stray -> shoals
      write_fiber(felt, "misc-note/one", "---\nname: Misc One\n---\nStray.\n")

      # Small stray tagged "task" -> dropped
      write_fiber(felt, "chore", "---\nname: Chore\n---\nDropped reminder.\n")

      rows = [
        fiber_row("alpha/a1", %{
          "uid" => a1_uid,
          "name" => "Alpha Hub",
          "status" => "active",
          "tags" => ["decision"],
          "shuttle" => %{
            "host" => "host-a",
            "agent" => "claude-opus",
            "kind" => "oneshot",
            "role" => "orchestrator",
            "channel" => "ops"
          }
        }),
        fiber_row("alpha/a1/sub", %{
          "uid" => a2_uid,
          "name" => "Alpha Sub",
          "status" => "active",
          "depends_on" => ["beta/b1"],
          "inputs" => [%{"from" => "alpha/a2"}],
          "shuttle" => %{"host" => "host-b", "kind" => "standing"}
        }),
        fiber_row("alpha/a2"),
        fiber_row("alpha/a3"),
        fiber_row("alpha/a4"),
        fiber_row("beta/b1", %{
          "uid" => b1_uid,
          "status" => "closed",
          "tempered" => false,
          "shuttle" => %{"host" => "host-a", "kind" => "oneshot"}
        }),
        fiber_row("beta/b2"),
        fiber_row("beta/b3"),
        fiber_row("beta/b4"),
        fiber_row("beta/b5"),
        fiber_row("roles/steward"),
        fiber_row("practices/testing"),
        fiber_row("misc-note/one"),
        fiber_row("chore", %{"tags" => ["task"]})
      ]

      live_by_uid = %{
        a1_uid => %{
          column: "in_flight",
          turn: "working",
          origin: "host-a",
          rex_session: "Alpha"
        },
        a2_uid => %{
          column: "in_flight",
          turn: "question",
          origin: "host-b",
          rex_session: nil
        }
      }

      origins = %{
        "host-a" => %{"stale" => false, "fibers" => 2},
        "host-b" => %{"stale" => true, "fibers" => 1}
      }

      Env.put_app_env(:map_terrain_rows, %{store => rows})

      assert {:ok, terrain} =
               MapTerrain.build(
                 stores: [store],
                 runner: CountingRunner,
                 composite: {live_by_uid, origins},
                 map_config: %{merge: %{}, display: %{}, seas: %{}, pins: %{}, shared_rollup: nil}
               )

      assert terrain["origins"] == origins

      cont_by_id = Map.new(terrain["continents"], &{&1["id"], &1})
      assert Map.keys(cont_by_id) |> Enum.sort() == ["alpha", "beta", "guild", "shoals"]
      assert cont_by_id["guild"]["kind"] == "guild"
      assert cont_by_id["guild"]["name"] == "Guild & Commons"
      assert cont_by_id["guild"]["total"] == 2
      assert cont_by_id["shoals"]["kind"] == "shoals"
      assert cont_by_id["shoals"]["name"] == "Unfiled Shoals"
      assert cont_by_id["shoals"]["total"] == 1
      assert cont_by_id["alpha"]["decisionCount"] == 1

      # areaLinks requires w >= 2: alpha/a1 -> alpha/a2 happens twice (a1 + a1/sub both link a2)
      assert %{"a" => "alpha/a1", "b" => "alpha/a2", "w" => 2} in terrain["areaLinks"]

      # domainLinks between alpha and beta: 5 beta fibers link alpha/a1 + 2 alpha fibers link beta/b1 = 7
      assert %{"a" => "alpha", "b" => "beta", "w" => 7} in terrain["domainLinks"]

      city_by_id = Map.new(terrain["cities"], &{&1["id"], &1})

      a1_city = city_by_id["alpha/a1"]
      assert a1_city["state"] == "working"
      assert a1_city["live"] == true
      assert a1_city["origin"] == "host-a"
      assert a1_city["host"] == "host-a"
      assert a1_city["rexSession"] == "Alpha"
      assert a1_city["hasTapestry"] == true
      assert a1_city["isOrchestrator"] == true
      assert a1_city["citedBy"] == 5

      a2_city = city_by_id["alpha/a1/sub"]
      assert a2_city["state"] == "ask"
      assert a2_city["parent"] == "alpha/a1"
      assert a2_city["origin"] == "host-b"
      assert a2_city["kind"] == "standing"

      b1_city = city_by_id["beta/b1"]
      assert b1_city["state"] == "closed"
      assert b1_city["tempered"] == false
      assert b1_city["live"] == false
      assert b1_city["citedBy"] == 2
    end

    test "applies optional map.json merge, display, seas, pins, shared_rollup, exclude, and guild_roots",
         %{tmp_dir: dir} do
      store = Path.join(dir, "store")
      felt = Path.join(store, ".felt")
      shared_store = Path.join(dir, "shared-store")
      shared_felt = Path.join(shared_store, ".felt")
      File.mkdir_p!(felt)
      File.mkdir_p!(shared_felt)
      File.ln_s!(shared_felt, Path.join(felt, "team"))

      for n <- 1..5 do
        write_fiber(felt, "part-a/f#{n}", "---\nname: A#{n}\n---\n")
        write_fiber(felt, "part-b/f#{n}", "---\nname: B#{n}\n---\n")
        write_fiber(shared_felt, "quiet-proj/q#{n}", "---\nname: Q#{n}\n---\n")
      end

      write_fiber(felt, "meta/note", "---\nname: Meta\n---\n")
      write_fiber(felt, "vault/secret", "---\nname: Secret\n---\n")

      rows =
        Enum.map(1..5, &fiber_row("part-a/f#{&1}")) ++
          Enum.map(1..5, &fiber_row("part-b/f#{&1}")) ++
          Enum.map(1..5, &fiber_row("team/quiet-proj/q#{&1}")) ++
          [fiber_row("meta/note"), fiber_row("vault/secret")]

      config_path = Path.join(dir, "map.json")

      File.write!(
        config_path,
        Jason.encode!(%{
          "merge" => %{"part-a" => "unified", "part-b" => "unified"},
          "display" => %{"unified" => "Unified Lab", "team/archive" => "Team Archive"},
          "seas" => %{"unified" => %{"sea" => "north", "x" => -5, "z" => 4}},
          "pins" => %{"unified" => %{"q" => 1, "r" => -1}},
          "exclude" => ["vault"],
          "guild_roots" => ["meta"],
          "shared_rollup" => %{
            "mount" => "team",
            "target" => "team/archive",
            "max_cities" => 2
          }
        })
      )

      Env.put_env("SHUTTLE_MAP_CONFIG", config_path)
      Env.put_app_env(:map_terrain_rows, %{store => rows})

      assert {:ok, terrain} =
               MapTerrain.build(
                 stores: [store],
                 runner: CountingRunner,
                 composite: {%{}, %{}}
               )

      assert terrain["mapConfig"] == %{
               "seas" => %{"unified" => %{"sea" => "north", "x" => -5, "z" => 4}},
               "pins" => %{"unified" => %{"q" => 1, "r" => -1}}
             }

      cont_by_id = Map.new(terrain["continents"], &{&1["id"], &1})
      assert Map.keys(cont_by_id) |> Enum.sort() == ["guild", "team/archive", "unified"]
      assert cont_by_id["guild"]["total"] == 1
      assert cont_by_id["unified"]["name"] == "Unified Lab"
      assert cont_by_id["unified"]["total"] == 10
      assert cont_by_id["team/archive"]["name"] == "Team Archive"
      assert cont_by_id["team/archive"]["total"] == 5

      all_ids = terrain["areas"] |> Enum.flat_map(& &1["fiberItems"]) |> Enum.map(& &1["id"])
      refute "vault/secret" in all_ids
    end

    test "returns {:error, reason} when configured stores are non-empty and every store fails, and {:ok, empty} when stores is []",
         %{tmp_dir: dir} do
      store1 = Path.join(dir, "s1")
      store2 = Path.join(dir, "s2")
      File.mkdir_p!(Path.join(store1, ".felt"))
      File.mkdir_p!(Path.join(store2, ".felt"))

      Env.put_app_env(:map_terrain_responses, %{
        store1 => {"boom-1", 1},
        store2 => {"boom-2", 2}
      })

      assert {:error, {:command_error, 2, "boom-2"}} =
               MapTerrain.build(
                 stores: [store1, store2],
                 runner: CountingRunner,
                 composite: {%{}, %{}},
                 map_config: %{merge: %{}, display: %{}, seas: %{}, pins: %{}, shared_rollup: nil}
               )

      assert {:ok, empty} =
               MapTerrain.build(
                 stores: [],
                 runner: CountingRunner,
                 composite: {%{}, %{}},
                 map_config: %{merge: %{}, display: %{}, seas: %{}, pins: %{}, shared_rollup: nil}
               )

      assert empty["continents"] == []
      assert empty["areas"] == []
      assert empty["cities"] == []
    end

    test "handles out-of-range ULID timestamps without raising", %{tmp_dir: dir} do
      store = Path.join(dir, "store")
      felt = Path.join(store, ".felt")
      File.mkdir_p!(felt)
      write_fiber(felt, "proj/huge", "---\nname: Huge\n---\n")

      row =
        fiber_row("proj/huge", %{
          "uid" => "7ZZZZZZZZZ0000000000000000",
          "created_at" => nil,
          "modified_at" => nil
        })

      Env.put_app_env(:map_terrain_rows, %{store => [row]})

      assert {:ok, terrain} =
               MapTerrain.build(
                 stores: [store],
                 runner: CountingRunner,
                 composite: {%{}, %{}},
                 map_config: %{merge: %{}, display: %{}, seas: %{}, pins: %{}, shared_rollup: nil}
               )

      assert [%{"lastUpdated" => nil}] = terrain["continents"]
    end
  end

  describe "fetch/1 ETS caching and stale-while-revalidate" do
    test "serves fresh entries from ETS, serves stale while revalidating asynchronously, and coalesces concurrent refreshes",
         %{tmp_dir: dir} do
      store = Path.join(dir, "store")
      felt = Path.join(store, ".felt")
      File.mkdir_p!(felt)
      write_fiber(felt, "proj/a", "---\nname: A\n---\n")
      write_fiber(felt, "proj/b", "---\nname: B\n---\n")

      counter = start_supervised!({Agent, fn -> 0 end})
      Env.put_app_env(:map_terrain_counter, counter)
      Env.put_app_env(:map_terrain_rows, %{store => [fiber_row("proj/a")]})
      MapTerrain.clear_cache()
      on_exit(fn -> MapTerrain.clear_cache() end)

      opts = [
        stores: [store],
        runner: CountingRunner,
        composite: {%{}, %{}},
        map_config: %{merge: %{}, display: %{}, seas: %{}, pins: %{}, shared_rollup: nil}
      ]

      # Cold miss builds synchronously and populates ETS.
      assert :ets.whereis(:shuttle_map_terrain_cache) != :undefined
      assert {:ok, first} = MapTerrain.fetch(opts ++ [monotonic_ms: 1_000])
      assert Agent.get(counter, & &1) == 1
      assert [%{"total" => 1}] = first["continents"]

      # Fresh hit (< 120s) returns cached payload without rebuilding.
      assert {:ok, second} = MapTerrain.fetch(opts ++ [monotonic_ms: 60_000])
      assert second == first
      assert Agent.get(counter, & &1) == 1

      # Mutate backing data and trigger stale fetch (>= 120s): returns stale payload
      # immediately while a single coalesced background task refreshes ETS.
      Env.put_app_env(:map_terrain_rows, %{store => [fiber_row("proj/a"), fiber_row("proj/b")]})
      parent = self()
      stale_opts = opts ++ [monotonic_ms: 121_000, on_refresh: fn -> send(parent, :refreshed) end]

      assert {:ok, stale1} = MapTerrain.fetch(stale_opts)
      assert stale1 == first
      assert {:ok, stale2} = MapTerrain.fetch(stale_opts)
      assert stale2 == first

      assert_receive :refreshed
      refute_receive :refreshed, 50
      assert Agent.get(counter, & &1) == 2

      # Next fetch reads the refreshed entry from ETS.
      assert {:ok, refreshed} = MapTerrain.fetch(opts ++ [monotonic_ms: 121_000])
      assert [%{"total" => 2}] = refreshed["continents"]
      assert Agent.get(counter, & &1) == 2

      # clear_cache/0 forces a synchronous rebuild.
      MapTerrain.clear_cache()
      assert {:ok, _after_clear} = MapTerrain.fetch(opts ++ [monotonic_ms: 122_000])
      assert Agent.get(counter, & &1) == 3
    end
  end
end
