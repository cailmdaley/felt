defmodule ShuttleWeb.FeltNestControllerTest do
  use ExUnit.Case, async: true
  import Shuttle.Test.ApiConn
  import Plug.Conn
  import Phoenix.ConnTest

  alias Shuttle.Test.{Env, FakeCli, ForwardStub, StubPostClient}

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

  test "forwards a remote-origin nest to the owning daemon, origin stripped, relaying its response" do
    ForwardStub.stub_forward(
      "candide",
      "http://localhost:4001",
      {:ok, 200, "tests/parent/child\n"},
      StubPostClient
    )

    conn =
      post(
        api_conn(),
        "/api/v1/felt-nest",
        Jason.encode!(%{
          "fiber_id" => "tests/child",
          "parent" => "tests/parent",
          "origin" => "candide"
        })
      )

    # The owning daemon's response is relayed verbatim.
    assert conn.status == 200
    assert conn.resp_body == "tests/parent/child\n"

    # Forwarded to the owning remote's identical /felt-nest, origin stripped so
    # the owner re-parents within its own store.
    last = StubPostClient.last()
    assert last.url == "http://localhost:4001/api/v1/felt-nest"
    forwarded = Jason.decode!(last.body)
    refute Map.has_key?(forwarded, "origin")
    assert forwarded["fiber_id"] == "tests/child"
    assert forwarded["parent"] == "tests/parent"
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

    args_file = Path.join(root, "felt-args")

    FakeCli.install!(%{
      "felt" => """
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
      """
    })

    Env.put_env("FELT_ARGS_FILE", args_file)
    Env.put_env("SHUTTLE_STORES", store)

    on_exit(fn ->
      File.rm_rf(root)
    end)

    {store, args_file}
  end
end
