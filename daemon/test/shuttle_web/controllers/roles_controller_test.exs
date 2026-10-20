defmodule ShuttleWeb.RolesControllerTest do
  use ExUnit.Case, async: true
  import Shuttle.Test.ApiConn
  import Phoenix.ConnTest

  alias Shuttle.Test.Env
  @endpoint ShuttleWeb.Endpoint

  defmodule Runner do
    @behaviour Shuttle.Runner
    def cmd("shuttle", ["-C", store, "roles", "--json"] = args, _opts) do
      send(Shuttle.Env.app(:roles_observer), {:roles_read, args})
      Shuttle.Env.app(:roles_reply).(store)
    end
  end

  setup do
    root = Path.join(System.tmp_dir!(), "roles-read-#{System.unique_integer([:positive])}")
    stores = Enum.map(["one", "two"], &Path.join(root, &1))
    Enum.each(stores, &File.mkdir_p!(Path.join(&1, ".felt")))
    Env.put_env("SHUTTLE_STORES", Enum.join(stores, ","))
    Env.put_app_env(:felt_runner, Runner)
    Env.put_app_env(:roles_observer, self())
    on_exit(fn -> File.rm_rf!(root) end)
    {:ok, stores: stores}
  end

  test "reads configured stores through Shuttle and returns unique sorted profiles", %{
    stores: [one, two]
  } do
    editor = %{"slug" => "editor", "name" => "Editor", "outcome" => "Keeps text true."}
    warden = %{"slug" => "warden", "name" => "Warden", "outcome" => ""}

    Env.put_app_env(:roles_reply, fn
      ^one -> {Jason.encode!([warden, editor]), 0}
      ^two -> {Jason.encode!([editor]), 0}
    end)

    conn = get(api_conn(), "/api/v1/roles")
    assert conn.status == 200
    assert Jason.decode!(conn.resp_body) == [editor, warden]
    assert_receive {:roles_read, ["-C", ^one, "roles", "--json"]}
    assert_receive {:roles_read, ["-C", ^two, "roles", "--json"]}
  end

  test "CLI failures and malformed responses degrade to an empty array" do
    for response <- [{"unavailable", 127}, {"not json", 0}, {"{}", 0}, {"[null, 1, {}]", 0}] do
      Env.put_app_env(:roles_reply, fn _ -> response end)
      conn = get(api_conn(), "/api/v1/roles")
      assert conn.status == 200
      assert Jason.decode!(conn.resp_body) == []
    end
  end
end
