defmodule Shuttle.PollerPublicationTest do
  use ExUnit.Case, async: true

  import Phoenix.ConnTest
  import Shuttle.Test.ApiConn
  import Shuttle.Test.PollerHelpers

  alias Shuttle.{Delivery, Poller}
  alias Shuttle.Test.{Env, FiberUid}
  alias Shuttle.Test.FeltStoreRunner, as: Store

  @endpoint ShuttleWeb.Endpoint

  defmodule App do
    def read_thread(id), do: {:ok, %{"id" => id, "status" => %{"type" => "idle"}}}

    def status(_id),
      do: %{state: :idle, phase: Shuttle.Env.app(:publication_app_phase, "waiting")}
  end

  defmodule Runner do
    @behaviour Shuttle.Runner

    def cmd("shuttle", ["context-mailbox", "deliver" | _] = args, _opts) do
      send(Shuttle.Env.app(:publication_test_pid), {:context_delivery, args})
      {"delivered\n", 0}
    end

    def cmd("shuttle", ["-C", _store, "accept" | _] = args, opts) do
      send(Shuttle.Env.app(:publication_test_pid), {:lifecycle_write, self(), args})
      Store.cmd("shuttle", args, opts)
    end

    def cmd("shuttle", args, opts) do
      if Shuttle.Env.app(:publication_runtime_write_fails, false) and "mark-runtime" in args do
        send(Shuttle.Env.app(:publication_test_pid), {:runtime_write_failed, args})
        {"injected runtime marker failure", 1}
      else
        Store.cmd("shuttle", args, opts)
      end
    end

    def cmd(command, args, opts), do: Store.cmd(command, args, opts)
  end

  setup do
    Store.start!()
    Store.reset()
    root = Store.felt_root()
    data = Path.join(System.tmp_dir!(), "publication-#{System.unique_integer([:positive])}")
    File.mkdir_p!(data)
    Env.put_env("SHUTTLE_DATA_DIR", data)
    Env.delete_env("SHUTTLE_SESSIONS_FILE")
    Env.put_app_env(:felt_runner, Runner)
    Env.put_app_env(:publication_test_pid, self())
    Env.put_app_env(:app_workers_dir, Path.join(data, "app-workers"))

    on_exit(fn ->
      File.rm_rf(root)
      File.rm_rf(data)
    end)

    %{root: root}
  end

  test "populated named and PID readers, HTTP state and context delivery bypass a suspended Poller",
       %{root: root} do
    id = "tests/published-live"
    put_fiber(id)
    {:ok, poller} = boot(root, name: :publication_populated_poller)
    Env.put_server(Poller, poller)
    assert {:ok, session} = Poller.dispatch_fiber(poller, id, [])
    uid = FiberUid.for(id)
    worker = Poller.worker_status(poller, id)
    assert worker.session == session
    assert is_binary(worker.session_uuid)
    assert {:ok, address, epoch} = Poller.context_receiver(poller, id)
    assert is_binary(address) and is_integer(epoch)
    {:ok, response} = Poller.published_state_response(poller)

    suspended(poller, fn ->
      bounded(fn ->
        for server <- [poller, :publication_populated_poller], identity <- [id, uid] do
          assert Poller.worker_status(server, identity) == worker
          assert Poller.live_worker(server, identity).session == session
          assert Poller.session_uuid(server, identity) == worker.session_uuid
          assert Poller.context_receiver(server, identity) == {:ok, address, epoch}
        end

        assert [%{fiber_id: ^id, uid: ^uid}] = Poller.snapshot(poller).eligible
        assert Poller.orchestrator_state(poller, 0).running_detail != []
        assert Poller.fiber_stores(poller)[uid] == root

        assert {:ok, %{fibers: [%{fiber: %{"uid" => ^uid}}]}} =
                 Poller.cached_fiber_documents(poller)

        assert {:ok, {_entries, _live, _reachable}} = Poller.thread_inputs(poller)

        conn = get(api_conn(), "/api/v1/state")
        assert conn.status == 200
        assert conn.resp_body == response.body
        assert [%{"fiber_id" => ^id}] = Jason.decode!(conn.resp_body)["running_detail"]
        assert Plug.Conn.get_resp_header(conn, "etag") == [response.etag]

        assert {:ok, "delivered\n"} =
                 Delivery.flush_context(%{felt_store: root, fiber: Store.fiber(id)})
      end)

      assert_received {:context_delivery,
                       ["context-mailbox", "deliver", key, ^address, generation]}

      assert key == root <> ":" <> uid
      assert generation == Integer.to_string(epoch)
    end)
  end

  test "a failed dispatch marker cannot publish the previous conversation as the new worker",
       %{root: root} do
    id = "tests/published-failed-marker"
    put_fiber(id)
    Store.put_shuttle_fields(id, %{"session_uuid" => "predecessor-conversation"})
    {:ok, poller} = boot(root)
    Env.put_app_env(:publication_runtime_write_fails, true)

    assert {:ok, session} = Poller.dispatch_fiber(poller, id, resume_mode: "fresh")
    assert_received {:runtime_write_failed, _args}

    assert get_in(Store.fiber(id), ["shuttle", "runtime", "session_uuid"]) ==
             "predecessor-conversation"

    suspended(poller, fn ->
      bounded(fn ->
        assert %{session: ^session, session_uuid: nil} = Poller.live_worker(poller, id)
        assert Poller.session_uuid(poller, id) == nil
        assert %{session_uuid: nil} = Poller.worker_status(poller, id)
        assert {:ok, %{fibers: [%{runtime: runtime}]}} = Poller.cached_fiber_documents(poller)
        assert runtime.session_uuid == nil
        assert runtime.identity_pending
      end)
    end)
  end

  test "stopping a worker removes all published live identities before the action returns",
       %{root: root} do
    id = "tests/published-stop"
    put_fiber(id)
    {:ok, poller} = boot(root)
    assert {:ok, _session} = Poller.dispatch_fiber(poller, id, [])
    assert {:ok, _output} = Poller.lifecycle_transition(poller, :rest, id)

    suspended(poller, fn ->
      bounded(fn ->
        for identity <- [id, FiberUid.for(id)] do
          assert Poller.live_worker(poller, identity) == nil
          assert Poller.worker_status(poller, identity) == nil
          assert Poller.context_receiver(poller, identity) == {:error, :no_worker}
        end

        assert Poller.orchestrator_state(poller, 0).running_detail == []
        {:ok, %{fibers: [entry]}} = Poller.cached_fiber_documents(poller)
        assert entry.fiber["status"] == "open"
      end)
    end)
  end

  test "a canonical runtime key wins over another worker's fiber address", %{root: root} do
    id = "tests/publication-collision-anchor"
    put_fiber(id, "open")
    {:ok, poller} = boot(root)
    now = DateTime.utc_now()

    worker = fn key, fiber_id, epoch ->
      %{
        pid: self(),
        session: "session-#{key}",
        session_uuid: "native-#{key}",
        uid: key,
        fiber_id: fiber_id,
        agent_id: "claude-sonnet",
        felt_store: root,
        started_at: now,
        last_activity_at: now,
        context_address: "shuttle://test-host/claude/native-#{key}",
        context_epoch: epoch
      }
    end

    first = worker.("a", "b", 7)
    second = worker.("b", "tests/canonical-b", 11)

    # Establish the ambiguous address without asking the CLI to resolve it.
    # Refresh then commits the fixture through the real publication boundary.
    :sys.replace_state(poller, fn state -> %{state | running: %{"a" => first, "b" => second}} end)
    assert :ok = Poller.refresh_document(poller, id)

    suspended(poller, fn ->
      bounded(fn ->
        assert Poller.live_worker(poller, "a").session == "session-a"
        assert Poller.live_worker(poller, "b").session == "session-b"
        assert Poller.live_worker(poller, "tests/canonical-b").session == "session-b"

        assert Poller.context_receiver(poller, "a") ==
                 {:ok, "shuttle://test-host/claude/native-a", 7}

        assert Poller.context_receiver(poller, "b") ==
                 {:ok, "shuttle://test-host/claude/native-b", 11}
      end)
    end)
  end

  test "lifecycle writes wait for the Poller and publish the accepted document before replying",
       %{root: root} do
    id = "tests/published-accept"
    Store.set_fiber(id, make_fiber(id, %{"status" => "closed"}))

    Store.set_shuttle(
      id,
      "kind: standing\nschedule:\n  expr: '0 9 * * 1'\n  tz: Europe/Paris\n",
      "closed"
    )

    {:ok, poller} = boot(root)
    {:ok, before} = Poller.published_state_response(poller)
    path = Store.fiber(id)["path"]

    :sys.suspend(poller)
    transition = Task.async(fn -> Poller.lifecycle_transition(poller, :accept, id) end)

    try do
      await(fn ->
        {:messages, messages} = Process.info(poller, :messages)

        Enum.any?(
          messages,
          &match?({:"$gen_call", _, {:lifecycle_transition, :accept, ^id, []}}, &1)
        )
      end)

      refute_received {:lifecycle_write, _, _}
      assert File.read!(path) =~ "status: closed"
      assert {:ok, ^before} = Poller.published_state_response(poller) |> same_age(before)
      assert Task.yield(transition, 0) == nil
    after
      :sys.resume(poller)
    end

    assert {:ok, _output} = Task.await(transition, 10_000)
    assert_received {:lifecycle_write, ^poller, ["-C", ^root, "accept", ^id, "--local"]}
    assert File.read!(path) =~ "status: active"
    {:ok, after_accept} = Poller.published_state_response(poller)
    assert after_accept.etag != before.etag
    assert {:ok, %{fibers: [entry]}} = Poller.cached_fiber_documents(poller)
    assert entry.fiber["status"] == "active"
  end

  @tag :timing
  test "dirty worker observations publish while subsequent observations keep arriving", %{
    root: root
  } do
    id = "tests/published-continuous"
    {poller, watcher, thread} = app_worker(root, id)
    before = Poller.published_state_metrics(poller)
    producer = Task.async(fn -> observations(watcher, thread, now_ms() + 3_000) end)

    try do
      await(
        fn -> Poller.published_state_metrics(poller).generation > before.generation end,
        2_000
      )

      assert Task.yield(producer, 0) == nil,
             "publication waited for observations to stop instead of retaining the first deadline"

      {:ok, response} = Poller.published_state_response(poller)
      assert [%{"terminal_error" => error}] = Jason.decode!(response.body)["eligible"]
      assert error =~ "observation-"
    after
      Task.shutdown(producer, :brutal_kill)
    end
  end

  @tag :timing
  test "app phase observations publish and unchanged heartbeats do not encode", %{root: root} do
    id = "tests/published-app"
    {poller, watcher, thread} = app_worker(root, id)
    before = Poller.published_state_metrics(poller)
    send(watcher, :heartbeat)
    :sys.get_state(watcher)
    :sys.get_state(poller)

    through_deadline(now_ms() + 1_200, fn ->
      assert Poller.published_state_metrics(poller).publish_count == before.publish_count
    end)

    Env.put_app_env(:publication_app_phase, "working")
    send(watcher, :heartbeat)
    :sys.get_state(watcher)
    await(fn -> hd(Poller.snapshot(poller).eligible)[:phase] == "working" end)
    assert Poller.published_state_metrics(poller).generation > before.generation
    {:ok, response} = Poller.published_state_response(poller)
    assert [%{"phase" => "working"}] = Jason.decode!(response.body)["eligible"]

    assert :ok = Shuttle.AppWorkers.update(thread, %{"terminal_error" => "viewer unavailable"})
    send(watcher, :heartbeat)
    :sys.get_state(watcher)
    await(fn -> hd(Poller.snapshot(poller).eligible)[:terminal_error] == "viewer unavailable" end)
    {:ok, external_change} = Poller.published_state_response(poller)

    assert [%{"terminal_error" => "viewer unavailable"}] =
             Jason.decode!(external_change.body)["eligible"]

    after_change = Poller.published_state_metrics(poller)
    send(watcher, :heartbeat)
    :sys.get_state(watcher)
    :sys.get_state(poller)

    through_deadline(now_ms() + 1_200, fn ->
      assert Poller.published_state_metrics(poller).publish_count == after_change.publish_count
    end)
  end

  @tag :timing
  test "thread liveness expires a remote report while the Poller is suspended", %{root: root} do
    id = "tests/published-fleet-expiry"
    put_fiber(id)
    {:ok, poller} = boot(root)
    assert {:ok, _session} = Poller.dispatch_fiber(poller, id, [])
    local_uid = FiberUid.for(id)
    remote_uid = "remote-worker"
    observed_at = DateTime.utc_now()

    remote = %Shuttle.Remote{
      name: "peer",
      url: "http://peer.invalid:4000",
      poll_interval_ms: 1_000,
      stale_multiplier: 1
    }

    send(
      poller,
      {:fleet,
       %{
         remote.name => %{
           remote: remote,
           last_polled_at: observed_at,
           running: MapSet.new([remote_uid])
         }
       }}
    )

    :sys.get_state(poller)
    assert {:ok, {_entries, live, reachable}} = Poller.thread_inputs(poller)
    assert MapSet.member?(live, local_uid)
    assert MapSet.member?(live, remote_uid)
    assert MapSet.member?(reachable, "test-host")
    assert MapSet.member?(reachable, remote.name)
    generation = Poller.published_state_metrics(poller).generation

    suspended(poller, fn ->
      await(fn -> Shuttle.Remote.stale?(remote, observed_at, DateTime.utc_now()) end, 2_000)

      bounded(fn ->
        assert {:ok, {_entries, current_live, current_reachable}} = Poller.thread_inputs(poller)
        assert MapSet.member?(current_live, local_uid)
        refute MapSet.member?(current_live, remote_uid)
        assert MapSet.member?(current_reachable, "test-host")
        refute MapSet.member?(current_reachable, remote.name)
        assert Poller.published_state_metrics(poller).generation == generation
      end)
    end)
  end

  @tag :timing
  test "no-op and fleet-only changes do not encode or invalidate the state body", %{root: root} do
    id = "tests/published-quiet"
    put_fiber(id, "open")
    {:ok, poller} = boot(root)
    before = Poller.published_state_metrics(poller)
    {:ok, response} = Poller.published_state_response(poller)

    for n <- 1..15 do
      send(
        poller,
        {:fleet,
         %{
           "peer-#{n}" => %{
             remote: %Shuttle.Remote{name: "peer-#{n}", url: "http://peer.invalid:4000"},
             last_polled_at: DateTime.utc_now(),
             running: MapSet.new(["remote-worker-#{n}"])
           }
         }}
      )

      send(poller, {:app_worker_observed, "absent-worker", "absent-session"})
    end

    # The barrier proves the events were applied; the observation window also
    # covers a mistakenly scheduled production publication timer.
    :sys.get_state(poller)

    through_deadline(now_ms() + 1_200, fn ->
      assert Poller.published_state_metrics(poller).publish_count == before.publish_count
      assert Poller.published_state_metrics(poller).encode_us == before.encode_us
      assert {:not_modified, current} = Poller.published_state_response(poller, response.etag)
      assert current.body == response.body
    end)
  end

  defp put_fiber(id, status \\ "active") do
    Store.set_fiber(id, make_fiber(id, %{"status" => status}))
    Store.set_shuttle(id, oneshot_shuttle(), status)
  end

  defp app_worker(root, id) do
    thread = Path.basename(id) <> "-thread"
    Store.set_fiber(id, make_fiber(id, %{"status" => "open"}))
    Store.set_shuttle(id, "kind: oneshot\nagent: codex\nsurface: app\n", "open")
    Env.put_app_env(:codex_app_client, App)
    {:ok, poller} = boot(root)

    assert {:ok, %{session: "codex-app:" <> ^thread}} =
             Poller.claim_session(poller, id, nil, surface: "app", session_uuid: thread)

    watcher = Poller.worker_status(poller, id).pid
    send(watcher, :heartbeat)
    :sys.get_state(watcher)
    await(fn -> hd(Poller.snapshot(poller).eligible)[:phase] == "waiting" end)
    {poller, watcher, thread}
  end

  defp boot(root, opts \\ []) do
    {:ok, poller} =
      start_poller!(
        [
          runner: Runner,
          own_host_id: "test-host",
          felt_stores: [root],
          poll_interval_ms: 600_000,
          max_concurrent_workers: 0
        ] ++ opts
      )

    await_boot_cycle!(poller)
    await(fn -> Poller.snapshot(poller).document_cache["state"] != "cold" end)
    {:ok, poller}
  end

  defp suspended(poller, fun) do
    :sys.suspend(poller)

    try do
      fun.()
    after
      :sys.resume(poller)
    end
  end

  defp bounded(fun) do
    task = Task.async(fun)

    try do
      assert {:ok, _} = Task.yield(task, 750), "published read waited for the Poller's mailbox"
    after
      Task.shutdown(task, :brutal_kill)
    end
  end

  defp same_age({:ok, response}, before), do: {:ok, %{response | age_ms: before.age_ms}}

  defp observations(watcher, thread, deadline) do
    if now_ms() < deadline do
      :ok = Shuttle.AppWorkers.update(thread, %{"terminal_error" => "observation-#{now_ms()}"})
      send(watcher, :heartbeat)
      :sys.get_state(watcher)

      receive do
      after
        100 -> observations(watcher, thread, deadline)
      end
    end
  end

  defp through_deadline(deadline, check) do
    check.()

    if now_ms() < deadline do
      receive do
      after
        20 -> through_deadline(deadline, check)
      end
    end
  end

  defp await(condition, timeout \\ 5_000), do: await_until(condition, now_ms() + timeout)

  defp await_until(condition, deadline) do
    if condition.() do
      :ok
    else
      assert now_ms() < deadline, "condition did not become true before its deadline"

      receive do
      after
        10 -> await_until(condition, deadline)
      end
    end
  end

  defp now_ms, do: System.monotonic_time(:millisecond)
end
