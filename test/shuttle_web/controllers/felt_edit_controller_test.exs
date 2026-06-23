defmodule ShuttleWeb.FeltEditControllerTest do
  use ExUnit.Case
  import Plug.Conn
  import Phoenix.ConnTest

  @endpoint ShuttleWeb.Endpoint

  test "applies a tag diff against the configured felt store that owns the fiber" do
    root =
      System.tmp_dir!()
      |> Path.join("shuttle-felt-edit-controller-#{System.unique_integer([:positive])}")

    store = Path.join(root, "loom")
    fiber_dir = Path.join([store, ".felt", "tests", "remote-tags"])
    File.mkdir_p!(fiber_dir)

    File.write!(
      Path.join(fiber_dir, "remote-tags.md"),
      "---\nname: Remote tags\nstatus: active\n---\n\nbody\n"
    )

    args_file = install_fake_felt!(root)
    old_loom_homes = System.get_env("FELT_STORES")
    System.put_env("FELT_STORES", store)

    on_exit(fn ->
      restore_env("FELT_STORES", old_loom_homes)
      File.rm_rf(root)
    end)

    conn =
      post(
        api_conn(),
        "/api/v1/felt-edit",
        Jason.encode!(%{
          "fiber_id" => "tests/remote-tags",
          "remove" => ["old"],
          "add" => ["constitution", "new"]
        })
      )

    assert conn.status == 200

    # Removes first, then adds — the same order Portolan's local `runFeltTagEdit`
    # shells, so `felt edit` sees one coherent diff.
    assert File.read!(args_file) ==
             "-C\n#{store}\nedit\ntests/remote-tags\n--untag\nold\n--tag\nconstitution\n--tag\nnew\n"
  end

  test "routes a horizon edit through felt edit --unset/--set/--due" do
    root =
      System.tmp_dir!()
      |> Path.join("shuttle-felt-edit-horizon-#{System.unique_integer([:positive])}")

    store = Path.join(root, "loom")
    fiber_dir = Path.join([store, ".felt", "tests", "remote-tags"])
    File.mkdir_p!(fiber_dir)

    File.write!(
      Path.join(fiber_dir, "remote-tags.md"),
      "---\nname: Remote tags\nstatus: active\n---\n\nbody\n"
    )

    args_file = install_fake_felt!(root)
    old_loom_homes = System.get_env("FELT_STORES")
    System.put_env("FELT_STORES", store)

    on_exit(fn ->
      restore_env("FELT_STORES", old_loom_homes)
      File.rm_rf(root)
    end)

    conn =
      post(
        api_conn(),
        "/api/v1/felt-edit",
        Jason.encode!(%{
          "fiber_id" => "tests/remote-tags",
          "set" => %{"horizon" => "stashed", "cold" => true},
          "unset" => [],
          "due" => nil
        })
      )

    assert conn.status == 200

    # Boolean preserved as a YAML-typed scalar argument; `due: null` clears via
    # an empty --due. Set args appear in map order; cold/horizon both present.
    args = File.read!(args_file)
    assert args =~ "--set\nhorizon=stashed\n"
    assert args =~ "--set\ncold=true\n"
    assert args =~ "--due\n\n"
    assert String.starts_with?(args, "-C\n#{store}\nedit\ntests/remote-tags\n")
  end

  test "an empty diff is a 200 no-op that never shells felt edit" do
    root =
      System.tmp_dir!()
      |> Path.join("shuttle-felt-edit-noop-#{System.unique_integer([:positive])}")

    store = Path.join(root, "loom")
    fiber_dir = Path.join([store, ".felt", "tests", "remote-tags"])
    File.mkdir_p!(fiber_dir)

    File.write!(
      Path.join(fiber_dir, "remote-tags.md"),
      "---\nname: Remote tags\nstatus: active\n---\n\nbody\n"
    )

    args_file = install_fake_felt!(root)
    old_loom_homes = System.get_env("FELT_STORES")
    System.put_env("FELT_STORES", store)

    on_exit(fn ->
      restore_env("FELT_STORES", old_loom_homes)
      File.rm_rf(root)
    end)

    conn =
      post(
        api_conn(),
        "/api/v1/felt-edit",
        Jason.encode!(%{"fiber_id" => "tests/remote-tags", "add" => [], "remove" => []})
      )

    assert conn.status == 200
    refute File.exists?(args_file)
  end

  defp api_conn do
    build_conn()
    |> put_req_header("content-type", "application/json")
    |> put_req_header("accept", "application/json")
  end

  defp install_fake_felt!(root) do
    bin_dir = Path.join(root, "bin")
    File.mkdir_p!(bin_dir)

    bin = Path.join(bin_dir, "felt")
    args_file = Path.join(root, "felt-args")

    # `FeltStores.resolve_fiber` asks felt for the fiber's carried path
    # (`felt show -j`), so the fake answers that with felt-shaped JSON (id +
    # absolute path). The `edit` invocation under test records its args and
    # prints `ok`.
    File.write!(bin, """
    #!/bin/sh
    case " $* " in
      *" show "*" -j "*|*" show "*" -j")
        store=""
        next=0
        for a in "$@"; do
          if [ "$next" = 1 ]; then store="$a"; next=0; fi
          if [ "$a" = "-C" ]; then next=1; fi
        done
        printf '{"id":"tests/remote-tags","path":"%s/.felt/tests/remote-tags/remote-tags.md"}\\n' "$store"
        ;;
      *)
        printf '%s\\n' "$@" > "$FELT_ARGS_FILE"
        printf 'ok\\n'
        ;;
    esac
    """)

    File.chmod!(bin, 0o755)

    old_path = System.get_env("PATH")
    old_args_file = System.get_env("FELT_ARGS_FILE")

    System.put_env("PATH", bin_dir <> ":" <> (old_path || ""))
    System.put_env("FELT_ARGS_FILE", args_file)

    on_exit(fn ->
      restore_env("PATH", old_path)
      restore_env("FELT_ARGS_FILE", old_args_file)
    end)

    args_file
  end

  defp restore_env(key, nil), do: System.delete_env(key)
  defp restore_env(key, value), do: System.put_env(key, value)
end
