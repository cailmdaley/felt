defmodule ShuttleWeb.FeltStoresControllerTest do
  use ExUnit.Case
  import Shuttle.Test.ApiConn
  import Plug.Conn
  import Phoenix.ConnTest

  @endpoint ShuttleWeb.Endpoint

  setup do
    original = System.get_env("FELT_STORES_FILE")
    original_remotes = Application.get_env(:shuttle, :remotes)

    # FELT_STORES env WINS over the registry file (FeltStores resolution
    # order), so an operator shell exporting it leaks into every assertion
    # here. Clear it for the test; restore after.
    original_env_stores = System.get_env("FELT_STORES")
    System.delete_env("FELT_STORES")

    path =
      Path.join(
        System.tmp_dir!(),
        "shuttle-felt-stores-controller-#{System.unique_integer([:positive])}.json"
      )

    System.put_env("FELT_STORES_FILE", path)
    Application.put_env(:shuttle, :remotes, [])

    on_exit(fn ->
      File.rm(path)

      case original do
        nil -> System.delete_env("FELT_STORES_FILE")
        value -> System.put_env("FELT_STORES_FILE", value)
      end

      case original_remotes do
        nil -> Application.delete_env(:shuttle, :remotes)
        value -> Application.put_env(:shuttle, :remotes, value)
      end

      case original_env_stores do
        nil -> System.delete_env("FELT_STORES")
        value -> System.put_env("FELT_STORES", value)
      end
    end)

    :ok
  end


  test "shows the configured base stores as the local origin" do
    path = Path.expand(System.get_env("FELT_STORES_FILE"))
    File.mkdir_p!(Path.dirname(path))

    File.write!(
      path,
      Jason.encode!(%{"version" => 1, "felt_stores" => ["~/loom", "/tmp/project"]})
    )

    conn = get(api_conn(), "/api/v1/felt-stores")

    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)
    host = body["host"]
    assert is_binary(host)

    assert get_in(body, ["origins", host, "kind"]) == "local"

    assert get_in(body, ["origins", host, "felt_stores"]) == [
             Path.expand("~/loom"),
             "/tmp/project"
           ]
  end

  test "surfaces the curated picker-project list on the local origin" do
    prev_projects_file = System.get_env("FELT_PROJECTS_FILE")

    projects_path =
      Path.join(
        System.tmp_dir!(),
        "shuttle-projects-controller-#{System.unique_integer([:positive])}.json"
      )

    System.put_env("FELT_PROJECTS_FILE", projects_path)
    File.mkdir_p!(Path.dirname(projects_path))

    File.write!(
      projects_path,
      Jason.encode!(%{"version" => 1, "projects" => ["~/loom", "/tmp/talks"]})
    )

    on_exit(fn ->
      File.rm(projects_path)

      case prev_projects_file do
        nil -> System.delete_env("FELT_PROJECTS_FILE")
        value -> System.put_env("FELT_PROJECTS_FILE", value)
      end
    end)

    conn = get(api_conn(), "/api/v1/felt-stores")
    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)
    host = body["host"]

    # Picker-project list is its own field, distinct from the poll-store list.
    assert get_in(body, ["origins", host, "projects"]) == [Path.expand("~/loom"), "/tmp/talks"]
  end

  test "persists normalized felt stores" do
    conn =
      post(
        api_conn(),
        "/api/v1/felt-stores",
        Jason.encode!(%{"felt_stores" => ["~/loom", "/tmp/project", "~/loom", "  "]})
      )

    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)
    assert body["ok"] == true
    assert body["felt_stores"] == [Path.expand("~/loom"), "/tmp/project"]

    {:ok, persisted} = File.read(Path.expand(System.get_env("FELT_STORES_FILE")))
    decoded = Jason.decode!(persisted)
    assert decoded["felt_stores"] == [Path.expand("~/loom"), "/tmp/project"]
    assert decoded["version"] == 1
  end

  test "empty list clears the persisted file" do
    path = Path.expand(System.get_env("FELT_STORES_FILE"))
    File.mkdir_p!(Path.dirname(path))
    File.write!(path, Jason.encode!(%{"version" => 1, "felt_stores" => ["/tmp/stale"]}))

    conn = post(api_conn(), "/api/v1/felt-stores", Jason.encode!(%{"felt_stores" => []}))

    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)
    assert body["felt_stores"] == []
    refute File.exists?(path)
  end

  test "rejects malformed payloads" do
    conn = post(api_conn(), "/api/v1/felt-stores", Jason.encode!(%{"felt_stores" => "~/loom"}))

    assert conn.status == 400
    assert Jason.decode!(conn.resp_body)["error"] =~ "felt_stores"
  end

  # A remote origin is served from `RemoteFiberRegistry`'s cached owner feed —
  # each host carries its own store registry as that feed's `stores` block — so
  # a loaded remote answering slowly can never blink out of the picker. Nothing
  # on this path may touch the network: the write-plane transport is stubbed
  # with a client that blows up if it is called at all.
  defmodule FeedClient do
    @behaviour Shuttle.RemoteRegistry.Client

    @impl true
    def get(_url, _timeout) do
      {:ok,
       Jason.encode!(%{
         "host" => "candide",
         "fibers" => [],
         "stores" => %{
           "kind" => "local",
           "host" => "candide",
           "felt_stores" => ["/remote/loom"],
           "expanded_felt_stores" => ["/remote/loom/expanded"],
           "projects" => ["/remote/talks"],
           "native_folder_picker" => false
         }
       })}
    end
  end

  defmodule ForbiddenClient do
    @behaviour Shuttle.RemoteRegistry.Client

    @impl true
    def get(url, _timeout), do: raise("felt-stores fetched #{url} live")
  end

  defp with_candide(fun) do
    previous = Application.get_env(:shuttle, :write_forward_client)
    Application.put_env(:shuttle, :write_forward_client, ForbiddenClient)

    Application.put_env(:shuttle, :remotes, [
      %{name: "candide", url: "http://candide.example:4000"}
    ])

    try do
      fun.()
    after
      case previous do
        nil -> Application.delete_env(:shuttle, :write_forward_client)
        value -> Application.put_env(:shuttle, :write_forward_client, value)
      end
    end
  end

  defp start_feed_registry(client) do
    dir = Path.join(System.tmp_dir!(), "fsc-store-#{System.unique_integer([:positive])}")
    on_exit(fn -> File.rm_rf(dir) end)

    start_supervised!(
      {Shuttle.RemoteFiberRegistry,
       name: Shuttle.RemoteFiberRegistry,
       remotes: [%Shuttle.Remote{name: "candide", url: "http://candide.example:4000"}],
       client: client,
       auto_poll: false,
       store_dir: dir}
    )
  end

  test "serves a remote origin from the cached feed, without a live fetch" do
    with_candide(fn ->
      start_feed_registry(FeedClient)
      Shuttle.RemoteFiberRegistry.refresh_now()

      conn = get(api_conn(), "/api/v1/felt-stores")

      assert conn.status == 200
      body = Jason.decode!(conn.resp_body)

      assert get_in(body, ["origins", "candide", "kind"]) == "remote"
      assert get_in(body, ["origins", "candide", "stale"]) == false
      assert get_in(body, ["origins", "candide", "felt_stores"]) == ["/remote/loom"]
      assert get_in(body, ["origins", "candide", "projects"]) == ["/remote/talks"]
      assert get_in(body, ["origins", "candide", "native_folder_picker"]) == false
      # The expanded poll list is the owner's business, not the picker's.
      refute Map.has_key?(get_in(body, ["origins", "candide"]), "expanded_felt_stores")
    end)
  end

  test "an unpolled remote degrades to a stale origin, not a 500" do
    with_candide(fn ->
      start_feed_registry(FeedClient)

      conn = get(api_conn(), "/api/v1/felt-stores")

      assert conn.status == 200
      body = Jason.decode!(conn.resp_body)

      assert get_in(body, ["origins", "candide", "kind"]) == "remote"
      assert get_in(body, ["origins", "candide", "stale"]) == true
      assert get_in(body, ["origins", "candide", "felt_stores"]) == []
    end)
  end
end
