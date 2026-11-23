defmodule Shuttle.UnreadableFiberTest do
  use ExUnit.Case, async: true

  import ExUnit.CaptureLog
  import Phoenix.ConnTest
  import Shuttle.Test.ApiConn

  alias Shuttle.{Poller, Remote, RemoteFiberRegistry}
  alias Shuttle.Poller.Discovery
  alias ShuttleWeb.DispatchReply

  @endpoint ShuttleWeb.Endpoint

  defmodule UnreadableRemoteClient do
    @behaviour Shuttle.RemoteRegistry.Client
    use Agent

    def start_link(_ \\ []), do: Agent.start_link(fn -> %{} end, name: __MODULE__)
    def set(url, response), do: Agent.update(__MODULE__, &Map.put(&1, url, response))

    @impl true
    def get(url, _timeout_ms), do: Agent.get(__MODULE__, &Map.get(&1, url, {:error, :not_set}))
  end

  defmodule StubRunner do
    @behaviour Shuttle.Runner
    def cmd("ps", _args, _opts), do: {"", 0}
    def cmd(command, args, opts), do: Shuttle.Runner.Default.cmd(command, args, opts)
  end

  describe "Discovery.carry_unreadable/2" do
    test "joins an unreadable row onto its last-known row and keeps a bare row if unseen" do
      known = %{
        "id" => "cmbx",
        "uid" => "01JZZZZZZZZZZZZZZZZZZZZZZ1",
        "name" => "CMBX Chair",
        "status" => "active",
        "path" => "/store/.felt/cmbx/cmbx.md",
        "shuttle" => %{"host" => "host-a", "channel" => "cmbx"}
      }

      listed = [
        %{
          "id" => "cmbx",
          "path" => "/store/.felt/cmbx/cmbx.md",
          "unreadable" => "yaml: line 4: found unexpected end of stream"
        },
        %{
          "id" => "never-seen",
          "path" => "/store/.felt/never-seen/never-seen.md",
          "unreadable" => "yaml: line 2: did not find expected key"
        }
      ]

      assert [carried, bare] = Discovery.carry_unreadable(listed, [known])
      assert carried["uid"] == "01JZZZZZZZZZZZZZZZZZZZZZZ1"
      assert carried["shuttle"]["channel"] == "cmbx"
      assert carried["shuttle"]["host"] == "host-a"
      assert carried["unreadable"] == "yaml: line 4: found unexpected end of stream"
      assert Discovery.unreadable?(carried)

      assert bare == Enum.at(listed, 1)
      assert Discovery.unreadable?(bare)
    end
  end

  describe "DispatchReply.render/2 for unreadable fibers" do
    test "renders 422 with detail unreadable and the parse error" do
      {status, body} =
        DispatchReply.render(
          "cmbx",
          {:error, {:not_eligible, {:unreadable, "/store/.felt/cmbx/cmbx.md", "yaml: bad quote"}}}
        )

      assert status == 422
      assert body.detail == "unreadable"
      assert body.message =~ "/store/.felt/cmbx/cmbx.md"
      assert body.message =~ "yaml: bad quote"
    end
  end

  describe "Poller, owner feed, composite and inbox with an unreadable fiber" do
    setup do
      root =
        Path.join(
          System.tmp_dir!(),
          "shuttle-unreadable-#{System.unique_integer([:positive])}"
        )

      store = Path.join(root, "store")
      project = Path.join(root, "project")
      File.mkdir_p!(Path.join(store, ".felt"))
      File.mkdir_p!(project)

      host = "unreadable-host-#{System.unique_integer([:positive])}"
      Shuttle.Test.Env.put_env("SHUTTLE_STORES", store)
      Shuttle.Test.Env.put_env("SHUTTLE_HOST", host)
      Shuttle.Test.Env.start_scoped!({Shuttle.FiberIndex, name: nil})

      on_exit(fn -> File.rm_rf(root) end)
      {:ok, store: store, project: project, host: host, root: root}
    end

    test "keeps the last-known row marked, refuses dispatch, logs once, publishes unreadable, and names the error in inbox",
         %{store: store, project: project, host: host} do
      uid = "01JZZZZZZZZZZZZZZZZZZZZZ99"
      fiber_path = Path.join([store, ".felt", "chair", "chair.md"])
      File.mkdir_p!(Path.dirname(fiber_path))

      File.write!(fiber_path, """
      ---
      id: #{uid}
      name: Chair
      status: active
      created-at: 2026-01-01T00:00:00Z
      updated-at: 2026-01-01T00:00:00Z
      shuttle:
        host: #{host}
        kind: oneshot
        channel: chair-room
        project_dir: #{project}
      ---

      Body.
      """)

      {:ok, poller} =
        Shuttle.Test.PollerHelpers.start_poller!(
          own_host_id: host,
          runner: StubRunner,
          felt_stores: [store],
          poll_interval_ms: 60_000,
          boot_quarantine: true,
          max_concurrent_workers: 0
        )

      Shuttle.Test.PollerHelpers.await_boot_cycle!(poller)

      assert {:ok, %{fibers: [entry], unreadable: []}} =
               Poller.cached_fiber_documents(poller, felt_stores: [store])

      assert entry.fiber["uid"] == uid
      assert get_in(entry.fiber, ["shuttle", "channel"]) == "chair-room"
      refute Map.has_key?(entry.fiber, "unreadable")

      # Break the YAML frontmatter on disk.
      File.write!(fiber_path, """
      ---
      id: #{uid}
      name: 'Chair's broken'
      status: active
      ---

      Body.
      """)

      log1 =
        capture_log(fn ->
          poll!(poller)
        end)

      assert log1 =~ "Unreadable fiber"
      assert log1 =~ "chair.md"
      assert log1 =~ "armed on #{host}"

      # A second poll with the same error does not log again.
      log2 =
        capture_log(fn ->
          poll!(poller)
        end)

      refute log2 =~ "Unreadable fiber"

      # The owner feed keeps the last-known row (marked) and publishes `unreadable`.
      assert {:ok, %{fibers: [marked], unreadable: [unreadable_entry]}} =
               Poller.cached_fiber_documents(poller, felt_stores: [store])

      assert marked.fiber["uid"] == uid
      assert get_in(marked.fiber, ["shuttle", "channel"]) == "chair-room"
      assert is_binary(marked.fiber["unreadable"])
      assert unreadable_entry.id == "chair"
      assert unreadable_entry.uid == uid
      assert unreadable_entry.path =~ "chair.md"
      assert is_binary(unreadable_entry.error)

      # Force and inbox dispatch both refuse an unreadable fiber by name.
      assert {:error, {:not_eligible, {:unreadable, path, err}}} =
               Poller.dispatch_fiber(poller, uid, force: true)

      assert {:error, {:not_eligible, {:unreadable, ^path, ^err}}} =
               Poller.dispatch_fiber(poller, uid, inbox: true)

      assert path =~ "chair.md"
      assert is_binary(err)

      # InboxController names the parse error instead of "no owned fiber".
      conn =
        Phoenix.ConnTest.build_conn()
        |> Plug.Conn.put_req_header("content-type", "application/json")

      inbox_resp = ShuttleWeb.InboxController.create(conn, %{"fiber_id" => uid, "action" => "list"})
      assert inbox_resp.status == 422
      assert Jason.decode!(inbox_resp.resp_body)["error"] =~ "is unreadable"

      # Owner feed HTTP endpoint carries `unreadable` and invalidates its ETag when cleared.
      feed_conn1 = get(api_conn(), "/api/v1/fibers?shuttle=true")
      assert feed_conn1.status == 200
      etag1 = Plug.Conn.get_resp_header(feed_conn1, "etag") |> List.first()
      assert [%{"id" => "chair", "path" => _, "error" => _}] =
               Jason.decode!(feed_conn1.resp_body)["unreadable"]

      # Composite endpoint carries `origins[host].unreadable`.
      comp_conn = get(api_conn(), "/api/v1/fibers/composite")
      assert comp_conn.status == 200
      comp_body = Jason.decode!(comp_conn.resp_body)
      assert [%{"id" => "chair"}] = comp_body["origins"][host]["unreadable"]

      # Fix the YAML frontmatter on disk; unreadable clears and ETag changes.
      File.write!(fiber_path, """
      ---
      id: #{uid}
      name: Chair
      status: active
      created-at: 2026-01-01T00:00:00Z
      updated-at: 2026-01-01T00:00:00Z
      shuttle:
        host: #{host}
        kind: oneshot
        channel: chair-room
        project_dir: #{project}
      ---

      Body.
      """)

      poll!(poller)

      feed_conn2 =
        api_conn()
        |> Plug.Conn.put_req_header("if-none-match", etag1)
        |> get("/api/v1/fibers?shuttle=true")

      assert feed_conn2.status == 200
      assert Jason.decode!(feed_conn2.resp_body)["unreadable"] == []

      assert {:ok, %{fibers: [recovered], unreadable: []}} =
               Poller.cached_fiber_documents(poller, felt_stores: [store])

      refute Map.has_key?(recovered.fiber, "unreadable")
    end

    test "RemoteFiberRegistry and composite carry remote unreadable and default to [] when omitted",
         %{store: store, host: host, root: root} do
      {:ok, poller} =
        Shuttle.Test.PollerHelpers.start_poller!(
          own_host_id: host,
          runner: StubRunner,
          felt_stores: [store],
          poll_interval_ms: 60_000,
          boot_quarantine: true,
          max_concurrent_workers: 0
        )

      Shuttle.Test.PollerHelpers.await_boot_cycle!(poller)

      start_supervised!(UnreadableRemoteClient)

      new_remote = %Remote{name: "new-peer", url: "http://new-peer.local:4000"}
      old_remote = %Remote{name: "old-peer", url: "http://old-peer.local:4000"}

      UnreadableRemoteClient.set(
        Remote.fibers_url(new_remote),
        {:ok,
         Jason.encode!(%{
           "host" => "new-peer",
           "fibers" => [],
           "unreadable" => [
             %{"id" => "broken", "path" => "/remote/.felt/broken/broken.md", "error" => "yaml: bad"}
           ]
         })}
      )

      # Older owner omits "unreadable" completely.
      UnreadableRemoteClient.set(
        Remote.fibers_url(old_remote),
        {:ok, Jason.encode!(%{"host" => "old-peer", "fibers" => []})}
      )

      rfr_dir = Path.join(root, "rfr")

      rfr =
        Shuttle.Test.Env.start_scoped!(
          {RemoteFiberRegistry,
           name: nil,
           remotes: [new_remote, old_remote],
           client: UnreadableRemoteClient,
           store_dir: rfr_dir,
           auto_poll: false}
        )

      :ok = RemoteFiberRegistry.refresh_now(rfr)
      feeds = RemoteFiberRegistry.feeds(rfr)

      assert feeds["new-peer"].unreadable == [
               %{"id" => "broken", "path" => "/remote/.felt/broken/broken.md", "error" => "yaml: bad"}
             ]

      assert feeds["old-peer"].unreadable == []

      # Composite exposes both origins' unreadable lists.
      conn = get(api_conn(), "/api/v1/fibers/composite")
      assert conn.status == 200
      origins = Jason.decode!(conn.resp_body)["origins"]
      assert origins["new-peer"]["unreadable"] == [
               %{"id" => "broken", "path" => "/remote/.felt/broken/broken.md", "error" => "yaml: bad"}
             ]
      assert origins["old-peer"]["unreadable"] == []
    end
  end

  defp poll!(poller) do
    before = :sys.get_state(poller).poll_cycles
    send(poller, :run_poll_cycle)
    assert :ok = wait_for_poll_cycle(poller, before)
  end

  defp wait_for_poll_cycle(poller, before, attempts \\ 400) do
    state = :sys.get_state(poller)

    if state.poll_cycles > before and not state.poll_check_in_progress do
      :ok
    else
      if attempts <= 0 do
        {:error, :timeout}
      else
        Process.sleep(15)
        wait_for_poll_cycle(poller, before, attempts - 1)
      end
    end
  end
end
