defmodule Shuttle.ThreadsTest do
  # Thread results: who a close, ask or rest reaches, and the roster.
  use Shuttle.Test.ThreadsCase, async: true

  test "a thread nobody asked for publishes its close and its ask as context that wakes no one",
       %{store: store} do
    for {verb, args} <- [{"ask", ["Needs a decision"]}, {"close", ["--local"]}] do
      assert {:ok, _} = CLI.run_in_store(store, [verb, "hub/child" | args])
      assert {:ok, %{fibers: entries}} = FiberDocuments.list(felt_stores: [store])
      Threads.capture_results(entries, "test-host")
    end

    assert [_, _] = pending = Shuttle.ThreadOutbox.pending("test-host")
    assert Enum.all?(pending, fn {_, record} -> record["wake"] == false end)
    refute Enum.any?(pending, fn {_, record} -> record["session"] end)
  end

  test "a session that asked from outside the orchestrator is told itself; the orchestrator gets context",
       %{store: store} do
    session = "shuttle://test-host/claude/11111111-1111-4111-8111-111111111111"
    asked_by(store, session, nil)
    assert {:ok, _} = CLI.run_in_store(store, ["close", "hub/child", "--local"])
    assert {:ok, %{fibers: entries}} = FiberDocuments.list(felt_stores: [store])
    Threads.capture_results(entries, "test-host")
    Threads.capture_results(entries, "test-host")

    assert [{id, to_hub}, {asker_id, to_asker}] =
             Enum.sort_by(Shuttle.ThreadOutbox.pending("test-host"), &elem(&1, 0))

    assert to_hub["wake"] == false
    assert asker_id == id <> "-asker"
    assert %{"session" => ^session, "text" => "thread hub/child closed: "} = to_asker
    refute Map.has_key?(to_asker, "parent_uid")

    # No such session is live: the refusal is final, and the hub keeps the result.
    Threads.retry_results("test-host", entries)
    refute Enum.any?(Shuttle.ThreadOutbox.pending("test-host"), &(elem(&1, 0) == asker_id))
  end

  test "created owner-only thread keeps lineage and retries close and ask to parent authority", %{
    store: store
  } do
    alias Shuttle.Test.StubPostClient
    StubPostClient.start!()
    Env.put_app_env(:write_forward_client, StubPostClient)
    Env.put_app_env(:remotes, [%{name: "parent-host", port: 43210}])
    parent_path = Path.join(store, ".felt/hub/hub.md")

    File.write!(
      parent_path,
      String.replace(File.read!(parent_path), "host: test-host", "host: parent-host")
    )

    assert {:ok, %{fibers: entries}} = FiberDocuments.list(felt_stores: [store])
    parent = Enum.find(entries, &(Threads.address(&1.fiber) == "hub"))
    uid = parent.fiber["uid"]
    File.rm!(parent_path)
    StubPostClient.set_get_response({:ok, 200, Jason.encode!(%{fibers: [parent]})})

    conn =
      api_conn()
      |> post(
        "/api/v1/fiber/create",
        Jason.encode!(%{
          id: "hub/owner-only",
          name: "Owner-only work",
          frontmatter: %{
            status: "active",
            shuttle: %{
              enabled: true,
              kind: "oneshot",
              host: "test-host",
              project_dir: store,
              thread_parent: %{
                uid: uid,
                host: "parent-host",
                slug: "hub",
                name: "Hub"
              }
            }
          }
        })
      )

    assert conn.status == 200

    assert Shuttle.Dispatcher.render_prompt("hub/owner-only", felt_store: store) =~
             "You are a thread of hub (Hub)."

    assert {:ok, %{fibers: entries}} = FiberDocuments.list(felt_stores: [store])
    child = Enum.find(entries, &(Threads.address(&1.fiber) == "hub/owner-only"))
    assert Threads.orchestrator(child, entries).fiber["uid"] == uid

    for {verb, extra} <- [{"close", ["--local"]}, {"ask", ["Which estimator?"]}] do
      assert {:ok, _} = CLI.run_in_store(store, ["reopen", "hub/owner-only", "--local"])
      assert {:ok, _} = CLI.run_in_store(store, [verb, "hub/owner-only"] ++ extra)
      assert {:ok, %{fibers: latest}} = FiberDocuments.list(felt_stores: [store])
      Threads.capture_results(latest, "test-host")
      assert [{id, record}] = Shuttle.ThreadOutbox.pending("test-host")
      assert record["parent_uid"] == uid
      assert record["parent_unresolved"] == true
      assert record["anchor_uid"] == uid
      StubPostClient.set_get_response({:error, :unavailable})
      Threads.retry_results("test-host")
      assert [{^id, ^record}] = Shuttle.ThreadOutbox.pending("test-host")
      StubPostClient.set_get_response({:ok, 200, Jason.encode!(%{fibers: [parent]})})
      StubPostClient.set_response({:ok, 202, ~s({"queued":true,"delivery":"context"})})
      Task.async(fn -> Threads.retry_results("test-host") end) |> Task.await(30_000)
      assert %{body: body} = StubPostClient.last()
      assert Jason.decode!(body)["fiber_id"] == uid
      assert Shuttle.ThreadOutbox.pending("test-host") == []
    end

    refute File.exists?(parent_path)
  end

  test "an unresolved result skips an archived remote parent and persists the live ancestor", %{
    store: store
  } do
    alias Shuttle.Test.StubPostClient
    StubPostClient.start!()
    Env.put_app_env(:write_forward_client, StubPostClient)

    Env.put_app_env(:remotes, [
      %{name: "parent-host", port: 43210},
      %{name: "root-host", port: 43211}
    ])

    remotes = Path.join(store, "remotes.json")

    File.write!(
      remotes,
      Jason.encode!(%{
        defaults: %{discover: false},
        remotes: [
          %{name: "parent-host", url: "http://127.0.0.1:43210"},
          %{name: "root-host", url: "http://127.0.0.1:43211"}
        ]
      })
    )

    Env.put_env("SHUTTLE_REMOTES_FILE", remotes)

    parent_uid = "01JARZ3NDEKTSV4RRFFQ69G5FA"
    root_uid = "01JARZ3NDEKTSV4RRFFQ69G5FB"

    archived_parent = %{
      "uid" => parent_uid,
      "id" => parent_uid,
      "slug" => "hub/parent",
      "name" => "Parent",
      "status" => "closed",
      "tempered" => true,
      "shuttle" => %{
        "host" => "parent-host",
        "thread_parent" => %{
          "uid" => root_uid,
          "host" => "root-host",
          "slug" => "hub",
          "name" => "Hub"
        }
      }
    }

    root = %{
      "uid" => root_uid,
      "id" => root_uid,
      "slug" => "hub",
      "name" => "Hub",
      "status" => "active",
      "shuttle" => %{"host" => "root-host"}
    }

    StubPostClient.set_get_responses([
      {:ok, 200,
       Jason.encode!(%{
         fibers: [%{fiber: archived_parent, felt_store: store, path: "hub/parent.md"}]
       })},
      {:ok, 200,
       Jason.encode!(%{fibers: [%{fiber: root, felt_store: store, path: "hub/hub.md"}]})}
    ])

    StubPostClient.set_response({:error, :unavailable})

    record = %{
      "owner" => "test-host",
      "store" => store,
      "parent_uid" => parent_uid,
      "anchor_uid" => parent_uid,
      "parent_host" => "parent-host",
      "parent_slug" => "hub/parent",
      "parent_unresolved" => true,
      "retained_at" => DateTime.to_iso8601(DateTime.utc_now()),
      "text" => "thread hub/parent/child closed: result",
      "wake" => false
    }

    assert :ok = Shuttle.ThreadOutbox.capture([{"unblocked-archive", record}])
    assert :ok = Threads.retry_results("test-host")
    assert [{"unblocked-archive", resolved}] = Shuttle.ThreadOutbox.pending("test-host")
    assert resolved["parent_uid"] == root_uid
    assert resolved["resolved_from_uid"] == parent_uid
    refute Map.has_key?(resolved, "parent_unresolved")
    assert StubPostClient.last().url =~ "127.0.0.1:43211/api/v1/deliver"
    assert Jason.decode!(StubPostClient.last().body)["fiber_id"] == root_uid
  end

  test "an archived direct parent stays the durable anchor ahead of a live path ancestor", %{
    store: store
  } do
    assert {:ok, _} = CLI.run_felt(["-C", store, "add", "upper", "Upper"])

    assert {:ok, _} =
             CLI.run_in_store(store, [
               "install",
               "upper",
               "--disabled",
               "--host",
               "test-host",
               "--project-dir",
               store
             ])

    assert {:ok, _} = CLI.run_felt(["-C", store, "nest", "hub", "upper"])

    assert {:ok, _} =
             CLI.run_in_store(store, ["close", "upper/hub", "--tempered=true", "--local"])

    assert {:ok, _} = CLI.run_in_store(store, ["close", "upper/hub/child", "--local"])
    assert {:ok, %{fibers: entries}} = FiberDocuments.list(felt_stores: [store])
    direct_parent = Enum.find(entries, &(Threads.address(&1.fiber) == "upper/hub"))
    Threads.capture_results(entries, "test-host")

    record =
      Enum.find_value(Shuttle.ThreadOutbox.pending("test-host"), fn {_, candidate} ->
        if candidate["text"] =~ "thread upper/hub/child closed", do: candidate
      end)

    assert record
    assert record["anchor_uid"] == direct_parent.fiber["uid"]
    assert record["parent_uid"] == direct_parent.fiber["uid"]
    assert record["parent_unresolved"] == true

    assert Shuttle.Dispatcher.render_prompt("upper/hub/child", felt_store: store) =~
             "You are a thread of upper (Upper)."
  end

  test "a fresh owner feed overrides a stale local parent mirror", %{store: store} do
    alias Shuttle.Test.StubPostClient
    StubPostClient.start!()
    Env.put_app_env(:write_forward_client, StubPostClient)

    Env.put_app_env(:remotes, [
      %{name: "parent-host", port: 43210},
      %{name: "new-host", port: 43211}
    ])

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
    assert {:ok, %{fibers: local}} = FiberDocuments.list(felt_stores: [store])
    hub = Enum.find(local, &(Threads.address(&1.fiber) == "hub"))
    uid = hub.fiber["uid"]
    parent_path = Path.join(store, ".felt/hub/hub.md")

    File.write!(
      parent_path,
      String.replace(File.read!(parent_path), "host: test-host", "host: parent-host")
    )

    assert {:ok, _} = CLI.run_in_store(store, ["close", "hub/child", "--local"])

    assert {:ok, %{fibers: latest}} = FiberDocuments.list(felt_stores: [store])
    Threads.capture_results(latest, "test-host")
    assert [{id, record}] = Shuttle.ThreadOutbox.pending("test-host")
    assert record["anchor_uid"] == uid
    assert record["parent_unresolved"] == true

    fresh =
      Map.merge(hub, %{
        fiber: put_in(hub.fiber, ["shuttle", "host"], "new-host"),
        stale: false,
        owner_feed: true
      })

    StubPostClient.set_response({:ok, 202, ~s({"queued":true,"delivery":"context"})})

    StubPostClient.set_get_response({:ok, 200, Jason.encode!(%{fibers: [fresh]})})

    assert :ok = Threads.retry_results("test-host", [fresh])
    assert %{url: get_url} = StubPostClient.last_get()
    assert get_url =~ "127.0.0.1:43211/api/v1/fibers/"
    assert StubPostClient.last().url =~ "127.0.0.1:43211/api/v1/deliver"
    assert Jason.decode!(StubPostClient.last().body)["fiber_id"] == uid
    assert Shuttle.ThreadOutbox.pending("test-host") == []

    refute Enum.any?(Shuttle.ThreadOutbox.pending("test-host"), fn {pending_id, _} ->
             pending_id == id
           end)
  end

  for verdict <- [true, false] do
    @tag verdict: verdict
    test "a reviewed close supplies quiet context naming verdict #{verdict}", %{
      store: store,
      verdict: verdict
    } do
      assert {:ok, _} = CLI.run_in_store(store, ["close", "hub/child", "--local"])
      assert {:ok, %{fibers: entries}} = FiberDocuments.list(felt_stores: [store])
      Threads.capture_results(entries, "test-host")
      [{id, record}] = Shuttle.ThreadOutbox.pending("test-host")

      assert {:ok, _} =
               CLI.run_in_store(store, ["close", "hub/child", "--tempered=#{verdict}", "--local"])

      assert {:ok, false} =
               Threads.signal_current(
                 %{"signal" => record["signal"], "message_id" => id, "text" => record["text"]},
                 felt_stores: [store]
               )

      assert {:ok, %{fibers: latest}} = FiberDocuments.list(felt_stores: [store])
      Threads.capture_results(latest, "test-host")

      reviewed =
        Enum.find_value(Shuttle.ThreadOutbox.pending("test-host"), fn {_, r} ->
          if r["text"] =~ "human verdict", do: r
        end)

      assert reviewed["wake"] == false

      assert reviewed["text"] =~
               if(verdict, do: "human verdict: tempered", else: "human verdict: discarded")

      assert reviewed["signal"]["verb"] =~ "closed ("
      Threads.deliver_results(latest, "test-host")
      assert Shuttle.ThreadOutbox.pending("test-host") == []
    end
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
      assert {:ok, %{fibers: entries}} = FiberDocuments.list(felt_stores: [store])
      parent = Enum.find(entries, &(Threads.address(&1.fiber) == "hub"))
      StubPostClient.set_get_response({:ok, 200, Jason.encode!(%{fibers: [parent]})})
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
end
