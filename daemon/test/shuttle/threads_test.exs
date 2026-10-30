defmodule Shuttle.ThreadsTest do
  use ExUnit.Case, async: true
  import Shuttle.Test.ApiConn
  import Phoenix.ConnTest
  alias Shuttle.{CLI, FiberDocuments, Threads, Test.Env}
  @moduletag :tmp_dir
  @endpoint ShuttleWeb.Endpoint

  defmodule ScopedAPI do
    @behaviour Plug
    def init(owner), do: owner

    def call(conn, owner) do
      Shuttle.Env.adopt_callers([owner])
      ShuttleWeb.Endpoint.call(conn, ShuttleWeb.Endpoint.init([]))
    end
  end

  defmodule SocketRunner do
    @behaviour Shuttle.Runner
    def cmd("bash", ["-l" | args], opts),
      do: Shuttle.Runner.Default.cmd("bash", ["--noprofile", "--norc" | args], opts)

    def cmd(command, args, opts), do: Shuttle.Runner.Default.cmd(command, args, opts)
  end

  defmodule FailingMailboxRunner do
    def cmd("shuttle", ["context-mailbox", "put" | _], _opts), do: {"mailbox unavailable", 1}
    def cmd(command, args, opts), do: Shuttle.Runner.Default.cmd(command, args, opts)
  end

  defmodule NoFiberReadsRunner do
    def cmd(command, args, _opts) do
      send(Process.get(:fiber_read_test_pid), {:fiber_read, command, args})
      {"unexpected fiber read", 1}
    end
  end

  defp claim_test_daemon_owner!(home) do
    {hostname, 0} = System.cmd("hostname", [])
    hostname = String.trim(hostname)

    listen_network = "tcp"
    listen_address = "127.0.0.1:4000"

    key =
      :crypto.hash(:sha256, hostname <> <<0>> <> listen_network <> <<0>> <> listen_address)
      |> Base.encode16(case: :lower)

    path = Path.join([home, ".shuttle", "daemon-owners", key <> ".json"])
    File.mkdir_p!(Path.dirname(path))
    pid = System.pid()

    File.write!(path, Jason.encode!(%{pid: String.to_integer(pid), birth: process_birth!(pid)}))
  end

  defp process_birth!(pid) do
    case File.read("/proc/#{pid}/stat") do
      {:ok, stat} ->
        fields = stat |> String.split(")") |> List.last() |> String.split()
        {:ok, boot} = File.read("/proc/sys/kernel/random/boot_id")
        String.trim(boot) <> ":ticks:" <> Enum.at(fields, 19)

      {:error, _} ->
        {birth, 0} =
          System.cmd("ps", ["-p", pid, "-o", "lstart="], env: [{"LC_ALL", "C"}, {"TZ", "UTC"}])

        String.trim(birth)
    end
  end

  setup %{tmp_dir: dir} = context do
    home = Path.join(dir, "home")
    data = Path.join(dir, "data")
    File.mkdir_p!(home)
    File.mkdir_p!(data)
    Env.delete_env("TMUX")
    Env.delete_env("SHUTTLE_FIBER_PATH")
    Env.put_env("HOME", home)
    Env.put_env("SHUTTLE_DATA_DIR", data)
    Env.delete_env("SHUTTLE_LISTEN")
    Env.delete_env("SHUTTLE_PORT")
    claim_test_daemon_owner!(home)
    Env.put_env("SHUTTLE_HOST", "test-host")
    Env.put_env("SHUTTLE_STORES", dir)
    unless context[:first_boot], do: Shuttle.ThreadOutbox.boot_baseline()
    Env.put_app_env(:felt_runner, Shuttle.Runner.Default)
    assert {:ok, _} = CLI.run_felt(["-C", dir, "init"])
    assert {:ok, _} = CLI.run_felt(["-C", dir, "add", "hub", "Hub"])

    assert {:ok, _} =
             CLI.run_in_store(dir, [
               "install",
               "hub",
               "--disabled",
               "--host",
               "test-host",
               "--project-dir",
               dir
             ])

    assert {:ok, _} =
             CLI.run_in_store(dir, [
               "thread",
               "hub",
               "Investigate",
               "--slug",
               "child",
               "--disabled"
             ])

    {:ok, store: dir, data: data}
  end

  test "real lifecycle writes queue close, ask, handoff and rest context once without launching the parent",
       %{store: store, data: data} do
    assert {:ok, _} =
             CLI.run_in_store(store, [
               "set-outcome",
               "hub/child",
               "--outcome",
               "The covariance agrees",
               "--local"
             ])

    for {verb, args, expected} <- [
          {"ask", ["Which estimator?"], "asked: Which estimator?"},
          {"close", [], "closed: The covariance agrees"},
          {"handoff", [], "handed off: The covariance agrees"},
          {"rest", [], "rested: The covariance agrees"}
        ] do
      if verb in ["handoff", "rest"],
        do: assert({:ok, _} = CLI.run_in_store(store, ["reopen", "hub/child", "--local"]))

      assert {:ok, _} =
               CLI.run_in_store(
                 store,
                 [verb, "hub/child" | args] ++
                   if(verb in ["ask", "handoff"], do: [], else: ["--local"])
               )

      assert {:ok, %{fibers: entries}} = FiberDocuments.list(felt_stores: [store])
      Threads.deliver_results(entries, "test-host")
      first = pending(data)

      assert Enum.any?(
               first,
               &String.contains?(&1["request"]["text"], "thread hub/child #{expected}")
             )

      Threads.deliver_results(entries, "test-host")
      assert pending(data) == first
    end

    assert {:ok, output} = CLI.run_in_store(store, ["show", "hub", "--json"])
    assert Jason.decode!(output)["status"] == "open"
    assert length(pending(data)) == 4
  end

  test "lifecycle writes update the thread roster before the next poll", %{store: store} do
    {:ok, poller} =
      Shuttle.Test.PollerHelpers.start_poller!(
        runner: Shuttle.Runner.Default,
        poll_interval_ms: 60_000,
        felt_stores: [store]
      )

    await(fn -> :sys.get_state(poller).document_cache_ready end)

    for {verb, expected_column} <- [
          {:close, "awaiting_review"},
          {:reopen, "in_flight"},
          {:rest, "resting"},
          {:resume, "in_flight"}
        ] do
      assert {:ok, _} = Shuttle.Poller.lifecycle_transition(poller, verb, "hub/child", [])
      assert {:ok, {entries, live, reachable}} = Shuttle.Poller.thread_inputs(poller)

      assert [%{"id" => "hub/child", "column" => ^expected_column}] =
               Threads.tree("hub", store, entries, live, reachable)
    end
  end

  test "lifecycle API writes reach the thread endpoint before the next poll", %{store: store} do
    {:ok, poller} =
      Shuttle.Test.PollerHelpers.start_poller!(
        runner: Shuttle.Runner.Default,
        poll_interval_ms: 60_000,
        felt_stores: [store]
      )

    await(fn -> :sys.get_state(poller).document_cache_ready end)

    for {write, expected_column} <- [
          {%{"action" => "close", "fiber" => "hub/child"}, "awaiting_review"},
          {%{"action" => "reopen", "fiber" => "hub/child", "as_draft" => true}, "drafts"},
          {%{"action" => "resume", "fiber" => "hub/child"}, "in_flight"},
          {%{"action" => "rest", "fiber" => "hub/child"}, "resting"}
        ] do
      assert 200 = post(api_conn(), "/api/v1/lifecycle", Jason.encode!(write)).status
      roster = get(api_conn(), "/api/v1/threads/hub") |> json_response(200)

      assert [%{"id" => "hub/child", "column" => ^expected_column}] = roster["threads"]
    end
  end

  test "free-text blockers with slashes skip fiber reads while ids still resolve", %{store: store} do
    assert {:ok, %{fibers: [%{fiber: fiber}]}} =
             FiberDocuments.get("hub/child", felt_stores: [store])

    uid = fiber["uid"]
    assert Shuttle.ULID.valid?(uid)
    Process.put(:fiber_read_test_pid, self())
    Env.put_app_env(:felt_runner, NoFiberReadsRunner)

    assert Threads.blocker(
             "end of week (~30 Oct), after Cail's Wed/Thu analysis calls",
             store,
             %{}
           ) ==
             nil

    assert Threads.blocker("first week / maybe later", store, %{}) == nil
    assert Threads.blocker(uid, store, %{uid => fiber}) == fiber
    refute_receive {:fiber_read, _, _}

    Env.put_app_env(:felt_runner, Shuttle.Runner.Default)
    assert %{"slug" => "hub/child"} = Threads.blocker("hub/child", store, %{})
  end

  test "the orchestrator's own rest and close reach no one; another session's are delivered",
       %{store: store, data: data} do
    assert {:ok, _} =
             CLI.run_in_store(store, ["mark-runtime", "hub", "--session", "chair-session"])

    for {verb, actor, delivered?} <- [
          {"rest", "chair-session", false},
          {"rest", "thread-session", true},
          {"close", "chair-session", false},
          {"close", "thread-session", true}
        ] do
      assert {:ok, _} = CLI.run_in_store(store, ["reopen", "hub/child", "--local"])

      assert {:ok, _} =
               CLI.run_in_store(store, [verb, "hub/child", "--local", "--actor", actor])

      before = pending(data)
      assert {:ok, %{fibers: entries}} = FiberDocuments.list(felt_stores: [store])
      Threads.deliver_results(entries, "test-host")
      added = pending(data) -- before
      past = if verb == "rest", do: "rested", else: "closed"

      assert Enum.any?(added, &(&1["request"]["text"] =~ "thread hub/child #{past}")) ==
               delivered?,
             "#{verb} by #{actor}: #{inspect(Enum.map(added, & &1["request"]["text"]))}"
    end
  end

  describe "a thread resting until a fiber" do
    setup %{store: store} do
      assert {:ok, _} = CLI.run_felt(["-C", store, "add", "blocker", "The mocks land"])

      assert {:ok, _} =
               CLI.run_in_store(store, ["rest", "hub/child", "--until", "blocker", "--local"])

      :ok
    end

    defp unblocked(data),
      do: data |> pending() |> Enum.filter(&(&1["request"]["text"] =~ "unblocked"))

    defp deliver(store) do
      assert {:ok, %{fibers: entries}} = FiberDocuments.list(felt_stores: [store])
      Threads.deliver_results(entries, "test-host")
    end

    for {how, edit} <- [
          {"closes", ["-s", "closed"]},
          {"is tempered", ["-s", "closed", "--set", "tempered=true"]},
          {"is discarded", ["-s", "closed", "--set", "tempered=false"]}
        ] do
      @edit edit
      test "its orchestrator hears once, as context, when the blocker #{how}", %{
        store: store,
        data: data
      } do
        deliver(store)
        assert unblocked(data) == []

        assert {:ok, _} = CLI.run_felt(["-C", store, "edit", "blocker" | @edit])
        deliver(store)
        deliver(store)

        assert [%{"request" => request}] = unblocked(data)
        assert request["text"] == "thread hub/child unblocked: The mocks land closed"
        refute request["wake"]
        assert {:ok, output} = CLI.run_in_store(store, ["show", "hub", "--json"])
        assert Jason.decode!(output)["status"] == "open"
      end
    end

    test "a wait on free text, or one already cleared, publishes nothing", %{
      store: store,
      data: data
    } do
      assert {:ok, _} = CLI.run_felt(["-C", store, "add", "other", "Other"])

      assert {:ok, _} =
               CLI.run_in_store(store, [
                 "thread",
                 "hub",
                 "Waits on words",
                 "--slug",
                 "worded",
                 "--disabled"
               ])

      assert {:ok, _} =
               CLI.run_in_store(store, [
                 "rest",
                 "hub/worded",
                 "--until",
                 "the other mocks",
                 "--local"
               ])

      assert {:ok, _} = CLI.run_in_store(store, ["resume", "hub/child", "--local"])
      assert {:ok, _} = CLI.run_felt(["-C", store, "edit", "blocker", "-s", "closed"])
      assert {:ok, _} = CLI.run_felt(["-C", store, "edit", "other", "-s", "closed"])
      deliver(store)
      assert unblocked(data) == []
    end

    test "the roster and the tree name what a thread waits for", %{store: store} do
      assert {:ok, %{fibers: entries}} = FiberDocuments.list(felt_stores: [store])
      # A blocker outside the poller's cache is read from the store.
      entries = Enum.reject(entries, &(&1.fiber["name"] == "The mocks land"))

      assert [%{"id" => "hub/child", "until" => "The mocks land", "blocked_on" => uid}] =
               Threads.tree("hub", store, entries, MapSet.new())

      assert Shuttle.ULID.valid?(uid)

      assert Threads.roster("hub", store, entries, MapSet.new()) =~
               "## Threads — 1 resting — `shuttle threads hub`"
    end

    test "a note its orchestrator could not take survives a publisher restart", %{
      store: store
    } do
      alias Shuttle.Test.StubPostClient
      StubPostClient.start!()
      Env.put_app_env(:write_forward_client, StubPostClient)
      Env.put_app_env(:remotes, [%{name: "parent-host", port: 43210}])
      path = Path.join(store, ".felt/hub/hub.md")
      File.write!(path, String.replace(File.read!(path), "host: test-host", "host: parent-host"))

      StubPostClient.set_response({:error, :unavailable})
      assert {:ok, _} = CLI.run_felt(["-C", store, "edit", "blocker", "-s", "closed"])
      deliver(store)

      assert [{id, %{"text" => "thread hub/child unblocked: The mocks land closed"} = record}] =
               Enum.filter(Shuttle.ThreadOutbox.pending("test-host"), fn {_id, r} ->
                 r["text"] =~ "unblocked"
               end)

      refute record["wake"]
      initial = Shuttle.ThreadOutbox.pending("test-host")
      assert [{rest_id, rest}] = Enum.reject(initial, fn {pending_id, _} -> pending_id == id end)
      assert rest["text"] == "thread hub/child rested: "

      # Outbox files are ordered by the hash of their ID. Keep another valid
      # context publication after both lifecycle results, regardless of their UIDs.
      hash = fn value -> :crypto.hash(:sha256, value) |> Base.encode16(case: :lower) end
      last_hash = max(hash.(id), hash.(rest_id))

      later_id =
        Stream.iterate(1, &(&1 + 1))
        |> Enum.find_value(fn n ->
          candidate = "other-context-#{n}"
          if hash.(candidate) > last_hash, do: candidate
        end)

      assert later_id
      later = %{record | "text" => "another pending context note"}
      Shuttle.ThreadOutbox.capture([{later_id, later}])
      pending_ids = MapSet.new([id, later_id])
      before_retry = length(StubPostClient.posts())

      # The wait is cleared and the blocker reopened before the retry.
      assert {:ok, _} = CLI.run_in_store(store, ["resume", "hub/child", "--local"])
      assert {:ok, _} = CLI.run_felt(["-C", store, "edit", "blocker", "-s", "open"])
      StubPostClient.set_response({:ok, 202, ~s({"queued":true,"delivery":"context"})})

      Task.async(fn ->
        Shuttle.ThreadOutbox.boot_baseline()
        Threads.retry_results("test-host")
      end)
      |> Task.await(30_000)

      assert Shuttle.ThreadOutbox.pending("test-host") == []
      assert {:ok, %{fibers: entries}} = FiberDocuments.list(felt_stores: [store])

      retried =
        StubPostClient.posts()
        |> Enum.drop(before_retry)
        |> Enum.map(&Jason.decode!(&1.body))

      assert MapSet.new(retried, & &1["message_id"]) == pending_ids
      assert length(retried) == MapSet.size(pending_ids)
      assert List.last(retried)["message_id"] == later_id
      assert [sent] = Enum.filter(retried, &(&1["message_id"] == id))
      assert sent["message_id"] == id
      assert sent["text"] == "thread hub/child unblocked: The mocks land closed"
      assert sent["context_only"] and not sent["wake"]
      Threads.capture_unblocks(entries, "test-host")
      assert Shuttle.ThreadOutbox.pending("test-host") == []
    end
  end

  test "a fiber's waiting count is its mailbox's undelivered context and its outbox's pending results",
       %{store: store} do
    assert {:ok, %{fibers: entries}} = FiberDocuments.list(felt_stores: [store])
    hub = Enum.find(entries, &(Threads.address(&1.fiber) == "hub"))
    uid = hub.fiber["uid"]

    assert Threads.pending_results(entries, "test-host") == %{}

    for {id, text} <- [{"m-1", "one"}, {"m-2", "two"}, {"m-2", "two"}],
        do: assert({:ok, :queued} = Shuttle.Delivery.context(hub, text, id))

    Shuttle.ThreadOutbox.capture([
      {"thread-unsent",
       %{
         "owner" => "test-host",
         "store" => store,
         "parent_uid" => uid,
         "text" => "t",
         "wake" => false
       }}
    ])

    assert Threads.pending_results(entries, "test-host") == %{uid => 3}
    assert Threads.pending_results(entries, "another-host") == %{}
  end

  test "superseded close and ask publications are dropped after publisher restart", %{
    store: store
  } do
    alias Shuttle.Test.StubPostClient
    StubPostClient.start!()
    Env.put_app_env(:write_forward_client, StubPostClient)
    remotes = Path.join(store, "remotes.json")

    File.write!(
      remotes,
      Jason.encode!(%{
        defaults: %{discover: false},
        remotes: [%{name: "parent-host", url: "http://127.0.0.1:43210"}]
      })
    )

    Env.put_env("SHUTTLE_REMOTES_FILE", remotes)
    Env.put_app_env(:remotes, [%{name: "parent-host", port: 43210}])
    parent_path = Path.join(store, ".felt/hub/hub.md")

    File.write!(
      parent_path,
      File.read!(parent_path) |> String.replace("host: test-host", "host: parent-host")
    )

    for {verb, args, clear} <- [
          {"close", [], ["reopen", "hub/child", "--local"]},
          {"ask", ["Keep this question"], ["ask", "hub/child", "--clear"]}
        ] do
      StubPostClient.set_response({:error, :unavailable})

      assert {:ok, _} =
               CLI.run_in_store(
                 store,
                 [verb, "hub/child" | args] ++ if(verb == "close", do: ["--local"], else: [])
               )

      assert {:ok, %{fibers: entries}} = FiberDocuments.list(felt_stores: [store])
      Threads.deliver_results(entries, "test-host")
      assert StubPostClient.last() != nil
      assert {:ok, _} = CLI.run_in_store(store, clear)

      assert {:ok, _} =
               CLI.run_in_store(store, [
                 "set-outcome",
                 "hub/child",
                 "--outcome",
                 "Changed after publication",
                 "--local"
               ])

      assert {:ok, %{fibers: cleared}} = FiberDocuments.list(felt_stores: [store])
      StubPostClient.set_response({:ok, 202, ~s({"queued":true,"delivery":"context"})})
      # A new publisher process has no memory of the observed close or ask.
      StubPostClient.set_get_response({:error, :not_set})
      Agent.update(Env.server!(StubPostClient), &Map.put(&1, :last, nil))
      task = Task.async(fn -> Threads.deliver_results(cleared, "test-host") end)
      Task.await(task, 30_000)
      assert StubPostClient.last() == nil
      assert Shuttle.ThreadOutbox.pending("test-host") == []
      Agent.update(Env.server!(StubPostClient), &Map.put(&1, :last, nil))
      Threads.deliver_results(entries, "test-host")
      assert StubPostClient.last() == nil
    end
  end

  for initial_host <- ["test-host", "parent-host"] do
    @tag initial_host: initial_host
    test "pending result follows intended parent UID through rename, nest and host move from #{initial_host}",
         %{store: store, initial_host: initial_host} do
      alias Shuttle.Test.StubPostClient
      StubPostClient.start!()
      Env.put_app_env(:write_forward_client, StubPostClient)
      remotes = Path.join(store, "remotes.json")

      File.write!(
        remotes,
        Jason.encode!(%{
          defaults: %{discover: false},
          remotes: [
            %{name: "parent-host", url: "http://127.0.0.1:43210"},
            %{name: "new-host", url: "http://127.0.0.1:43211"}
          ]
        })
      )

      Env.put_env("SHUTTLE_REMOTES_FILE", remotes)

      Env.put_app_env(:remotes, [
        %{name: "parent-host", port: 43210},
        %{name: "new-host", port: 43211}
      ])

      parent_path = Path.join(store, ".felt/hub/hub.md")

      File.write!(
        parent_path,
        String.replace(File.read!(parent_path), "host: test-host", "host: #{initial_host}")
      )

      assert {:ok, _} = CLI.run_in_store(store, ["ask", "hub/child", "Keep the original text"])
      assert {:ok, %{fibers: entries}} = FiberDocuments.list(felt_stores: [store])
      parent = Enum.find(entries, &(Threads.address(&1.fiber) == "hub"))
      uid = parent.fiber["uid"]
      assert is_binary(uid) and uid != Threads.address(parent.fiber)
      StubPostClient.set_response({:error, :unavailable})
      Env.put_app_env(:felt_runner, FailingMailboxRunner)
      Threads.deliver_results(entries, "test-host")
      Env.put_app_env(:felt_runner, Shuttle.Runner.Default)
      assert [{message_id, record}] = Shuttle.ThreadOutbox.pending("test-host")
      assert {:ok, _} = CLI.run_felt(["-C", store, "add", "elsewhere", "Elsewhere"])
      assert {:ok, _} = CLI.run_felt(["-C", store, "nest", "hub/child", "elsewhere"])
      assert {:ok, _} = CLI.run_felt(["-C", store, "add", "group", "Group"])
      File.rename!(Path.join(store, ".felt/hub/hub.md"), Path.join(store, ".felt/hub/renamed.md"))
      File.rename!(Path.join(store, ".felt/hub"), Path.join(store, ".felt/renamed"))
      assert {:ok, _} = CLI.run_felt(["-C", store, "nest", "renamed", "group"])
      path = Path.join(store, ".felt/group/renamed/renamed.md")

      File.write!(
        path,
        String.replace(File.read!(path), "host: #{initial_host}", "host: new-host")
      )

      bytes = File.read!(path)
      File.rm!(path)
      Agent.update(Env.server!(StubPostClient), &Map.put(&1, :last, nil))
      assert :ok = Threads.retry_results("test-host")
      assert StubPostClient.last() == nil
      assert [{^message_id, ^record}] = Shuttle.ThreadOutbox.pending("test-host")
      File.write!(path, bytes)
      StubPostClient.set_response({:ok, 202, ~s({"queued":true,"delivery":"context"})})
      # New publisher process: no in-memory placement or publication state.
      Task.async(fn -> Threads.retry_results("test-host") end) |> Task.await(30_000)
      assert %{url: url, body: body} = StubPostClient.last()
      assert url =~ "43211"

      assert %{
               "fiber_id" => ^uid,
               "message_id" => ^message_id,
               "text" => "thread hub/child asked: Keep the original text"
             } = Jason.decode!(body)

      assert Shuttle.ThreadOutbox.pending("test-host") == []
    end
  end

  test "normal close wakes, quiet close supplies context, and ask always wakes across retry and restart",
       %{store: store} do
    alias Shuttle.Test.StubPostClient
    StubPostClient.start!()
    Env.put_app_env(:write_forward_client, StubPostClient)
    Env.put_app_env(:remotes, [%{name: "parent-host", port: 43210}])
    path = Path.join(store, ".felt/hub/hub.md")
    File.write!(path, String.replace(File.read!(path), "host: test-host", "host: parent-host"))

    for {verb, args, expected_wake} <- [
          {"close", ["--quiet", "--local"], false},
          {"ask", ["Needs a decision"], true},
          {"close", ["--local"], true}
        ] do
      assert {:ok, _} = CLI.run_in_store(store, ["reopen", "hub/child", "--local"])
      StubPostClient.set_response({:error, :unavailable})
      assert {:ok, _} = CLI.run_in_store(store, [verb, "hub/child" | args])
      assert {:ok, %{fibers: entries}} = FiberDocuments.list(felt_stores: [store])
      Threads.deliver_results(entries, "test-host")
      assert [{id, record}] = Shuttle.ThreadOutbox.pending("test-host")
      assert record["wake"] == expected_wake
      original = StubPostClient.last().body |> Jason.decode!()
      assert original["wake"] == expected_wake
      StubPostClient.set_response({:ok, 202, ~s({"queued":true,"delivery":"context"})})

      Task.async(fn ->
        Shuttle.ThreadOutbox.boot_baseline()
        Threads.retry_results("test-host")
      end)
      |> Task.await(30_000)

      assert StubPostClient.last().body |> Jason.decode!() == original
      assert original["message_id"] == id
      assert Shuttle.ThreadOutbox.pending("test-host") == []
    end
  end

  test "fresh validation rejects archived closes and stale captures and replaced asks", %{
    store: store
  } do
    for {verb, args, supersede} <- [
          {"close", ["--local"], ["reopen", "hub/child", "--local"]},
          {"ask", ["First question"], ["ask", "hub/child", "Second question"]},
          {"close", ["--local"], ["close", "hub/child", "--tempered=true", "--local"]}
        ] do
      assert {:ok, _} = CLI.run_in_store(store, ["reopen", "hub/child", "--local"])
      assert {:ok, _} = CLI.run_in_store(store, [verb, "hub/child" | args])
      assert {:ok, %{fibers: entries}} = FiberDocuments.list(felt_stores: [store])
      Threads.capture_results(entries, "test-host")
      [{id, record}] = Shuttle.ThreadOutbox.pending("test-host")
      params = %{"signal" => record["signal"], "message_id" => id, "text" => record["text"]}
      assert {:ok, true} = Threads.signal_current(params, felt_stores: [store])

      assert %{"current" => true} =
               api_conn() |> post("/api/v1/thread-signals/current", params) |> json_response(200)

      assert {:ok, true} =
               Threads.signal_current(Map.delete(params, "signal"), felt_stores: [store])

      assert {:ok, _} = CLI.run_in_store(store, supersede)
      assert {:ok, false} = Threads.signal_current(params, felt_stores: [store])

      assert %{"current" => false} =
               api_conn() |> post("/api/v1/thread-signals/current", params) |> json_response(200)

      assert {:ok, false} =
               Threads.signal_current(Map.delete(params, "signal"), felt_stores: [store])

      # An old poll snapshot must not republish after the current document changed.
      Threads.deliver_results(entries, "test-host")
      assert Shuttle.ThreadOutbox.pending("test-host") == []
    end
  end

  test "a handoff notice survives dispatch; later handoff, rest and close supersede it", %{
    store: store
  } do
    for superseding <- ["handoff", "rest", "close"] do
      assert {:ok, _} = CLI.run_in_store(store, ["reopen", "hub/child", "--local"])
      assert {:ok, _} = CLI.run_in_store(store, ["handoff", "hub/child"])
      assert {:ok, %{fibers: entries}} = FiberDocuments.list(felt_stores: [store])
      Threads.capture_results(entries, "test-host")
      child = Enum.find(entries, &(Threads.address(&1.fiber) == "hub/child"))
      stamp = get_in(child.fiber, ["shuttle", "runtime", "handed_off_at"])

      [{id, record} | _] =
        Enum.filter(Shuttle.ThreadOutbox.pending("test-host"), fn {_id, record} ->
          get_in(record, ["signal", "verb"]) == "handed off" and
            get_in(record, ["signal", "stamp"]) == stamp
        end)

      params = %{"signal" => record["signal"], "message_id" => id, "text" => record["text"]}
      assert {:ok, true} = Threads.signal_current(params, felt_stores: [store])

      later = DateTime.utc_now() |> DateTime.add(5, :second) |> DateTime.to_iso8601()

      assert {:ok, _} =
               CLI.run_in_store(store, ["mark-runtime", "hub/child", "--dispatched-at", later])

      assert {:ok, true} = Threads.signal_current(params, felt_stores: [store])

      args =
        if superseding == "handoff",
          do: [superseding, "hub/child"],
          else: [superseding, "hub/child", "--local"]

      assert {:ok, _} = CLI.run_in_store(store, args)
      assert {:ok, false} = Threads.signal_current(params, felt_stores: [store])

      if superseding in ["rest", "close"] do
        assert {:ok, _} =
                 CLI.run_in_store(store, [
                   "mark-runtime",
                   "hub/child",
                   "--thread-exit-verb",
                   ""
                 ])

        assert {:ok, _} = CLI.run_in_store(store, ["reopen", "hub/child", "--local"])
        assert {:ok, false} = Threads.signal_current(params, felt_stores: [store])
      end
    end
  end

  test "a second close after rearming publishes a new signal", %{store: store} do
    assert {:ok, _} = CLI.run_in_store(store, ["reopen", "hub/child", "--local"])
    assert {:ok, _} = CLI.run_in_store(store, ["close", "hub/child", "--local"])
    assert {:ok, %{fibers: first_entries}} = FiberDocuments.list(felt_stores: [store])
    Threads.capture_results(first_entries, "test-host")
    [{first_id, _}] = Shuttle.ThreadOutbox.pending("test-host")
    Threads.retry_results("test-host")
    assert Shuttle.ThreadOutbox.pending("test-host") == []

    assert {:ok, _} = CLI.run_in_store(store, ["reopen", "hub/child", "--local"])
    assert {:ok, _} = CLI.run_in_store(store, ["close", "hub/child", "--local"])
    assert {:ok, %{fibers: second_entries}} = FiberDocuments.list(felt_stores: [store])
    Threads.capture_results(second_entries, "test-host")

    assert [{second_id, %{"signal" => %{"verb" => "closed"}}}] =
             Enum.reject(Shuttle.ThreadOutbox.pending("test-host"), fn {id, _} ->
               id == first_id
             end)

    refute second_id == first_id

    Threads.retry_results("test-host")
    assert Shuttle.ThreadOutbox.pending("test-host") == []
  end

  test "validation follows the child's owner and keeps unavailable signals pending", %{
    store: store
  } do
    alias Shuttle.Test.StubPostClient
    StubPostClient.start!()
    Env.put_app_env(:write_forward_client, StubPostClient)
    Env.put_app_env(:remotes, [%{name: "child-host", port: 43210}])
    assert {:ok, _} = CLI.run_in_store(store, ["close", "hub/child", "--local"])
    assert {:ok, %{fibers: entries}} = FiberDocuments.list(felt_stores: [store])
    Threads.capture_results(entries, "test-host")
    [{id, record}] = Shuttle.ThreadOutbox.pending("test-host")
    child = Path.join(store, ".felt/hub/child/child.md")
    File.write!(child, String.replace(File.read!(child), "host: test-host", "host: child-host"))
    params = %{"signal" => record["signal"], "message_id" => id, "text" => record["text"]}
    StubPostClient.set_response({:error, :unavailable})
    assert {:error, _} = Threads.signal_current(params, felt_stores: [store])
    Threads.retry_results("test-host")
    assert [{^id, ^record}] = Shuttle.ThreadOutbox.pending("test-host")
    StubPostClient.set_response({:ok, 200, ~s({"current":false})})
    assert {:ok, false} = Threads.signal_current(params, felt_stores: [store])
    assert %{url: url} = StubPostClient.last()
    assert url =~ "/api/v1/thread-signals/current"
    Threads.retry_results("test-host")
    assert Shuttle.ThreadOutbox.pending("test-host") == []
  end

  test "a missing mirror validates at the captured owner without a forwarding loop", %{
    store: store
  } do
    alias Shuttle.Test.StubPostClient
    StubPostClient.start!()
    Env.put_app_env(:write_forward_client, StubPostClient)
    Env.put_app_env(:remotes, [%{name: "child-host", port: 43210}])
    StubPostClient.set_response({:ok, 200, ~s({"current":true})})

    params = %{
      "signal" => %{
        "uid" => "missing-child",
        "verb" => "asked",
        "stamp" => "2026-10-30T00:00:00Z",
        "owner" => "child-host"
      },
      "message_id" => "thread-pending",
      "text" => "thread hub/new asked: Decide"
    }

    assert {:ok, true} = Threads.signal_current(params, felt_stores: [store])
    assert %{body: body} = StubPostClient.last()
    assert Jason.decode!(body) == Map.put(params, "forwarded", true)
    Agent.update(Env.server!(StubPostClient), &Map.put(&1, :last, nil))

    assert {:ok, false} =
             Threads.signal_current(Map.put(params, "forwarded", true), felt_stores: [store])

    assert StubPostClient.last() == nil
  end

  test "an old owner validation endpoint returning 404 delivers unvalidated", %{store: store} do
    alias Shuttle.Test.StubPostClient
    StubPostClient.start!()
    Env.put_app_env(:write_forward_client, StubPostClient)
    Env.put_app_env(:remotes, [%{name: "child-host", port: 43210}])
    assert {:ok, _} = CLI.run_in_store(store, ["close", "hub/child", "--local"])
    assert {:ok, %{fibers: entries}} = FiberDocuments.list(felt_stores: [store])
    Threads.capture_results(entries, "test-host")
    [{id, record}] = Shuttle.ThreadOutbox.pending("test-host")
    child = Path.join(store, ".felt/hub/child/child.md")
    File.write!(child, String.replace(File.read!(child), "host: test-host", "host: child-host"))
    StubPostClient.set_response({:ok, 404, "not found"})
    params = %{"signal" => record["signal"], "message_id" => id, "text" => record["text"]}

    assert {:ok, true} = Threads.signal_current(params, felt_stores: [store])
  end

  test "a legacy notice with no owner or local mirror is delivered unvalidated", %{store: store} do
    params = %{
      "text" => "thread hub/not-yet-synced closed: done",
      "message_id" => "thread-legacy"
    }

    assert {:ok, true} = Threads.signal_current(params, felt_stores: [store])

    ownerless = %{
      "signal" => %{"uid" => "not-yet-synced-uid", "verb" => "closed", "stamp" => "old"},
      "text" => params["text"],
      "message_id" => params["message_id"]
    }

    assert {:ok, true} = Threads.signal_current(ownerless, felt_stores: [store])
  end

  test "a legacy slug collision across stores is not validated against the first store", %{
    store: store
  } do
    second = store <> "-collision"
    File.mkdir_p!(second)
    File.cp_r!(Path.join(store, ".felt"), Path.join(second, ".felt"))
    on_exit(fn -> File.rm_rf(second) end)

    params = %{
      "text" => "thread hub/child closed: old result",
      "message_id" => "thread-legacy-collision"
    }

    assert {:ok, true} = Threads.signal_current(params, felt_stores: [store, second])
  end

  test "results reach only the nearest orchestrator and never propagate automatically", %{
    store: store,
    data: data
  } do
    assert {:ok, _} =
             CLI.run_in_store(store, [
               "thread",
               "hub/child",
               "Deep work",
               "--slug",
               "deep",
               "--disabled"
             ])

    assert {:ok, _} = CLI.run_in_store(store, ["close", "hub/child/deep", "--local"])
    assert {:ok, %{fibers: entries}} = FiberDocuments.list(felt_stores: [store])
    parent = Enum.find(entries, &(Threads.address(&1.fiber) == "hub/child"))
    Threads.capture_results(entries, "test-host")
    assert [{_, %{"parent_uid" => uid}}] = Shuttle.ThreadOutbox.pending("test-host")
    assert uid == parent.fiber["uid"]
    Threads.deliver_results(entries, "test-host")
    assert [%{"request" => %{"text" => "thread hub/child/deep closed: "}}] = pending(data)
    # Repeated delivery/polling does not manufacture a result for the hub.
    Threads.deliver_results(entries, "test-host")
    assert length(pending(data)) == 1
    assert Shuttle.ThreadOutbox.pending("test-host") == []
    assert {:ok, %{fibers: latest}} = FiberDocuments.list(felt_stores: [store])
    child = Enum.find(latest, &(Threads.address(&1.fiber) == "hub/child"))
    assert child.fiber["status"] == "open"
    refute Map.has_key?(child.fiber, "closed_at")
  end

  test "an archived constitution orchestrates nothing: its live threads report to the next one up",
       %{store: store, data: data} do
    assert {:ok, _} =
             CLI.run_in_store(store, [
               "thread",
               "hub/child",
               "Deep work",
               "--slug",
               "deep",
               "--disabled"
             ])

    assert {:ok, _} =
             CLI.run_in_store(store, ["close", "hub/child", "--tempered=true", "--local"])

    assert {:ok, %{fibers: entries}} = FiberDocuments.list(felt_stores: [store])
    hub = Enum.find(entries, &(Threads.address(&1.fiber) == "hub"))
    deep = Enum.find(entries, &(Threads.address(&1.fiber) == "hub/child/deep"))
    assert Threads.orchestrator(deep, entries).fiber["uid"] == hub.fiber["uid"]

    stamped = Threads.put_orchestrators(entries)

    assert Enum.find(stamped, &(Threads.address(&1.fiber) == "hub/child/deep")).orchestrator ==
             hub.fiber["id"]

    assert [
             %{"id" => "hub/child", "state" => "Archived", "threads" => []},
             %{"id" => "hub/child/deep"}
           ] =
             Threads.tree("hub", store, entries, MapSet.new())

    assert Shuttle.Dispatcher.render_prompt("hub/child/deep", felt_store: store) =~
             "You are a thread of hub (Hub)."

    assert {:ok, _} = CLI.run_in_store(store, ["close", "hub/child/deep", "--local"])
    assert {:ok, %{fibers: entries}} = FiberDocuments.list(felt_stores: [store])
    Threads.capture_results(entries, "test-host")
    hub_uid = hub.fiber["uid"]

    # Archived threads publish no result; the live descendant still reports.
    assert [
             %{"parent_uid" => ^hub_uid, "text" => "thread hub/child closed: "},
             %{"parent_uid" => ^hub_uid, "text" => "thread hub/child/deep closed: "}
           ] =
             Shuttle.ThreadOutbox.pending("test-host")
             |> Enum.map(&elem(&1, 1))
             |> Enum.sort_by(& &1["text"])

    Threads.deliver_results(entries, "test-host")
    assert "thread hub/child/deep closed: " in Enum.map(pending(data), & &1["request"]["text"])
    assert Shuttle.ThreadOutbox.pending("test-host") == []
  end

  @tag first_boot: true
  test "snapshot migration preserves the cutoff, intended UID, pending text and acknowledgment dedup",
       %{store: store, data: data} do
    alias Shuttle.ThreadOutbox
    assert {:ok, %{fibers: entries}} = FiberDocuments.list(felt_stores: [store])
    parent = Enum.find(entries, &(Threads.address(&1.fiber) == "hub"))
    baseline = "2025-01-01T00:00:00Z"

    record = %{
      "owner" => "test-host",
      "store" => store,
      "parent" => parent.fiber,
      "text" => "original",
      "wake" => false
    }

    File.write!(
      Path.join(data, "thread-outbox.json"),
      Jason.encode!(%{
        version: 2,
        baseline: baseline,
        records: %{
          "pending" => record,
          "done" => record |> Map.put("acked", true) |> Map.put("text", "acked-only-secret")
        }
      })
    )

    assert :ok = ThreadOutbox.boot_baseline()
    assert ThreadOutbox.baseline() == baseline
    refute File.exists?(Path.join(data, "thread-outbox.json"))
    files = Path.wildcard(Path.join(data, "thread-outbox/**/*")) |> Enum.filter(&File.regular?/1)
    refute Enum.any?(files, &String.contains?(File.read!(&1), "acked-only-secret"))
    uid = parent.fiber["uid"]

    assert [{"pending", %{"parent_uid" => ^uid, "text" => "original"} = migrated}] =
             ThreadOutbox.pending("test-host")

    refute Map.has_key?(migrated, "parent")
    assert :ok = ThreadOutbox.capture([{"done", record}])
    assert [{"pending", ^migrated}] = ThreadOutbox.pending("test-host")
    Task.async(fn -> Threads.retry_results("test-host") end) |> Task.await(30_000)
    assert ThreadOutbox.pending("test-host") == []
    assert ThreadOutbox.baseline() == baseline
  end

  @tag first_boot: true
  test "corrupt baseline fails closed and migration retains pending outbox records", %{data: data} do
    alias Shuttle.ThreadOutbox
    path = Path.join(data, "thread-outbox.json")

    record = %{
      "owner" => "test-host",
      "text" => "immutable",
      "parent" => %{},
      "store" => "store",
      "wake" => true
    }

    File.write!(path, Jason.encode!(%{version: 1, records: %{"pending" => record}}))
    assert :ok = ThreadOutbox.boot_baseline()
    baseline = ThreadOutbox.baseline()
    assert [{"pending", ^record}] = ThreadOutbox.pending("test-host")
    assert :ok = ThreadOutbox.boot_baseline()
    assert ThreadOutbox.baseline() == baseline

    for corrupt <- [
          "{",
          ~s({"version":2,"records":{},"baseline":"not-a-date"}),
          ~s({"version":2,"records":{}})
        ] do
      File.write!(path, corrupt)

      try do
        ThreadOutbox.boot_baseline()
        flunk("corrupt baseline was accepted")
      rescue
        _ in [Jason.DecodeError, MatchError, RuntimeError, KeyError] -> :ok
      end

      assert File.read!(path) == corrupt
    end
  end

  test "baseline corruption or loss refuses recovery without touching pending payloads", %{
    data: data
  } do
    alias Shuttle.ThreadOutbox

    assert :ok =
             ThreadOutbox.capture([
               {"pending", %{"owner" => "test-host", "text" => "preserve me"}}
             ])

    cutoff = ThreadOutbox.baseline()
    baseline_path = Path.join(data, "thread-outbox/baseline")
    [payload] = Path.wildcard(Path.join(data, "thread-outbox/pending/*.json"))
    bytes = File.read!(payload)
    File.write!(baseline_path, "corrupt")
    assert_raise MatchError, fn -> ThreadOutbox.boot_baseline() end
    assert File.read!(payload) == bytes
    assert File.read!(baseline_path) == "corrupt"
    File.rm!(baseline_path)
    assert_raise RuntimeError, fn -> ThreadOutbox.boot_baseline() end
    assert File.read!(payload) == bytes
    # Operator restores the exact trusted cutoff, never a new current time.
    File.write!(baseline_path, cutoff)
    assert :ok = ThreadOutbox.boot_baseline()
    assert [{"pending", %{"text" => "preserve me"}}] = ThreadOutbox.pending("test-host")
    assert ThreadOutbox.baseline() == cutoff
  end

  test "acknowledged publications retain dedup identity without their payload", %{data: data} do
    alias Shuttle.ThreadOutbox

    record = %{
      "owner" => "test-host",
      "text" => "unique-acknowledged-payload",
      "parent_uid" => "parent"
    }

    assert :ok = ThreadOutbox.capture([{"done", record}])
    assert :ok = ThreadOutbox.acknowledge("done")
    files = Path.wildcard(Path.join(data, "**/*")) |> Enum.filter(&File.regular?/1)
    refute Enum.any?(files, &String.contains?(File.read!(&1), "unique-acknowledged-payload"))

    Task.async(fn ->
      ThreadOutbox.boot_baseline()
      ThreadOutbox.capture([{"done", record}])
    end)
    |> Task.await(30_000)

    assert ThreadOutbox.pending("test-host") == []
  end

  test "outbox compacts acknowledgments to IDs and changes only the addressed backlog files", %{
    data: data
  } do
    alias Shuttle.ThreadOutbox

    records =
      for n <- 1..200,
          do:
            {"result-#{n}",
             %{
               "owner" => "test-host",
               "text" => String.duplicate("payload-#{n}", 100),
               "parent_uid" => "parent",
               "store" => "store",
               "wake" => false
             }}

    assert :ok = ThreadOutbox.capture(records)
    # Payload storage is bounded by pending work, not accumulated history.
    payload_paths = Path.wildcard(Path.join(data, "thread-outbox/pending/*.json"))
    assert length(payload_paths) == 200
    # Reads may update atime; only write-related metadata tests rewriting.
    before =
      Map.new(
        payload_paths,
        &{&1, {Map.take(File.stat!(&1), [:inode, :mtime, :ctime, :size]), File.read!(&1)}}
      )

    assert :ok = ThreadOutbox.acknowledge("result-1")
    assert length(ThreadOutbox.pending("test-host")) == 199
    after_paths = Path.wildcard(Path.join(data, "thread-outbox/pending/*.json"))
    assert length(after_paths) == 199

    for path <- after_paths,
        do:
          assert(
            {Map.take(File.stat!(path), [:inode, :mtime, :ctime, :size]), File.read!(path)} ==
              before[path]
          )

    [acked_path] = Path.wildcard(Path.join(data, "thread-outbox/acked/*"))
    assert File.read!(acked_path) == "result-1"
    refute File.read!(acked_path) =~ "payload"
    ack_stat = File.stat!(acked_path)
    # Capture and ack do not decode old payloads or rewrite acknowledged history.
    corrupt_path = hd(after_paths)
    original = File.read!(corrupt_path)
    File.write!(corrupt_path, "unreadable unrelated payload")
    assert :ok = ThreadOutbox.capture([{"extra", %{"owner" => "test-host", "text" => "extra"}}])
    assert :ok = ThreadOutbox.acknowledge("extra")
    File.write!(corrupt_path, original)
    assert File.stat!(acked_path) == ack_stat

    Task.async(fn ->
      ThreadOutbox.boot_baseline()
      ThreadOutbox.capture(records)
    end)
    |> Task.await(30_000)

    assert length(ThreadOutbox.pending("test-host")) == 199
    assert File.stat!(acked_path) == ack_stat
  end

  @tag first_boot: true
  test "first boot suppresses historical tempered results and restart retains the baseline", %{
    store: store,
    data: data
  } do
    import Shuttle.Test.PollerHelpers
    bin = Path.join(store, "isolated-bin")
    File.mkdir_p!(bin)
    tmux = Shuttle.Env.find_executable("tmux")
    socket = Path.join(System.tmp_dir!(), "baseline-#{System.unique_integer([:positive])}.sock")

    File.write!(
      Path.join(bin, "tmux"),
      "#!/bin/sh\nexec '#{tmux}' -S '#{socket}' -f /dev/null \"$@\"\n"
    )

    File.chmod!(Path.join(bin, "tmux"), 0o700)
    Env.prepend_path(bin)

    assert {:ok, _} =
             CLI.run_in_store(store, [
               "thread",
               "hub",
               "Discarded",
               "--slug",
               "discarded",
               "--disabled"
             ])

    for {slug, verdict} <- [{"child", "true"}, {"discarded", "false"}] do
      assert {:ok, _} =
               CLI.run_in_store(store, [
                 "close",
                 "hub/" <> slug,
                 "--tempered=" <> verdict,
                 "--local"
               ])

      path = Path.join([store, ".felt", "hub", slug, slug <> ".md"])

      old =
        File.read!(path)
        |> String.replace(~r/closed-at: [^\n]+/, "closed-at: 2020-01-01T00:00:00Z")

      File.write!(path, old)
    end

    opts = [
      runner: SocketRunner,
      own_host_id: "test-host",
      felt_stores: [store],
      boot_quarantine: true,
      poll_interval_ms: 600_000
    ]

    assert {:ok, poller} = start_poller!(opts)
    await_boot_cycle!(poller)
    assert {:ok, %{fibers: entries}} = FiberDocuments.list(felt_stores: [store])
    Threads.deliver_results(entries, "test-host")
    assert pending(data) == []

    # Stamp a fresh signal before restarting. A per-boot baseline would lose it.
    assert {:ok, _} = CLI.run_in_store(store, ["reopen", "hub/child", "--local"])
    assert {:ok, _} = CLI.run_in_store(store, ["ask", "hub/child", "A new question"])
    GenServer.stop(poller)
    assert {:ok, restarted} = start_poller!(opts)
    await_boot_cycle!(restarted)
    assert {:ok, %{fibers: latest}} = FiberDocuments.list(felt_stores: [store])
    Threads.deliver_results(latest, "test-host")
    assert [%{"request" => %{"text" => text}}] = pending(data)
    assert text == "thread hub/child asked: A new question"
  end

  test "fresh, resume and standing prompts identify the nearest current orchestrator", %{
    store: store
  } do
    assert {:ok, _} = CLI.run_felt(["-C", store, "add", "hub/notes", "Notes"])
    assert {:ok, _} = CLI.run_felt(["-C", store, "add", "hub/notes/deep", "Deep"])

    for prompt <- [
          Shuttle.Dispatcher.render_prompt("hub/notes/deep", felt_store: store),
          Shuttle.Dispatcher.render_resume_prompt("hub/notes/deep", felt_store: store),
          Shuttle.Dispatcher.render_standing_run_prompt("hub/notes/deep", "run-1",
            felt_store: store
          )
        ] do
      assert prompt =~ "You are a thread of hub (Hub)."

      assert prompt =~
               "Your outcome is delivered to that orchestrator when you close or ask; write it for that reader."
    end

    assert {:ok, _} =
             CLI.run_in_store(store, ["install", "hub/notes", "--disabled", "--host", "test-host"])

    assert Shuttle.Dispatcher.render_prompt("hub/notes/deep", felt_store: store) =~
             "thread of hub/notes (Notes)"

    refute Shuttle.Dispatcher.render_prompt("hub", felt_store: store) =~ "You are a thread"
  end

  test "a non-owning mirror cannot publish results or queue parent context", %{
    store: store,
    data: data
  } do
    assert {:ok, _} = CLI.run_in_store(store, ["close", "hub/child", "--local"])
    assert {:ok, %{fibers: entries}} = FiberDocuments.list(felt_stores: [store])
    Threads.deliver_results(entries, "another-host")
    assert pending(data) == []
    [parent | _] = Enum.filter(entries, &(Threads.address(&1.fiber) == "hub"))
    parent = put_in(parent.fiber["shuttle"]["host"], "another-host")
    assert {:error, :not_owner} = Shuttle.Delivery.context(parent, "not here", "no")
    assert pending(data) == []
  end

  @tag skip: is_nil(System.find_executable("tmux"))
  test "an isolated daemon dispatches a real tmux process and offers dormant and live results once",
       %{store: store, data: data} do
    alias Shuttle.Poller
    import Shuttle.Test.PollerHelpers

    api =
      start_supervised!(
        {Bandit, plug: {ScopedAPI, self()}, port: 0, ip: {127, 0, 0, 1}, startup_log: false}
      )

    {:ok, {_, api_port}} = ThousandIsland.listener_info(api)
    Env.put_env("SHUTTLE_DAEMON_URL", "http://127.0.0.1:#{api_port}")
    socket = Path.join(System.tmp_dir!(), "th-#{System.unique_integer([:positive])}.sock")
    bin = Path.join(store, "bin")
    File.mkdir_p!(bin)
    real_tmux = Shuttle.Env.find_executable("tmux")

    File.write!(
      Path.join(bin, "tmux"),
      "#!/bin/sh\nexec '#{real_tmux}' -S '#{socket}' -f /dev/null \"$@\"\n"
    )

    File.chmod!(Path.join(bin, "tmux"), 0o700)
    Env.prepend_path(bin)

    File.write!(
      Path.join(Shuttle.Env.home(), ".bash_profile"),
      "export PATH='#{bin}:#{Shuttle.Env.get("PATH")}'\n"
    )

    Env.put_app_env(:felt_runner, SocketRunner)
    Env.put_app_env(:os_type, {:unix, :linux})
    wrapper = Path.join(store, "receiver")
    cli = Shuttle.Env.find_executable("shuttle")
    gate = Path.join(store, "gate")
    assert {_, 0} = Shuttle.Env.cmd("mkfifo", [gate])
    native_dir = Path.join(System.tmp_dir!(), "tn-#{System.unique_integer([:positive])}")
    File.mkdir_p!(native_dir)
    File.chmod!(native_dir, 0o700)
    native_socket = Path.join(native_dir, "s")
    transcript = Path.join(store, "native.jsonl")
    File.write!(transcript, "")

    {:ok, listener} =
      :gen_tcp.listen(0, [:binary, active: false, packet: :line, ifaddr: {:local, native_socket}])

    File.chmod!(native_socket, 0o600)
    test_pid = self()

    start_supervised!(
      {Task, fn -> native_receiver(listener, transcript, Path.join(store, "ready"), test_pid) end}
    )

    on_exit(fn ->
      :gen_tcp.close(listener)
      File.rm_rf(native_dir)
    end)

    # This deterministic harness stand-in executes the real message hooks in
    # a real tmux pane; no transport or lifecycle call is mocked.
    File.write!(wrapper, """
    #!/bin/bash
    export HOME='#{Shuttle.Env.home()}' SHUTTLE_DATA_DIR='#{data}' SHUTTLE_HOST=test-host
    export CLAUDE_CODE_MESSAGING_SOCKET='#{native_socket}'
    export SHUTTLE_DAEMON_URL='#{Shuttle.Env.get("SHUTTLE_DAEMON_URL")}'
    while [ "$#" -gt 0 ]; do
      if [ "$1" = --session-id ]; then uuid="$2"; shift; fi
      shift
    done
    hook() {
      printf '{"session_id":"%s","hook_event_name":"%s","harness":"claude","transcript_path":"#{transcript}","cwd":"#{store}"}\\n' "$uuid" "$1" | '#{cli}' hook event >> '#{store}/received'
    }
    hook SessionStart
    echo "$uuid" > '#{store}/ready'
    while read line < '#{gate}'; do hook UserPromptSubmit; echo done >> '#{store}/rounds'; done
    """)

    File.chmod!(wrapper, 0o700)
    registry = Path.join(store, "agents.json")

    File.write!(
      registry,
      Jason.encode!(%{
        version: 1,
        agents: [
          %{id: "claude-opus", cli: "claude", model: "opus", wrapper: wrapper, default: true}
        ]
      })
    )

    Env.put_env("SHUTTLE_AGENTS_FILE", registry)
    assert {:ok, _} = CLI.run_in_store(store, ["set-model", "hub", "claude-opus", "--local"])
    assert {:ok, _} = CLI.run_in_store(store, ["close", "hub/child", "--local"])
    assert {:ok, %{fibers: entries}} = FiberDocuments.list(felt_stores: [store])
    Threads.deliver_results(entries, "test-host")
    assert [_] = pending(data)

    assert {_, 0} =
             SocketRunner.cmd("tmux", ["new-session", "-d", "-s", "anchor", "sleep", "300"], [])

    assert {actual_socket, 0} =
             SocketRunner.cmd("tmux", ["display-message", "-p", "\#{socket_path}"], [])

    assert String.trim(actual_socket) == socket

    on_exit(fn ->
      Shuttle.Env.cmd("tmux", ["-S", socket, "kill-server"], stderr_to_stdout: true)
    end)

    {:ok, poller} =
      start_poller!(
        runner: SocketRunner,
        own_host_id: "test-host",
        felt_stores: [store],
        boot_quarantine: true,
        poll_interval_ms: 600_000
      )

    await_boot_cycle!(poller)
    assert {:ok, _session} = Poller.dispatch_fiber(poller, "hub", force: true)
    await(fn -> File.exists?(Path.join(store, "ready")) end)

    await(fn ->
      match?(%{session_uuid: id} when is_binary(id), Poller.live_worker(poller, "hub"))
    end)

    assert {:ok, %{fibers: entries}} = FiberDocuments.list(felt_stores: [store])
    Threads.deliver_results(entries, "test-host")
    parent = Enum.find(entries, &(Threads.address(&1.fiber) == "hub"))
    assert {:ok, _} = Shuttle.Delivery.flush_context(parent)
    assert [_] = pending(data)
    first_native = File.read!(Path.join(store, "ready")) |> String.trim()

    authority_path =
      Path.wildcard(Path.join(data, "mailboxes/fiber/*/destination.json"))
      |> Enum.find(&(Jason.decode!(File.read!(&1))["identity"] != ""))

    authority = File.read!(authority_path)
    assert {:ok, _} = Shuttle.Delivery.flush_context(parent)
    assert {:ok, _} = Shuttle.Delivery.flush_context(parent)
    assert File.read!(authority_path) == authority

    stale_hook = fn ->
      script = """
      for event in SessionStart UserPromptSubmit; do
        printf '{"session_id":"#{first_native}","hook_event_name":"%s","harness":"claude","cwd":"#{store}"}\\n' "$event" | '#{cli}' hook event
      done
      """

      assert {output, 0} = Shuttle.Env.cmd("bash", ["--noprofile", "--norc", "-c", script])
      refute output =~ "thread hub/child closed:"
    end

    # Replace A while its result is still waiting for a hook. The successor
    # offers the same fiber mailbox; no copy is stranded in A's session queue.
    assert {:ok, _} = Poller.lifecycle_transition(poller, :rest, "hub", [])
    stale_hook.()
    assert [_] = pending(data)
    removed = Jason.decode!(File.read!(authority_path))
    assert removed["identity"] == ""
    assert removed["generation"] > Jason.decode!(authority)["generation"]
    File.rm!(Path.join(store, "ready"))
    assert {:ok, _} = Poller.dispatch_fiber(poller, "hub", force: true)
    await(fn -> File.exists?(Path.join(store, "ready")) end)

    await(fn ->
      case Poller.live_worker(poller, "hub") do
        %{session_uuid: uuid} when is_binary(uuid) -> uuid != first_native
        _ -> false
      end
    end)

    # No post-replacement flush: registration itself must revoke A.
    assert [_] = pending(data)
    # A fresh process re-registers the stale session and runs its hook first.
    # Its old subscription is discovery only, not authority to drain B's mail.
    stale_hook.()
    assert [_] = pending(data)
    assert {:ok, _} = Shuttle.Delivery.flush_context(parent)
    File.write!(gate, "offer\n")
    await(fn -> File.exists?(Path.join(store, "rounds")) end)
    assert pending(data) == []
    received_result = File.read!(Path.join(store, "received"))
    assert length(String.split(received_result, "thread hub/child closed:")) == 2
    native = File.read!(Path.join(store, "ready")) |> String.trim()
    authority = File.read!(authority_path)
    GenServer.stop(poller)

    {:ok, poller} =
      start_poller!(
        runner: SocketRunner,
        own_host_id: "test-host",
        felt_stores: [store],
        boot_quarantine: true,
        poll_interval_ms: 600_000
      )

    await_boot_cycle!(poller)
    assert %{session_uuid: ^native} = Poller.live_worker(poller, "hub")
    assert File.read!(authority_path) == authority
    tasks_dir = Path.join([store, "tasks", native])
    File.mkdir_p!(tasks_dir)
    Env.put_env("SHUTTLE_CLAUDE_TASKS_DIR", Path.join(store, "tasks"))

    File.write!(
      Path.join(tasks_dir, "1.json"),
      Jason.encode!(%{
        id: "1",
        subject: "Read the result",
        activeForm: "Reading the result",
        status: "in_progress"
      })
    )

    assert {:ok, _} = CLI.run_in_store(store, ["reopen", "hub/child", "--local"])
    assert {:ok, _} = CLI.run_in_store(store, ["ask", "hub/child", "Choose a kernel?"])
    send(poller, :run_poll_cycle)

    await(fn ->
      length(Path.wildcard(Path.join(data, "mailboxes/fiber/*/offered/*.json"))) == 2
    end)

    assert {:ok, %{fibers: feed}} = Poller.cached_fiber_documents(poller)

    assert %{
             runtime: %{
               session_uuid: ^native,
               state: "running",
               tasks: [
                 %{
                   id: "1",
                   subject: "Read the result",
                   status: "in_progress",
                   activeForm: "Reading the result"
                 }
               ]
             }
           } = Enum.find(feed, &(Threads.address(&1.fiber) == "hub"))

    assert_receive {:wake, ask_text}
    assert ask_text =~ "thread hub/child asked: Choose a kernel?"
    assert {:ok, _} = CLI.run_in_store(store, ["reopen", "hub/child", "--local"])
    assert {:ok, _} = CLI.run_in_store(store, ["close", "hub/child", "--local"])
    assert {:ok, %{fibers: latest}} = FiberDocuments.list(felt_stores: [store])
    Threads.deliver_results(latest, "test-host")
    assert_receive {:wake, close_text}
    assert close_text =~ "thread hub/child closed:"
    Threads.deliver_results(latest, "test-host")
    refute_receive {:wake, _}
    received = File.read!(Path.join(store, "received"))
    File.write!(gate, "offer\n")

    await(fn ->
      length(String.split(File.read!(Path.join(store, "rounds")), "\n", trim: true)) == 2
    end)

    assert File.read!(Path.join(store, "received")) == received
  end

  defp native_receiver(listener, transcript, ready, test_pid) do
    case :gen_tcp.accept(listener) do
      {:ok, socket} ->
        case :gen_tcp.recv(socket, 0, 10_000) do
          {:error, :closed} ->
            :ok

          {:ok, line} ->
            frame = Jason.decode!(line)
            session = ready |> File.read!() |> String.trim()
            uuid = frame["uuid"]

            rows = [
              %{type: "user", sessionId: session, uuid: uuid},
              %{
                type: "assistant",
                sessionId: session,
                uuid: "reply-" <> uuid,
                parentUuid: uuid,
                message: %{role: "assistant", model: "claude-test"}
              }
            ]

            File.write!(transcript, Enum.map(rows, &(Jason.encode!(&1) <> "\n")), [:append])
            send(test_pid, {:wake, frame["message"]["content"]})
        end

        :gen_tcp.close(socket)
        native_receiver(listener, transcript, ready, test_pid)

      {:error, :closed} ->
        :ok
    end
  end

  defp await(fun), do: await(fun, System.monotonic_time(:millisecond) + 20_000)

  defp await(fun, deadline) do
    unless fun.() do
      assert System.monotonic_time(:millisecond) < deadline,
             "timed out waiting for process evidence"

      Process.sleep(10)
      await(fun, deadline)
    end
  end

  defp pending(data) do
    Path.wildcard(Path.join(data, "mailboxes/fiber/*/pending/*.json"))
    |> Enum.map(&(&1 |> File.read!() |> Jason.decode!()))
    |> Enum.sort_by(& &1["request"]["message_id"])
  end

  describe "orchestrator roster" do
    test "a fresh owner feed replaces mirror state and excludes fibers absent at the owner" do
      root =
        thread("hub", %{"status" => "active", "shuttle" => %{"host" => "test-host"}}, "/local")

      closed_mirror =
        thread(
          "hub/closed",
          %{"status" => "active", "shuttle" => %{"host" => "nibi"}},
          "/local"
        )

      rested_mirror =
        thread(
          "hub/rested",
          %{"status" => "active", "shuttle" => %{"host" => "nibi"}},
          "/local"
        )

      closed_owner = %{
        "felt_store" => "/nibi/store",
        "path" => "hub/closed.md",
        "fiber" => %{
          "id" => "hub/closed",
          "slug" => "hub/closed",
          "uid" => "u-hub/closed",
          "name" => "Closed",
          "status" => "closed",
          "tempered" => true,
          "shuttle" => %{"host" => "nibi"}
        }
      }

      rested_owner = %{
        "felt_store" => "/nibi/store",
        "path" => "hub/rested.md",
        "fiber" => %{
          "id" => "hub/rested",
          "slug" => "hub/rested",
          "uid" => "u-hub/rested",
          "name" => "Rested",
          "status" => "open",
          "horizon" => "stashed",
          "shuttle" => %{"host" => "nibi"}
        }
      }

      entries =
        Threads.reconcile_owner_feeds(
          [root, closed_mirror, rested_mirror],
          "test-host",
          %{"u-hub/closed" => "/local", "u-hub/rested" => "/local"},
          %{"nibi" => %{fibers: [closed_owner, rested_owner], stale: false}}
        )

      assert [
               %{"id" => "hub/closed", "state" => "Archived", "stale" => false},
               %{"id" => "hub/rested", "state" => "Resting", "stale" => false}
             ] = Threads.tree("hub", "/local", entries, MapSet.new())

      absent_entries =
        Threads.reconcile_owner_feeds(
          [root, closed_mirror],
          "test-host",
          %{},
          %{"nibi" => %{fibers: [], stale: false}}
        )

      assert [] = Threads.tree("hub", "/local", absent_entries, MapSet.new())

      cold_entries =
        Threads.reconcile_owner_feeds(
          [root, closed_mirror],
          "test-host",
          %{},
          %{"nibi" => %{fibers: [], stale: false, cache: %{"state" => "cold"}}}
        )

      assert [
               %{
                 "id" => "hub/closed",
                 "state" => "Unknown",
                 "column" => "unknown",
                 "stale" => true,
                 "host_unreachable" => false,
                 "owner_cache_state" => "cold"
               }
             ] =
               Threads.tree("hub", "/local", cold_entries, MapSet.new())

      roster = Threads.roster("hub", "/local", cold_entries, MapSet.new())
      assert roster =~ "1 unknown (owner cache cold)"
      refute roster =~ "armed"

      partial_entries =
        Threads.reconcile_owner_feeds(
          [root, closed_mirror],
          "test-host",
          %{},
          %{
            "nibi" => %{
              fibers: [],
              stale: false,
              last_error: :timeout,
              cache: %{"state" => "partial"}
            }
          }
        )

      assert [%{"state" => "Unknown", "owner_cache_state" => "partial"}] =
               Threads.tree("hub", "/local", partial_entries, MapSet.new())

      stale_partial_entries =
        Threads.reconcile_owner_feeds(
          [root, closed_mirror],
          "test-host",
          %{},
          %{
            "nibi" => %{
              fibers: [],
              stale: true,
              last_error: :timeout,
              cache: %{"state" => "partial"}
            }
          }
        )

      assert [
               %{
                 "state" => "Armed",
                 "stale" => true,
                 "host_unreachable" => true
               }
             ] = Threads.tree("hub", "/local", stale_partial_entries, MapSet.new())
    end

    test "unavailable owner fallback marks every state stale and host-unreachable" do
      root =
        thread("hub", %{"status" => "active", "shuttle" => %{"host" => "test-host"}}, "/local")

      rested =
        thread(
          "hub/rested",
          %{
            "status" => "open",
            "horizon" => "stashed",
            "shuttle" => %{"host" => "nibi"}
          },
          "/local"
        )

      entries = Threads.reconcile_owner_feeds([root, rested], "test-host", %{}, %{})

      assert [
               %{
                 "id" => "hub/rested",
                 "state" => "Resting",
                 "stale" => true,
                 "host_unreachable" => true
               }
             ] = Threads.tree("hub", "/local", entries, MapSet.new(), MapSet.new(["test-host"]))
    end

    test "remote-only children inherit a known local ancestor store identity" do
      root =
        thread("hub", %{"status" => "active", "shuttle" => %{"host" => "test-host"}}, "/local")

      child = %{
        "felt_store" => "/nibi/store-with-no-shared-fiber",
        "path" => "hub/new.md",
        "fiber" => %{
          "id" => "hub/new",
          "slug" => "hub/new",
          "uid" => "u-new",
          "name" => "New",
          "status" => "active",
          "shuttle" => %{"host" => "nibi"}
        }
      }

      entries =
        Threads.reconcile_owner_feeds([root], "test-host", %{}, %{
          "nibi" => %{fibers: [child], stale: false}
        })

      assert [%{"id" => "hub/new", "state" => "Armed", "stale" => false}] =
               Threads.tree("hub", "/local", entries, MapSet.new())
    end

    test "an owner-only root stays queryable with its remote-only descendants" do
      root = %{
        "felt_store" => "/nibi/new-store",
        "path" => "new-root.md",
        "fiber" => %{
          "id" => "new-root",
          "slug" => "new-root",
          "uid" => "u-new-root",
          "name" => "New root",
          "status" => "open",
          "shuttle" => %{"host" => "nibi"}
        }
      }

      child = %{
        "felt_store" => "/nibi/new-store",
        "path" => "new-root/child.md",
        "fiber" => %{
          "id" => "new-root/child",
          "slug" => "new-root/child",
          "uid" => "u-new-child",
          "name" => "Child",
          "status" => "active",
          "shuttle" => %{"host" => "nibi"}
        }
      }

      entries =
        Threads.reconcile_owner_feeds([], "test-host", %{}, %{
          "nibi" => %{fibers: [root, child], stale: false}
        })

      assert [%{"id" => "new-root/child", "state" => "Armed"}] =
               Threads.tree("new-root", "/nibi/new-store", entries, MapSet.new())
    end

    test "an owner-only root joins a uniquely identified local child store" do
      root = %{
        "felt_store" => "/nibi/new-store",
        "path" => "new-root.md",
        "fiber" => %{
          "id" => "new-root",
          "slug" => "new-root",
          "uid" => "u-new-root",
          "name" => "New root",
          "status" => "open",
          "shuttle" => %{"host" => "nibi"}
        }
      }

      local_child =
        thread(
          "new-root/local-child",
          %{"status" => "active", "shuttle" => %{"host" => "test-host"}},
          "/local-child-store"
        )

      entries =
        Threads.reconcile_owner_feeds([local_child], "test-host", %{}, %{
          "nibi" => %{fibers: [root], stale: false}
        })

      assert [%{"id" => "new-root/local-child", "state" => "Armed"}] =
               Threads.tree("new-root", "/local-child-store", entries, MapSet.new())
    end

    test "the fleet view adds fresh remotes' workers and names the hosts it covers" do
      remote = fn name ->
        %Shuttle.Remote{
          name: name,
          url: "http://#{name}:1",
          poll_interval_ms: 1_000,
          stale_multiplier: 4
        }
      end

      now = ~U[2026-10-23 12:00:00Z]

      fleet = %{
        "candide" => %{
          remote: remote.("candide"),
          last_polled_at: DateTime.add(now, -1, :second),
          running: MapSet.new(["u-a"])
        },
        "nersc" => %{
          remote: remote.("nersc"),
          last_polled_at: DateTime.add(now, -60, :second),
          running: MapSet.new(["u-b"])
        }
      }

      assert Threads.with_fleet(MapSet.new(["u-local"]), "laptop", fleet, now) ==
               {MapSet.new(["u-local", "u-a"]), MapSet.new(["laptop", "candide"])}

      assert Threads.with_fleet(MapSet.new(["u-local"]), "laptop", nil, now) ==
               {MapSet.new(["u-local"]), nil}
    end

    defp thread(id, fiber, store \\ "/s"),
      do: %{
        felt_store: store,
        fiber: Map.merge(%{"id" => id, "uid" => "u-" <> id, "shuttle" => %{}}, fiber)
      }

    test "the classifier files every fixture case where the board does" do
      for c <-
            "../fixtures/columns/cases.json"
            |> Path.expand(__DIR__)
            |> File.read!()
            |> Jason.decode!() do
        assert {c["name"], Shuttle.Threads.column(c["fiber"], c["live"])} ==
                 {c["name"], c["column"]}

        assert {c["name"], Shuttle.Threads.thread_state(c["fiber"], c["live"])} ==
                 {c["name"], c["roster"] || c["state"]}
      end
    end

    test "the tree nests threads to every depth, archived included and passed over" do
      entries = [
        thread("hub", %{"status" => "active"}),
        thread("hub/a", %{"status" => "closed", "outcome" => "Done."}),
        thread("hub/a/b", %{"status" => "closed", "tempered" => false}),
        thread("hub/a/b/c", %{"status" => "open"}),
        thread("hub/notes", %{"status" => "active"}) |> put_in([:fiber, "shuttle"], nil),
        thread("hub/notes/z", %{"status" => "active"})
      ]

      assert [
               %{
                 "id" => "hub/a",
                 "column" => "awaiting_review",
                 "state" => "To review",
                 "outcome" => "Done.",
                 # The discarded b orchestrates nothing; its draft answers to a.
                 "threads" => [
                   %{
                     "id" => "hub/a/b",
                     "column" => "discarded",
                     "state" => "Archived",
                     "threads" => []
                   },
                   %{"id" => "hub/a/b/c", "state" => "Draft", "threads" => []}
                 ]
               },
               %{"id" => "hub/notes/z", "state" => "Armed", "host_unreachable" => false}
             ] = Shuttle.Threads.tree("hub", "/s", entries, MapSet.new())
    end

    test "a thread with no live worker counts what waits for its next worker" do
      entries = [
        thread("hub", %{"status" => "active"}),
        thread("hub/mr7", %{"status" => "open"}) |> Map.put(:pending_results, 2),
        thread("hub/live", %{"status" => "active"}) |> Map.put(:pending_results, 1),
        thread("hub/live/deep", %{"status" => "active"}),
        thread("hub/none", %{"status" => "open"})
      ]

      live = MapSet.new(["u-hub/live"])

      assert Threads.tree("hub", "/s", entries, live)
             |> Map.new(&{&1["id"], &1["pending_results"]}) ==
               %{"hub/mr7" => 2, "hub/live" => 0, "hub/none" => 0}

      roster = Threads.roster("hub", "/s", entries, live)
      assert roster == "## Threads — 1 working · 2 drafts — `shuttle threads hub`"
      refute roster =~ "hub/mr7"
      refute roster =~ "Results"
    end

    test "a hub's launch prompt lists its threads by state; a leaf gets no block" do
      entries = [
        thread("hub", %{"status" => "active"}),
        thread("hub/rest", %{"status" => "open", "horizon" => "stashed"}),
        thread("hub/draft", %{"status" => "open", "shuttle" => %{"enabled" => false}}),
        thread("hub/review", %{"status" => "closed", "outcome" => "Found it. Then more."}),
        thread("hub/live", %{"status" => "active"}),
        thread("hub/live/deep", %{"status" => "active"}),
        thread("hub/armed", %{"status" => "active", "shuttle" => %{"host" => "test-host"}}),
        thread("hub/away", %{"status" => "active", "shuttle" => %{"host" => "nersc"}}),
        thread("hub/elsewhere", %{"status" => "active", "shuttle" => %{"host" => "candide"}}),
        thread("hub/asking", %{
          "status" => "active",
          "shuttle" => %{"ask" => %{"text" => "Which model?", "at" => "t"}}
        }),
        thread("hub/done", %{"status" => "closed", "tempered" => true}),
        thread("hub/dropped", %{"status" => "closed", "tempered" => false}),
        thread("hub/other", %{"status" => "active"}, "/elsewhere"),
        thread("hub/notes", %{"status" => "active"}) |> put_in([:fiber, "shuttle"], nil)
      ]

      prompt =
        Shuttle.Dispatcher.render_prompt("hub",
          felt_store: "/s",
          threads:
            {entries, MapSet.new(["u-hub/live", "u-hub/elsewhere"]),
             MapSet.new(["test-host", "candide"])}
        )

      assert prompt =~
               "## Threads — 1 waiting · 1 to review · 2 working · 2 armed (1 on an unreachable host) · 1 draft · 1 resting · 2 archived — `shuttle threads hub`"

      assert prompt =~ "### Waiting (1)\n- asking — Which model?"
      assert prompt =~ "### To review (1)\n- review — Found it."
      refute prompt =~ "hub/asking"
      refute prompt =~ "shuttle thread hub \"<ask>\""

      refute Shuttle.Dispatcher.render_prompt("hub/rest",
               felt_store: "/nonexistent",
               runner: FailingMailboxRunner,
               threads: {entries, MapSet.new(), nil}
             ) =~ "## Threads"
    end

    test "the launch inbox caps the combined groups and reports overflow" do
      waiting =
        for n <- 1..41 do
          thread("hub/w#{n}", %{
            "status" => "active",
            "shuttle" => %{"ask" => %{"text" => "Which\nmodel?"}}
          })
        end

      reviews = for n <- 1..2, do: thread("hub/review/r#{n}", %{"status" => "closed"})
      entries = [thread("hub", %{"status" => "active"}) | waiting ++ reviews]
      roster = Threads.roster("hub", "/s", entries, MapSet.new())
      assert length(Regex.scan(~r/^- /m, roster)) == 40
      assert roster =~ "### Waiting (41)"
      assert length(Regex.scan(~r/… and 3 more/, roster)) == 1
      assert roster =~ "- w1 — Which model?"
    end

    test "the launch inbox normalizes asks and bounds relative review outcomes" do
      long = String.duplicate("λ", 180)

      entries = [
        thread("hub", %{"status" => "active"}),
        thread("hub/asking", %{
          "status" => "active",
          "shuttle" => %{"ask" => %{"text" => "Which\nmodel?"}}
        }),
        thread("hub/methodology/covariance/noise-closure", %{
          "status" => "closed",
          "outcome" => long <> ". More."
        })
      ]

      roster = Threads.roster("hub", "/s", entries, MapSet.new())
      assert roster =~ "- asking — Which model?"

      assert roster =~
               "- methodology/covariance/noise-closure — " <> String.duplicate("λ", 159) <> "…"
    end

    test "an archived-only family leaves its count line and no inbox" do
      entries = [
        thread("hub", %{"status" => "active"}),
        thread("hub/done", %{"status" => "closed", "tempered" => true}),
        thread("hub/dropped", %{"status" => "closed", "tempered" => false})
      ]

      assert Threads.roster("hub", "/s", entries, MapSet.new()) ==
               "## Threads — 2 archived — `shuttle threads hub`"
    end

    test "thread ids in the inbox are relative to the orchestrator" do
      nested =
        thread("hub/methodology/covariance/noise-closure", %{
          "status" => "closed",
          "outcome" => "Validated."
        })

      nested_roster =
        Threads.roster(
          "hub",
          "/s",
          [thread("hub", %{"status" => "active"}), nested],
          MapSet.new()
        )

      assert nested_roster =~ "- methodology/covariance/noise-closure — Validated."
    end
  end
end
