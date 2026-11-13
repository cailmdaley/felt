defmodule Shuttle.ThreadsDeliveryTest do
  # Thread results: supersession, owner validation and delivery.
  use Shuttle.Test.ThreadsCase, async: true

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
      parent = Enum.find(entries, &(Threads.address(&1.fiber) == "hub"))
      StubPostClient.set_get_response({:ok, 200, Jason.encode!(%{fibers: [parent]})})
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
      StubPostClient.set_get_response({:ok, 200, Jason.encode!(%{fibers: [parent]})})
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
      assert {:ok, %{fibers: moved}} = FiberDocuments.list(felt_stores: [store])
      moved_parent = Enum.find(moved, &(&1.fiber["uid"] == uid))
      StubPostClient.set_get_response({:ok, 200, Jason.encode!(%{fibers: [moved_parent]})})
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

  test "for the orchestrator that asked, a close wakes, a quiet close supplies context, and an ask wakes, across retry and restart",
       %{store: store} do
    alias Shuttle.Test.StubPostClient
    StubPostClient.start!()
    Env.put_app_env(:write_forward_client, StubPostClient)
    Env.put_app_env(:remotes, [%{name: "parent-host", port: 43210}])
    path = Path.join(store, ".felt/hub/hub.md")
    File.write!(path, String.replace(File.read!(path), "host: test-host", "host: parent-host"))

    asked_by(store, "shuttle://parent-host/claude/11111111-1111-4111-8111-111111111111", :hub)

    for {verb, args, expected_wake} <- [
          {"close", ["--quiet", "--local"], false},
          {"ask", ["Needs a decision"], true},
          {"close", ["--local"], true}
        ] do
      assert {:ok, _} = CLI.run_in_store(store, ["reopen", "hub/child", "--local"])
      StubPostClient.set_response({:error, :unavailable})
      assert {:ok, _} = CLI.run_in_store(store, [verb, "hub/child" | args])
      assert {:ok, %{fibers: entries}} = FiberDocuments.list(felt_stores: [store])
      parent = Enum.find(entries, &(Threads.address(&1.fiber) == "hub"))
      StubPostClient.set_get_response({:ok, 200, Jason.encode!(%{fibers: [parent]})})
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
    assert [{^id, pending_record}] = Shuttle.ThreadOutbox.pending("test-host")
    assert pending_record["parent_uid"] == record["parent_uid"]
    assert pending_record["text"] == record["text"]
    refute Map.has_key?(pending_record, "parent_unresolved")
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

    assert [
             %{
               "request" => %{
                 "text" =>
                   "thread hub/child/deep closed:  (the verdict is yours: temper, discard, or shuttle close hub/child/deep --review \"<why>\")"
               }
             }
           ] = pending(data)

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
    archived_uid = Enum.find(entries, &(Threads.address(&1.fiber) == "hub/child")).fiber["uid"]

    # Reviewed closes publish quiet verdict context; the live descendant still reports.
    assert [
             %{
               "parent_uid" => ^hub_uid,
               "text" => "thread hub/child closed (tempered):  (human verdict: tempered)"
             },
             %{
               "parent_uid" => ^archived_uid,
               "anchor_uid" => ^archived_uid,
               "parent_unresolved" => true,
               "text" =>
                 "thread hub/child/deep closed:  (the verdict is yours: temper, discard, or shuttle close hub/child/deep --review \"<why>\")"
             }
           ] =
             Shuttle.ThreadOutbox.pending("test-host")
             |> Enum.map(&elem(&1, 1))
             |> Enum.sort_by(& &1["text"])

    Threads.deliver_results(entries, "test-host")

    assert "thread hub/child/deep closed:  (the verdict is yours: temper, discard, or shuttle close hub/child/deep --review \"<why>\")" in Enum.map(
             pending(data),
             & &1["request"]["text"]
           )

    assert Shuttle.ThreadOutbox.pending("test-host") == []
  end
end
