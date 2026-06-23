defmodule Shuttle.FeltStoresTest do
  use ExUnit.Case, async: false

  alias Shuttle.FeltStores

  setup do
    prev = System.get_env("FELT_STORES")

    on_exit(fn ->
      case prev do
        nil -> System.delete_env("FELT_STORES")
        v -> System.put_env("FELT_STORES", v)
      end
    end)

    :ok
  end

  describe "empty resolution (the de-loom invariant)" do
    setup do
      prev_file = System.get_env("FELT_STORES_FILE")

      on_exit(fn ->
        case prev_file do
          nil -> System.delete_env("FELT_STORES_FILE")
          v -> System.put_env("FELT_STORES_FILE", v)
        end
      end)

      :ok
    end

    test "configured_hosts/0 is [] when nothing is configured — no implicit ~/loom default" do
      System.delete_env("FELT_STORES")
      # An explicit override at an absent path also suppresses the legacy
      # ~/.shuttle fallback, so resolution is genuinely empty (not the user's
      # real ~/.config/felt/stores.json).
      System.put_env("FELT_STORES_FILE", Path.join(tmp_dir(), "absent.json"))

      assert FeltStores.configured_hosts() == []
    end

    test "FELT_STORES env still wins over an absent registry" do
      System.put_env("FELT_STORES_FILE", Path.join(tmp_dir(), "absent.json"))
      store = tmp_dir()
      System.put_env("FELT_STORES", store)

      assert FeltStores.configured_hosts() == [Path.expand(store)]
    end
  end

  describe "host_for_fiber/1" do
    test "resolves a loom-resident fiber by its full store-relative slug" do
      loom = tmp_dir()
      write_fiber(Path.join(loom, ".felt"), ["ai-futures", "portolan", "debug"])
      System.put_env("FELT_STORES", loom)

      assert {:ok, host} = FeltStores.host_for_fiber("ai-futures/portolan/debug")
      assert Path.expand(host) == Path.expand(loom)
    end

    test "resolves a nested fiber by its full slug, and felt fuzzy-matches the bare leaf" do
      loom = tmp_dir()
      write_fiber(Path.join(loom, ".felt"), ["a", "b"])
      System.put_env("FELT_STORES", loom)

      assert {:ok, _} = FeltStores.host_for_fiber("a/b")

      # Resolution now asks felt, and `felt show b` fuzzy-matches the bare leaf
      # to its addressable slug `a/b` (basename match) — the same fiber every
      # other felt surface resolves `b` to. The resolver therefore returns the
      # real fiber's address and physical path rather than the old daemon-strict
      # `:not_found`. A looser match, never a wrong-fiber one.
      assert {:ok, %{fiber_id: "a/b"}} = FeltStores.resolve_fiber("b")
    end

    # The candide topology: a project's .felt symlinked into loom as a sub-path.
    # The canonical id is the bare leaf (realpath lands in the project's .felt),
    # while the file is reachable under loom only via the symlinked prefix. The
    # project store is auto-discovered from the loom symlink, so the fiber is
    # owned by its physically-rooting project store (where its felt history also
    # lives) — not loom.
    test "resolves a project-resident (prefix-drop) fiber to its project store" do
      loom = tmp_dir()
      project = tmp_dir()
      File.mkdir_p!(Path.join(loom, ".felt"))
      write_fiber(Path.join(project, ".felt"), ["review-ngmix-v2-pr740"])
      File.ln_s!(Path.join(project, ".felt"), Path.join([loom, ".felt", "shapepipe"]))
      System.put_env("FELT_STORES", loom)

      assert {:ok, host} = FeltStores.host_for_fiber("review-ngmix-v2-pr740")
      assert same_dir?(host, project)
    end

    # Regression: a FLAT fiber (`<leaf>.md` directly in .felt, no enclosing
    # `<leaf>/` dir) must resolve by its leaf. The first canonical-resolver fix
    # only matched the dir-contained layout, so flat fibers 400'd "fiber not
    # found" — e.g. dragging "SP Validation Restructuring" to In flight.
    test "resolves a flat fiber (`<leaf>.md` directly in the store)" do
      loom = tmp_dir()
      felt = Path.join(loom, ".felt")
      File.mkdir_p!(felt)
      File.write!(Path.join(felt, "flat-fiber.md"), "---\nname: Flat\n---\n\nBody.\n")
      System.put_env("FELT_STORES", loom)

      assert {:ok, host} = FeltStores.host_for_fiber("flat-fiber")
      assert Path.expand(host) == Path.expand(loom)
    end

    # The exact sp-validation-restructuring shape: a flat fiber inside a
    # symlinked sub-store, resolved by its bare leaf to its project store.
    test "resolves a flat fiber inside a symlinked store to its project store" do
      loom = tmp_dir()
      project = tmp_dir()
      File.mkdir_p!(Path.join(loom, ".felt"))
      pfelt = Path.join(project, ".felt")
      File.mkdir_p!(pfelt)
      File.write!(Path.join(pfelt, "sp-validation-restructuring.md"), "---\nname: SP\n---\n")
      File.ln_s!(pfelt, Path.join([loom, ".felt", "sp_validation"]))
      System.put_env("FELT_STORES", loom)

      assert {:ok, host} = FeltStores.host_for_fiber("sp-validation-restructuring")
      assert same_dir?(host, project)
    end

    test "resolves an intrinsic UID to the felt address and host" do
      loom = tmp_dir()
      uid = "01KTCWJ8F2DF0VY3E6W92Q7H8M"
      write_fiber(Path.join(loom, ".felt"), ["tests", "uid-card"], id: uid)
      System.put_env("FELT_STORES", loom)

      assert {:ok, %{host: host, fiber_id: "tests/uid-card", uid: ^uid, path: path}} =
               FeltStores.resolve_fiber(uid)

      assert Path.expand(host) == Path.expand(loom)
      assert path =~ "uid-card.md"
      assert {:ok, ^host} = FeltStores.host_for_fiber(uid)
    end

    test "returns :not_found for an unknown fiber" do
      loom = tmp_dir()
      File.mkdir_p!(Path.join(loom, ".felt"))
      System.put_env("FELT_STORES", loom)

      assert {:error, :not_found} = FeltStores.host_for_fiber("does-not-exist")
    end
  end

  describe "configured_hosts/0 symlinked-substore discovery" do
    # The candide topology: a project's `.felt` symlinked into loom. The poller
    # enumerates a fiber only from the store it physically roots in, so the
    # project root must be a store. Following the loom symlink auto-discovers it,
    # so configuring just loom suffices.
    test "auto-discovers a symlinked substore's project root from a configured loom" do
      loom = tmp_dir()
      project = tmp_dir()
      File.mkdir_p!(Path.join(loom, ".felt"))
      File.mkdir_p!(Path.join(project, ".felt"))
      File.ln_s!(Path.join(project, ".felt"), Path.join([loom, ".felt", "shapepipe"]))
      System.put_env("FELT_STORES", loom)

      hosts = FeltStores.configured_hosts()

      assert Enum.any?(hosts, &same_dir?(&1, loom))
      assert Enum.any?(hosts, &same_dir?(&1, project))
    end

    # Candide's REAL topology nests substores under the tree mirror:
    # loom/.felt/science/unions/shapepipe -> project/.felt. Discovery must recurse
    # into real subdirectories, not just read the top level of loom/.felt — else
    # the project store is never found and its fibers vanish from the kanban (the
    # exact bug that drove the shapepipe constitution to be copied into loom).
    test "auto-discovers a NESTED symlinked substore (science/unions/shapepipe)" do
      loom = tmp_dir()
      project = tmp_dir()
      nested = Path.join([loom, ".felt", "science", "unions"])
      File.mkdir_p!(nested)
      File.mkdir_p!(Path.join(project, ".felt"))
      File.ln_s!(Path.join(project, ".felt"), Path.join(nested, "shapepipe"))
      System.put_env("FELT_STORES", loom)

      hosts = FeltStores.configured_hosts()

      assert Enum.any?(hosts, &same_dir?(&1, loom))
      assert Enum.any?(hosts, &same_dir?(&1, project))
    end

    # The walk recurses into real dirs only; it must NOT follow a symlink during
    # traversal (that could loop or wander into another store's tree). A substore
    # hidden behind an intermediate symlinked directory is therefore intentionally
    # NOT discovered — only direct substore links (entry -> .../.felt) are.
    test "does not traverse THROUGH an intermediate symlinked directory" do
      loom = tmp_dir()
      elsewhere = tmp_dir()
      project = tmp_dir()
      File.mkdir_p!(Path.join(loom, ".felt"))

      inner = Path.join(elsewhere, "inner")
      File.mkdir_p!(inner)
      File.mkdir_p!(Path.join(project, ".felt"))
      # A genuine substore link, but parked behind a symlinked gateway directory.
      File.ln_s!(Path.join(project, ".felt"), Path.join(inner, "shapepipe"))
      File.ln_s!(elsewhere, Path.join([loom, ".felt", "gateway"]))
      System.put_env("FELT_STORES", loom)

      hosts = FeltStores.configured_hosts()

      refute Enum.any?(hosts, &same_dir?(&1, project))
      assert hosts == [Path.expand(loom)]
    end

    test "skips a dangling substore symlink" do
      loom = tmp_dir()
      File.mkdir_p!(Path.join(loom, ".felt"))
      File.ln_s!("/no/such/path/.felt", Path.join([loom, ".felt", "ghost"]))
      System.put_env("FELT_STORES", loom)

      assert FeltStores.configured_hosts() == [Path.expand(loom)]
    end

    test "skips a symlink to a non-.felt directory" do
      loom = tmp_dir()
      other = tmp_dir()
      File.mkdir_p!(Path.join(loom, ".felt"))
      File.ln_s!(other, Path.join([loom, ".felt", "not-a-substore"]))
      System.put_env("FELT_STORES", loom)

      assert FeltStores.configured_hosts() == [Path.expand(loom)]
    end

    # Realpath dedup is load-bearing: a store reached via two spellings of the
    # same real dir must be listed once, or its fibers enumerate twice (dispatch
    # race). Here `alias` is a symlink to `project`, and `project` is also
    # discovered via loom's substore link — they share a `.felt` realpath.
    test "dedups by realpath when the same store is reached two ways" do
      loom = tmp_dir()
      project = tmp_dir()
      File.mkdir_p!(Path.join(loom, ".felt"))
      File.mkdir_p!(Path.join(project, ".felt"))
      File.ln_s!(Path.join(project, ".felt"), Path.join([loom, ".felt", "shapepipe"]))

      alias_link = Path.join(tmp_dir(), "alias")
      File.ln_s!(project, alias_link)
      System.put_env("FELT_STORES", "#{loom},#{alias_link}")

      hosts = FeltStores.configured_hosts()

      # `alias_link` (explicit) and `project` (discovered via loom) are the same
      # real dir, so exactly one survives the realpath dedup.
      assert Enum.count(hosts, &same_dir?(&1, project)) == 1
    end

    # Regression (the lightcone topology). A project store whose `.felt` is a REAL
    # directory, plus a parent store whose own `.felt` is a SYMLINK into it — both
    # configured, sharing one `.felt` realpath. The dedup keeps exactly one, and it
    # MUST be the real-directory store: the poller's `list_shuttle_fibers/2` returns
    # `{:ok, []}` for any store whose `.felt` is a symlink, so keeping the symlink
    # store would make every fiber under that realpath vanish from dispatch and the
    # kanban. The symlink store is configured FIRST, so a naive first-wins `uniq_by`
    # would keep it (the pre-fix bug).
    test "dedup keeps the real-.felt store over a symlink-.felt store sharing its realpath" do
      parent = tmp_dir()
      project = Path.join(parent, "lightcone")
      File.mkdir_p!(Path.join(project, ".felt"))
      File.ln_s!(Path.join(project, ".felt"), Path.join(parent, ".felt"))
      System.put_env("FELT_STORES", "#{parent},#{project}")

      hosts = FeltStores.configured_hosts()

      survivors =
        Enum.filter(hosts, &same_dir?(Path.join(&1, ".felt"), Path.join(project, ".felt")))

      assert length(survivors) == 1
      [survivor] = survivors
      assert File.lstat!(Path.join(survivor, ".felt")).type == :directory
    end
  end

  defp write_fiber(felt_dir, slug_segments, opts \\ []) do
    leaf = List.last(slug_segments)
    dir = Path.join([felt_dir | slug_segments])
    File.mkdir_p!(dir)
    path = Path.join(dir, "#{leaf}.md")

    id_field =
      case Keyword.get(opts, :id) do
        nil -> ""
        id -> "id: #{id}\n"
      end

    File.write!(path, "---\n#{id_field}name: #{leaf}\n---\n\nBody.\n")
    path
  end

  defp tmp_dir do
    dir = Path.join(System.tmp_dir!(), "felt_stores_test_#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)
    on_exit(fn -> File.rm_rf!(dir) end)
    dir
  end

  # Same on-disk directory regardless of path spelling — robust to macOS's
  # `/var -> /private/var` and to a store returned in realpath form.
  defp same_dir?(a, b) do
    with {:ok, sa} <- File.stat(a), {:ok, sb} <- File.stat(b) do
      {sa.major_device, sa.minor_device, sa.inode} == {sb.major_device, sb.minor_device, sb.inode}
    else
      _ -> false
    end
  end
end
