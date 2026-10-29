defmodule ShuttleWeb.FiberIndexControllerTest do
  use ExUnit.Case, async: true
  import Shuttle.Test.ApiConn
  import Phoenix.ConnTest
  import Plug.Conn

  @endpoint ShuttleWeb.Endpoint
  @url "/api/v1/fibers?fields=index"

  setup do
    parent = self()
    clock = start_supervised!({Agent, fn -> 0 end})

    loader = fn ->
      send(parent, {:refresh, self()})

      receive do
        {:result, result} -> result
        :crash -> exit(:refresh_crashed)
      end
    end

    cache =
      Shuttle.Test.Env.start_scoped!(
        {Shuttle.FiberIndex,
         name: nil, ttl_ms: 30_000, clock: fn -> Agent.get(clock, & &1) end, loader: loader}
      )

    {:ok, clock: clock, cache: cache, loader: loader}
  end

  defp body(name),
    do: %{
      host: "test-host",
      felt_stores: [],
      generated_at: "stamp",
      fibers: [%{fiber: %{id: "one", name: name}}]
    }

  defp request, do: get(api_conn(), @url)

  defp sync_index, do: :sys.get_state(Shuttle.Env.server(Shuttle.FiberIndex))

  defp warm do
    request = Task.async(fn -> request() end)
    assert_receive {:refresh, worker}
    send(worker, {:result, {:ok, body("First")}})
    assert %{status: 200} = conn = Task.await(request)
    sync_index()
    conn
  end

  # The worker sends its result before exiting; its DOWN lets the test issue
  # another request without a timing sleep.
  defp finish(worker, result) do
    send(worker, {:result, result})
    ref = Process.monitor(worker)
    assert_receive {:DOWN, ^ref, :process, ^worker, _}
    sync_index()
    :ok
  end

  test "expired index returns immediately and coalesces background refreshes", %{clock: clock} do
    first = warm()
    Agent.update(clock, fn _ -> 29_999 end)
    assert request().resp_body == first.resp_body
    refute_receive {:refresh, _}

    Agent.update(clock, fn _ -> 30_000 end)
    assert request().resp_body == first.resp_body
    assert_receive {:refresh, worker}

    # The refresh is blocked; both plain and conditional requests still finish.
    for _ <- 1..10, do: assert(request().resp_body == first.resp_body)
    [etag] = get_resp_header(first, "etag")
    conditional = api_conn() |> put_req_header("if-none-match", etag) |> get(@url)
    assert conditional.status == 304
    assert conditional.resp_body == ""
    refute_receive {:refresh, _}

    finish(worker, {:ok, body("Second")})
    updated = request()
    assert updated.status == 200
    assert [%{"fiber" => %{"name" => "Second"}}] = Jason.decode!(updated.resp_body)["fibers"]
    refute get_resp_header(updated, "etag") == [etag]
  end

  test "a refresh over unchanged stores keeps the etag", %{clock: clock} do
    first = warm()
    [etag] = get_resp_header(first, "etag")
    Agent.update(clock, fn _ -> 30_000 end)
    assert request().status == 200
    assert_receive {:refresh, worker}
    finish(worker, {:ok, %{body("First") | generated_at: "later stamp"}})

    refreshed = request()
    assert Jason.decode!(refreshed.resp_body)["generated_at"] == "later stamp"
    assert get_resp_header(refreshed, "etag") == [etag]
    conditional = api_conn() |> put_req_header("if-none-match", etag) |> get(@url)
    assert conditional.status == 304
  end

  test "cold concurrent callers share a listing" do
    tasks = for _ <- 1..8, do: Task.async(fn -> request() end)
    assert_receive {:refresh, worker}
    refute_receive {:refresh, _}
    finish(worker, {:ok, body("Shared")})
    replies = Enum.map(tasks, &Task.await/1)
    assert Enum.all?(replies, &(&1.status == 200))
    assert replies |> Enum.map(& &1.resp_body) |> Enum.uniq() |> length() == 1
  end

  test "failed background refresh retains the warm index and backs off", %{clock: clock} do
    first = warm()
    Agent.update(clock, fn _ -> 30_000 end)
    assert request().resp_body == first.resp_body
    assert_receive {:refresh, worker}
    finish(worker, {:error, [%{error: "unreadable"}]})
    assert request().resp_body == first.resp_body
    refute_receive {:refresh, _}

    Agent.update(clock, fn _ -> 60_000 end)
    assert request().resp_body == first.resp_body
    assert_receive {:refresh, worker}
    finish(worker, {:ok, body("Recovered")})
    assert request().resp_body != first.resp_body
  end

  test "cold failure returns 503 and retries after TTL", %{clock: clock} do
    task = Task.async(fn -> request() end)
    assert_receive {:refresh, worker}
    finish(worker, {:error, [%{error: "unreadable"}]})
    assert %{status: 503} = failed = Task.await(task)
    assert Jason.decode!(failed.resp_body)["error"] == "felt_list_failed"
    assert request().status == 503
    refute_receive {:refresh, _}

    Agent.update(clock, fn _ -> 30_000 end)
    # A cached failure may return immediately while the retry runs.
    assert request().status == 503
    assert_receive {:refresh, worker}
    finish(worker, {:ok, body("Recovered")})
    assert request().status == 200
  end

  @tag :tmp_dir
  test "refresh observes store registry changes and removal", %{clock: clock, tmp_dir: tmp_dir} do
    for name <- ["a", "b"] do
      File.mkdir_p!(Path.join([tmp_dir, name, ".felt"]))
      File.write!(Path.join([tmp_dir, name, ".felt", "#{name}.md"]), "---\nname: #{name}\n---\n")
    end

    parent = self()

    loader = fn ->
      result = Shuttle.FiberDocuments.index()
      send(parent, {:refresh, self()})
      receive do: (:publish -> result)
    end

    spec =
      Supervisor.child_spec(
        {Shuttle.FiberIndex, name: nil, loader: loader, clock: fn -> Agent.get(clock, & &1) end},
        id: :registry_index
      )

    Shuttle.Test.Env.start_scoped!(spec, Shuttle.FiberIndex)
    a = Path.join(tmp_dir, "a")
    b = Path.join(tmp_dir, "b")
    Shuttle.Test.Env.put_env("SHUTTLE_STORES", a)
    task = Task.async(fn -> request() end)
    assert_receive {:refresh, worker}
    send(worker, :publish)
    assert Jason.decode!(Task.await(task).resp_body)["felt_stores"] == [a]
    sync_index()

    Shuttle.Test.Env.put_env("SHUTTLE_STORES", b)
    Agent.update(clock, fn _ -> 30_000 end)
    assert Jason.decode!(request().resp_body)["felt_stores"] == [a]
    assert_receive {:refresh, worker}
    ref = Process.monitor(worker)
    send(worker, :publish)
    assert_receive {:DOWN, ^ref, :process, ^worker, _}
    sync_index()
    updated = Jason.decode!(request().resp_body)
    assert updated["felt_stores"] == [b]
    assert [%{"fiber" => %{"name" => "b"}}] = updated["fibers"]

    Shuttle.Test.Env.put_env("SHUTTLE_STORES", "")
    Shuttle.Test.Env.put_env("SHUTTLE_STORES_FILE", Path.join(tmp_dir, "absent.json"))
    Agent.update(clock, fn _ -> 60_000 end)
    assert Jason.decode!(request().resp_body)["felt_stores"] == [b]
    assert_receive {:refresh, worker}
    ref = Process.monitor(worker)
    send(worker, :publish)
    assert_receive {:DOWN, ^ref, :process, ^worker, _}
    sync_index()
    assert %{"felt_stores" => [], "fibers" => []} = Jason.decode!(request().resp_body)
  end

  test "refresh lifetime follows its cache through abrupt death", %{
    clock: clock,
    cache: cache,
    loader: loader
  } do
    warm()
    Agent.update(clock, fn _ -> 30_000 end)
    assert request().status == 200
    assert_receive {:refresh, worker}
    ref = Process.monitor(worker)
    Process.exit(cache, :kill)
    assert_receive {:DOWN, ^ref, :process, ^worker, :killed}

    replacement =
      Supervisor.child_spec({Shuttle.FiberIndex, name: nil, loader: loader}, id: :replacement)

    Shuttle.Test.Env.start_scoped!(replacement, Shuttle.FiberIndex)
    task = Task.async(fn -> request() end)
    assert_receive {:refresh, replacement_worker}
    refute Process.alive?(worker)
    finish(replacement_worker, {:ok, body("Replacement")})
    assert Task.await(task).status == 200
  end

  test "cold refresh crash releases callers and allows recovery", %{clock: clock} do
    tasks = for _ <- 1..5, do: Task.async(fn -> request() end)
    assert_receive {:refresh, worker}
    send(worker, :crash)
    assert Enum.all?(Enum.map(tasks, &Task.await/1), &(&1.status == 503))
    sync_index()
    assert request().status == 503
    refute_receive {:refresh, _}
    Agent.update(clock, fn _ -> 30_000 end)
    assert request().status == 503
    assert_receive {:refresh, worker}
    finish(worker, {:ok, body("Recovered")})
    assert request().status == 200
  end

  test "a crashed refresh keeps the warm index", %{clock: clock} do
    first = warm()
    Agent.update(clock, fn _ -> 30_000 end)
    assert request().resp_body == first.resp_body
    assert_receive {:refresh, worker}
    send(worker, :crash)
    ref = Process.monitor(worker)
    assert_receive {:DOWN, ^ref, :process, ^worker, _}
    sync_index()
    assert request().resp_body == first.resp_body
  end
end
