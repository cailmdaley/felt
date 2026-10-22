defmodule Shuttle.ThreadsTest do
  use ExUnit.Case, async: true
  alias Shuttle.{CLI, FiberDocuments, Threads, Test.Env}
  @moduletag :tmp_dir

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

  setup %{tmp_dir: dir} = context do
    home = Path.join(dir, "home")
    data = Path.join(dir, "data")
    File.mkdir_p!(home)
    File.mkdir_p!(data)
    Env.delete_env("TMUX")
    Env.delete_env("SHUTTLE_FIBER_PATH")
    Env.put_env("HOME", home)
    Env.put_env("SHUTTLE_DATA_DIR", data)
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

  test "failed close and ask publications survive cleared stamps and publisher restart", %{
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
      original = StubPostClient.last().body |> Jason.decode!()
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
      assert %{body: body} = StubPostClient.last()
      assert Jason.decode!(body) == original
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
      assert {:ok, _} = CLI.run_in_store(store, ["ask", "hub/child", "--clear"])
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
      StubPostClient.set_response({:error, :unavailable})
      assert {:ok, _} = CLI.run_in_store(store, [verb, "hub/child" | args])
      assert {:ok, %{fibers: entries}} = FiberDocuments.list(felt_stores: [store])
      Threads.deliver_results(entries, "test-host")
      assert [{id, record}] = Shuttle.ThreadOutbox.pending("test-host")
      assert record["wake"] == expected_wake
      original = StubPostClient.last().body |> Jason.decode!()
      assert original["wake"] == expected_wake
      assert {:ok, _} = CLI.run_in_store(store, ["reopen", "hub/child", "--as-draft", "--local"])
      assert {:ok, _} = CLI.run_in_store(store, ["ask", "hub/child", "--clear"])
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

    # The tempered child's own close and its thread's both go to the hub.
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
          "shuttle" => %{"ask" => %{"text" => "?", "at" => "t"}}
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

      assert prompt =~ "## Threads"

      rows =
        for [path, state] <-
              Regex.scan(~r/^- (\S+) — ([^—]+) —/m, prompt, capture: :all_but_first),
            do: {path, String.trim(state)}

      assert rows == [
               {"hub/asking", "Waiting"},
               {"hub/elsewhere", "Working"},
               {"hub/live", "Working"},
               {"hub/armed", "Armed"},
               {"hub/away", "Armed · host unreachable"},
               {"hub/review", "To review"},
               {"hub/draft", "Draft"},
               {"hub/rest", "Resting"}
             ]

      assert prompt =~ "- hub/live — Working — (no outcome yet)\n  (1 thread)"
      assert prompt =~ "— To review — Found it.\n"
      assert prompt =~ "(2 archived)"
      assert prompt =~ ~s(`shuttle thread hub "<ask>"`)

      refute Shuttle.Dispatcher.render_prompt("hub/rest",
               felt_store: "/nonexistent",
               runner: FailingMailboxRunner,
               threads: {entries, MapSet.new(), nil}
             ) =~ "## Threads"
    end
  end
end
