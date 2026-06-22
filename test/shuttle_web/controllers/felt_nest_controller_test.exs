defmodule ShuttleWeb.FeltNestControllerTest do
  use ExUnit.Case
  import Plug.Conn
  import Phoenix.ConnTest

  @endpoint ShuttleWeb.Endpoint

  test "nest shells felt nest <fiber> <parent> against the owning store" do
    {store, args_file} = setup_store!("nest")

    conn =
      post(
        api_conn(),
        "/api/v1/felt-nest",
        Jason.encode!(%{"fiber_id" => "tests/child", "parent" => "tests/parent"})
      )

    assert conn.status == 200
    assert File.read!(args_file) == "-C\n#{store}\nnest\ntests/child\ntests/parent\n"
  end

  test "parent: null shells felt unnest <fiber>" do
    {store, args_file} = setup_store!("unnest")

    conn =
      post(
        api_conn(),
        "/api/v1/felt-nest",
        Jason.encode!(%{"fiber_id" => "tests/child", "parent" => nil})
      )

    assert conn.status == 200
    assert File.read!(args_file) == "-C\n#{store}\nunnest\ntests/child\n"
  end

  test "a missing parent key is a 400, not a silent unnest" do
    {_store, args_file} = setup_store!("missing-parent")

    conn =
      post(api_conn(), "/api/v1/felt-nest", Jason.encode!(%{"fiber_id" => "tests/child"}))

    assert conn.status == 400
    assert conn.resp_body =~ "parent is required"
    refute File.exists?(args_file)
  end

  defp api_conn do
    build_conn()
    |> put_req_header("content-type", "application/json")
    |> put_req_header("accept", "application/json")
  end

  # A fake felt on PATH: `show <id> -j` answers FeltStores.resolve_fiber with
  # felt-shaped JSON echoing the requested id; any other invocation (the
  # nest/unnest under test) records its args and prints ok.
  defp setup_store!(label) do
    root =
      System.tmp_dir!()
      |> Path.join("shuttle-felt-nest-#{label}-#{System.unique_integer([:positive])}")

    store = Path.join(root, "loom")
    File.mkdir_p!(Path.join(store, ".felt"))

    bin_dir = Path.join(root, "bin")
    File.mkdir_p!(bin_dir)
    bin = Path.join(bin_dir, "felt")
    args_file = Path.join(root, "felt-args")

    File.write!(bin, """
    #!/bin/sh
    case " $* " in
      *" show "*)
        store=""
        id=""
        next_store=0
        next_id=0
        for a in "$@"; do
          if [ "$next_store" = 1 ]; then store="$a"; next_store=0; fi
          if [ "$next_id" = 1 ] && [ "$id" = "" ]; then id="$a"; next_id=0; fi
          if [ "$a" = "-C" ]; then next_store=1; fi
          if [ "$a" = "show" ]; then next_id=1; fi
        done
        printf '{"id":"%s","path":"%s/.felt/%s/x.md"}\\n' "$id" "$store" "$id"
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
    old_loom_homes = System.get_env("LOOM_HOMES")

    System.put_env("PATH", bin_dir <> ":" <> (old_path || ""))
    System.put_env("FELT_ARGS_FILE", args_file)
    System.put_env("LOOM_HOMES", store)

    on_exit(fn ->
      restore_env("PATH", old_path)
      restore_env("FELT_ARGS_FILE", old_args_file)
      restore_env("LOOM_HOMES", old_loom_homes)
      File.rm_rf(root)
    end)

    {store, args_file}
  end

  defp restore_env(key, nil), do: System.delete_env(key)
  defp restore_env(key, value), do: System.put_env(key, value)
end
