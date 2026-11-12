defmodule Shuttle.ThreadsOutboxTest do
  # The thread outbox across boots, and native receivers.
  use Shuttle.Test.ThreadsCase, async: true

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
        _ in [Jason.DecodeError, ThreadOutbox.Corrupt] -> :ok
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
    assert_raise ThreadOutbox.Corrupt, fn -> ThreadOutbox.boot_baseline() end
    assert File.read!(payload) == bytes
    assert File.read!(baseline_path) == "corrupt"
    File.rm!(baseline_path)
    assert_raise ThreadOutbox.Corrupt, fn -> ThreadOutbox.boot_baseline() end
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
    ack_stat = Map.take(File.stat!(acked_path), [:inode, :mtime, :ctime, :size])
    # Capture and ack do not decode old payloads or rewrite acknowledged history.
    corrupt_path = hd(after_paths)
    original = File.read!(corrupt_path)
    File.write!(corrupt_path, "unreadable unrelated payload")
    assert :ok = ThreadOutbox.capture([{"extra", %{"owner" => "test-host", "text" => "extra"}}])
    assert :ok = ThreadOutbox.acknowledge("extra")
    File.write!(corrupt_path, original)
    assert Map.take(File.stat!(acked_path), [:inode, :mtime, :ctime, :size]) == ack_stat

    Task.async(fn ->
      ThreadOutbox.boot_baseline()
      ThreadOutbox.capture(records)
    end)
    |> Task.await(30_000)

    assert length(ThreadOutbox.pending("test-host")) == 199
    assert Map.take(File.stat!(acked_path), [:inode, :mtime, :ctime, :size]) == ack_stat
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

    asked_by(store, "shuttle://test-host/claude/11111111-1111-4111-8111-111111111111", :hub)
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
    File.write!(gate, "offer\n", [:raw])
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
               state: "running"
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
    File.write!(gate, "offer\n", [:raw])

    await(fn ->
      length(String.split(File.read!(Path.join(store, "rounds")), "\n", trim: true)) == 2
    end)

    assert File.read!(Path.join(store, "received")) == received

    # At rest with a large context and a cold cache, the worker is not woken:
    # a fresh session replaces it and takes the result from the mailbox.
    projects = Path.join(store, "projects")
    File.mkdir_p!(Path.join(projects, "p"))
    Env.put_env("SHUTTLE_CLAUDE_PROJECTS_DIR", projects)

    File.write!(
      Path.join([projects, "p", native <> ".jsonl"]),
      Jason.encode!(%{
        type: "assistant",
        timestamp: DateTime.utc_now() |> DateTime.add(-3, :hour) |> DateTime.to_iso8601(),
        message: %{
          model: "claude-opus-5-5",
          usage: %{
            input_tokens: 0,
            cache_read_input_tokens: 412_000,
            cache_creation_input_tokens: 0
          }
        }
      }) <> "\n"
    )

    File.rm!(Path.join(tasks_dir, "1.json"))

    Env.put_app_env(:waiting_phases_source, fn ->
      %{native => %{phase: "waiting", last_event_at: System.system_time(:millisecond)}}
    end)

    assert Poller.idle_worker?(poller, "hub")
    File.rm!(Path.join(store, "ready"))
    assert {:ok, _} = CLI.run_in_store(store, ["reopen", "hub/child", "--local"])
    assert {:ok, _} = CLI.run_in_store(store, ["close", "hub/child", "--local"])
    assert {:ok, %{fibers: latest}} = FiberDocuments.list(felt_stores: [store])
    Threads.deliver_results(latest, "test-host")
    refute_receive {:wake, _}

    await(fn ->
      case Poller.live_worker(poller, "hub") do
        %{session_uuid: uuid} when is_binary(uuid) -> uuid != native
        _ -> false
      end
    end)

    assert [_] = pending(data)
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

    test "an empty fleet report marks remote armed threads unreachable, unlike no report" do
      entries = [
        thread("hub", %{"status" => "active"}),
        thread("hub/local", %{"status" => "active", "shuttle" => %{"host" => "test-host"}}),
        thread("hub/remote", %{"status" => "active", "shuttle" => %{"host" => "peer-a"}})
      ]

      local_live = MapSet.new(["u-hub"])
      assert {^local_live, nil} = Threads.with_fleet(local_live, "test-host", nil)

      assert {^local_live, reachable} = Threads.with_fleet(local_live, "test-host", %{})
      assert reachable == MapSet.new(["test-host"])

      assert [
               %{"id" => "hub/local", "state" => "Armed", "host_unreachable" => false},
               %{"id" => "hub/remote", "state" => "Armed", "host_unreachable" => true}
             ] = Threads.tree("hub", "/s", entries, local_live, reachable)

      assert [
               %{"id" => "hub/local", "host_unreachable" => false},
               %{"id" => "hub/remote", "host_unreachable" => false}
             ] = Threads.tree("hub", "/s", entries, local_live, nil)

      assert Threads.roster("hub", "/s", entries, local_live, reachable) =~
               "2 armed (1 on an unreachable host)"

      refute Threads.roster("hub", "/s", entries, local_live, nil) =~ "unreachable host"
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

    test "the roster files every fixture case by its served column and turn" do
      now = System.system_time(:millisecond)

      for c <-
            "../fixtures/columns/cases.json"
            |> Path.expand(__DIR__)
            |> File.read!()
            |> Jason.decode!() do
        runtime = c["runtime"] || if(c["live"], do: %{"state" => "running"})
        column = Shuttle.Lifecycle.column(c["fiber"], c["live"])
        turn = Shuttle.Lifecycle.turn(c["fiber"], c["live"], runtime, c["error"], now)

        assert {c["name"], column, turn} == {c["name"], c["column"], c["turn"]}

        assert {c["name"], Threads.thread_state(c["fiber"], column, turn, c["live"])} ==
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

  test "thread roster carries the owning daemon's blocked reason", %{store: store} do
    entries =
      for {id, error} <- [{"hub", nil}, {"hub/failure", "systemError: native_thread_unverified"}] do
        %{
          felt_store: store,
          fiber: %{
            "id" => id,
            "status" => "active",
            "shuttle" => %{"kind" => "oneshot", "host" => "test-host"}
          },
          dispatch_error: error
        }
      end

    assert [%{"state" => "Blocked", "dispatch_error" => reason}] =
             Threads.tree("hub", store, entries, MapSet.new())

    roster = Threads.roster("hub", store, entries, MapSet.new())
    assert roster =~ "1 blocked"
    assert roster =~ reason
  end

  test "a live thread whose session could not be attributed is blocked with its reason",
       %{store: store} do
    entry = fn id, runtime ->
      %{
        felt_store: store,
        fiber: %{
          "id" => id,
          "uid" => "u-" <> id,
          "status" => "active",
          "shuttle" => %{"kind" => "oneshot", "host" => "test-host"}
        },
        runtime: runtime
      }
    end

    for {runtime, detail} <- [
          {%{phase: "identity_failed", identity_error: "boom"}, "boom"},
          {%{state: "blocked"}, "worker blocked"}
        ] do
      entries = [entry.("hub", nil), entry.("hub/kid", runtime)]
      live = MapSet.new(["u-hub/kid"])

      assert [%{"state" => "Blocked"}] = Threads.tree("hub", store, entries, live)
      assert Threads.roster("hub", store, entries, live) =~ "- kid — #{detail}"
    end
  end
end
