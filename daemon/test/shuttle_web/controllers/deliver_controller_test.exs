defmodule ShuttleWeb.DeliverControllerTest do
  use ExUnit.Case, async: true

  import Phoenix.ConnTest
  import Shuttle.Test.ApiConn
  import Shuttle.Test.ForwardStub
  import Shuttle.Test.PollerHelpers
  import Shuttle.Test.TranscriptHelpers

  alias Shuttle.Poller
  alias Shuttle.Test.FeltStoreRunner, as: MockRunner
  alias Shuttle.Test.{Env, StubPostClient}

  @endpoint ShuttleWeb.Endpoint

  # Answers `shuttle message` with the scripted receipt (accepted unless
  # `:deliver_test_receipt` names a status, detail and exit code) and records
  # the frame; every other command is the store mock's.
  defmodule MessageRunner do
    @behaviour Shuttle.Runner

    def cmd("shuttle", ["message", "--local", "--json", "--request-json"], opts) do
      request = opts[:input] |> String.trim() |> Jason.decode!()
      send(Shuttle.Env.app(:deliver_test_pid), {:message, request})

      {status, detail, exit_code} =
        Shuttle.Env.app(:deliver_test_receipt, {"accepted", nil, 0})

      {Jason.encode!(%{
         message_id: request["message_id"],
         address: request["address"],
         status: status,
         transport: "claude-native",
         detail: detail
       }), exit_code}
    end

    def cmd("tmux", ["load-buffer", "-b", _buffer, path] = args, opts) do
      send(Shuttle.Env.app(:deliver_test_pid), {:paste, File.read!(path)})
      MockRunner.cmd("tmux", args, opts)
    end

    def cmd(command, args, opts), do: MockRunner.cmd(command, args, opts)
  end

  setup do
    MockRunner.start!()
    MockRunner.reset()
    root = MockRunner.felt_root()
    on_exit(fn -> File.rm_rf(root) end)

    {:ok, poller} =
      start_poller!(runner: MockRunner, poll_interval_ms: 600_000, felt_stores: [root])

    await_boot_cycle!(poller)
    :ok
  end

  defp run_script do
    {_, args} =
      MockRunner.commands()
      |> Enum.reverse()
      |> Enum.find(fn {cmd, args} -> cmd == "tmux" and hd(args) == "new-session" end)

    File.read!(List.last(args))
  end

  defp put_constitution(fiber_id) do
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id))
    MockRunner.set_shuttle(fiber_id, oneshot_shuttle())
  end

  test "a never-run constitution dispatches fresh with the text as From User" do
    put_constitution("tests/deliver-fresh")

    body =
      api_conn()
      |> post(
        "/api/v1/deliver",
        Jason.encode!(%{"fiber_id" => "tests/deliver-fresh", "text" => "Meeting mode (call)."})
      )
      |> json_response(200)

    assert %{"delivered" => true, "delivery" => "dispatch", "dispatched" => true} = body
    script = run_script()
    assert script =~ "From User"
    assert script =~ "Meeting mode (call)."
  end

  test "a transcript wakes a dormant worker then uses the same deduplicated native message as a live delivery" do
    fiber = "tests/transcript-first"
    put_constitution(fiber)
    Env.put_app_env(:felt_runner, MessageRunner)
    Env.put_app_env(:deliver_test_pid, self())

    request = %{
      "fiber_id" => fiber,
      "text" => "spoken words that must arrive once",
      "message_id" => "transcript-stable-id",
      "message_after_launch" => true
    }

    assert %{"delivered" => true, "delivery" => "message"} =
             api_conn() |> post("/api/v1/deliver", Jason.encode!(request)) |> json_response(200)

    refute run_script() =~ request["text"]
    assert_receive {:message, first}
    assert first["text"] == request["text"]
    assert first["message_id"] == "transcript-stable-id"

    assert %{"delivered" => true, "delivery" => "message"} =
             api_conn() |> post("/api/v1/deliver", Jason.encode!(request)) |> json_response(200)

    assert_receive {:message, retry}
    assert retry["message_id"] == first["message_id"]
    assert retry["address"] == first["address"]

    assert Enum.count(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and match?(["new-session" | _], args)
           end) == 1
  end

  test "voice to a dormant worker launches and still uses native messaging" do
    fiber = "tests/voice-dormant"
    put_constitution(fiber)
    Env.put_app_env(:felt_runner, MessageRunner)
    Env.put_app_env(:deliver_test_pid, self())

    request = %{
      "fiber_id" => fiber,
      "text" => "me: Claude hello",
      "message_id" => "voice-first",
      "message_after_launch" => true,
      "live_input" => true
    }

    assert %{"delivered" => true, "delivery" => "message"} =
             api_conn() |> post("/api/v1/deliver", Jason.encode!(request)) |> json_response(200)

    assert_receive {:message, %{"text" => "me: Claude hello", "message_id" => "voice-first"}}
    refute run_script() =~ "me: Claude hello"
  end

  test "voice delivery starts a never-run card with the same plain text as a composer send" do
    fiber = "tests/voice-fresh"
    put_constitution(fiber)

    assert {200, %{delivered: true, delivery: "dispatch"}} =
             Shuttle.Meeting.TranscriptRelay.Worker.deliver(%{
               fiber_id: fiber,
               origin: nil,
               kind: "voice",
               message_id: "voice-send",
               text: "me: spoken words\n"
             })

    assert run_script() =~ "me: spoken words"
  end

  test "voice delivery resumes a dormant prior conversation even after a handoff" do
    fiber = "tests/voice-previous"
    session = "de11ae00-0000-4000-8000-000000000099"

    put_previous_run(fiber, session, %{"handed_off_at" => DateTime.to_iso8601(DateTime.utc_now())})

    write_transcript(session, 30)

    Env.put_app_env(:voice_target_entries, fn -> [] end)

    assert {200, %{delivered: true, delivery: "resume"}} =
             Shuttle.Meeting.TranscriptRelay.Worker.deliver(%{
               fiber_id: fiber,
               origin: nil,
               kind: "voice",
               message_id: "voice-send",
               text: "me: spoken words\n"
             })

    script = run_script()
    assert script =~ "--resume '#{session}'"
    assert script =~ "me: spoken words"
  end

  test "finalized voice traverses the relay, cold drop, dormant resume and live messaging" do
    alias Shuttle.Meeting.TranscriptRelay
    dormant = "tests/voice-pipeline-dormant"
    live = "tests/voice-pipeline-live"
    session = "de11ae00-0000-4000-8000-000000000098"

    put_previous_run(dormant, session, %{
      "handed_off_at" => DateTime.to_iso8601(DateTime.utc_now())
    })

    write_transcript(session, 30)
    put_constitution(live)
    assert %{"delivery" => "dispatch"} = deliver(live, "prepare receiver")
    assert is_map(Poller.live_worker(live))
    Env.put_app_env(:felt_runner, MessageRunner)
    Env.put_app_env(:deliver_test_pid, self())
    :sys.replace_state(Env.server!(Poller), fn state -> %{state | runner: MessageRunner} end)
    root = Path.join(MockRunner.felt_root(), "voice-probe")
    File.mkdir_p!(root)
    transcript = Path.join(root, "voice.txt")
    routes = Path.join(root, "routes.jsonl")
    File.write!(transcript, "")

    write_route = fn at, target ->
      File.write!(routes, Jason.encode!(%{"t" => at, "fiber_id" => target}) <> "\n", [:append])
    end

    record = fn at, text ->
      File.write!(
        Path.rootname(transcript) <> ".jsonl",
        Jason.encode!(%{"wall" => at, "speaker" => "S1", "text" => text}) <> "\n",
        [:append]
      )
    end

    write_route.("2026-11-06T10:00:00Z", dormant)
    relay = Module.concat(__MODULE__, "VoiceProbe#{System.unique_integer([:positive])}")
    Env.put_server(TranscriptRelay, relay)

    start_supervised!(
      {TranscriptRelay,
       [
         name: relay,
         directory: Path.join(root, "relay"),
         poll_ms: 60_000,
         cold: fn target -> target["fiber_id"] == dormant end,
         thresholds: fn _ -> %{"words" => 1, "quiet_seconds" => 1} end,
         observe: fn -> {:ok, %{meeting: %{launch: "pipeline", state: "live", error: nil}}} end
       ]}
    )

    assert :ok =
             TranscriptRelay.start(
               %{
                 launch: "pipeline",
                 kind: "voice",
                 transcript: transcript,
                 routes_path: routes,
                 started_at: "2026-11-06T10:00:00Z"
               },
               nil,
               nil,
               server: relay
             )

    relay_state = :sys.get_state(Module.concat(relay, Coordinator))
    {worker, _} = relay_state.workers["pipeline"]

    poll = fn ->
      send(worker, :poll)
      GenServer.call(worker, :status)
    end

    record.("2026-11-06T10:00:01Z", "aside not sent")
    poll.()
    refute_receive {:message, _}, 20
    record.("2026-11-06T10:00:02Z", "raw correction needed send")
    poll.()
    # The owning dispatcher, not the recorder cache, selects the dormant conversation.
    task_refs =
      :sys.get_state(worker).task_handles |> Map.values() |> Enum.map(&Process.monitor(&1.pid))

    for ref <- task_refs, do: assert_receive({:DOWN, ^ref, :process, _, _}, 30_000)
    GenServer.call(worker, :status)
    script = run_script()
    assert script =~ "--resume '#{session}'"
    assert script =~ "S1: raw correction needed"
    refute script =~ "aside not sent"
    write_route.("2026-11-06T10:00:03Z", live)
    record.("2026-11-06T10:00:04Z", "ordinary live words")
    poll.()
    assert_receive {:paste, "S1: ordinary live words\n"}, 30_000
    refute_receive {:paste, _}, 20
    refute_receive {:message, _}, 20

    assert Enum.count(MockRunner.commands(), fn {command, args} ->
             command == "tmux" and match?(["new-session" | _], args)
           end) == 2
  end

  # A previous run of `fiber_id` under `session`, dispatched a minute ago
  # unless `extra` says otherwise, with `extra` runtime fields (a handoff, say).
  defp put_previous_run(fiber_id, session, extra \\ %{}) do
    put_constitution(fiber_id)

    MockRunner.put_shuttle_fields(
      fiber_id,
      Map.merge(
        %{
          "session_uuid" => session,
          "dispatched_at" => DateTime.to_iso8601(DateTime.add(DateTime.utc_now(), -60))
        },
        extra
      )
    )

    Poller.refresh_document(fiber_id)
  end

  defp deliver(fiber_id, text) do
    api_conn()
    |> post("/api/v1/deliver", Jason.encode!(%{"fiber_id" => fiber_id, "text" => text}))
    |> json_response(200)
  end

  test "a conversation cut off moments ago is resumed with the text" do
    session = "de11ae00-0000-4000-8000-000000000001"
    put_previous_run("tests/deliver-resume", session)
    write_transcript(session, 30)

    assert %{"delivered" => true, "delivery" => "resume"} =
             deliver("tests/deliver-resume", "join the meeting")

    script = run_script()
    assert script =~ "--resume '#{session}'"
    assert script =~ "join the meeting"
  end

  test "a conversation cut off long ago resumes carrying the message" do
    session = "de11ae00-0000-4000-8000-000000000002"
    # Dispatched three hours ago; its transcript last written two hours ago.
    put_previous_run("tests/deliver-cold", session, %{
      "dispatched_at" => DateTime.to_iso8601(DateTime.add(DateTime.utc_now(), -3 * 3600))
    })

    write_transcript(session, 2 * 3600)

    assert %{"delivered" => true, "delivery" => "resume"} =
             deliver("tests/deliver-cold", "join the meeting")

    script = run_script()
    assert script =~ "--resume '#{session}'"
    assert script =~ "join the meeting"
  end

  test "after a clean handoff a message launches fresh carrying it" do
    session = "de11ae00-0000-4000-8000-000000000003"

    put_previous_run("tests/deliver-handed-off", session, %{
      "handed_off_at" => DateTime.to_iso8601(DateTime.utc_now())
    })

    write_transcript(session, 30)

    assert %{"delivered" => true, "delivery" => "dispatch"} =
             deliver("tests/deliver-handed-off", "join the meeting")

    script = run_script()
    refute script =~ "--resume"
    refute script =~ "ended without a handoff"
    assert script =~ "From User"
    assert script =~ "join the meeting"
  end

  test "a live worker is messaged at its conversation instead of relaunched" do
    fiber_id = "tests/deliver-live"
    session_uuid = message_live_worker(fiber_id)

    launches_before =
      Enum.count(MockRunner.commands(), fn {cmd, args} ->
        cmd == "tmux" and hd(args) == "new-session"
      end)

    body =
      api_conn()
      |> post(
        "/api/v1/deliver",
        Jason.encode!(%{
          "fiber_id" => fiber_id,
          "text" => "Meeting mode (call).",
          "from" => "shuttle meeting"
        })
      )
      |> json_response(200)

    assert %{"delivered" => true, "delivery" => "message", "receipt" => receipt} = body
    assert receipt["status"] == "accepted"

    assert_received {:message, request}
    assert request["address"] == "shuttle://#{Poller.own_host_id()}/claude/#{session_uuid}"
    assert request["text"] == "Meeting mode (call)."
    assert request["from"] == "shuttle meeting"
    assert request["wake"] == true

    assert launches_before ==
             Enum.count(MockRunner.commands(), fn {cmd, args} ->
               cmd == "tmux" and hd(args) == "new-session"
             end)
  end

  test "resume_mode fresh starts a new session over a live worker" do
    fiber_id = "tests/deliver-fresh-live"
    session_uuid = message_live_worker(fiber_id)

    assert %{"delivered" => true, "delivery" => "dispatch"} =
             api_conn()
             |> post(
               "/api/v1/deliver",
               Jason.encode!(%{
                 "fiber_id" => fiber_id,
                 "text" => "join the meeting",
                 "resume_mode" => "fresh"
               })
             )
             |> json_response(200)

    refute_received {:message, _request}
    script = run_script()
    refute script =~ "--resume"
    assert script =~ "join the meeting"
    refute Poller.live_worker(fiber_id).session_uuid == session_uuid
  end

  test "resume_mode previous still messages a live worker" do
    fiber_id = "tests/deliver-previous-live"
    message_live_worker(fiber_id)

    assert %{"delivered" => true, "delivery" => "message"} =
             api_conn()
             |> post(
               "/api/v1/deliver",
               Jason.encode!(%{
                 "fiber_id" => fiber_id,
                 "text" => "join the meeting",
                 "resume_mode" => "previous"
               })
             )
             |> json_response(200)

    assert_received {:message, %{"text" => "join the meeting"}}
  end

  defp message_live_worker(fiber_id) do
    put_constitution(fiber_id)
    assert {:ok, _session} = Poller.dispatch_fiber(fiber_id, [])
    Env.put_app_env(:felt_runner, MessageRunner)
    Env.put_app_env(:deliver_test_pid, self())
    assert %{session_uuid: uuid, cli: "claude"} = Poller.live_worker(fiber_id)
    assert is_binary(uuid)
    uuid
  end

  test "a sent message whose receipt is unconfirmed is neither delivered nor failed" do
    message_live_worker("tests/deliver-unconfirmed")

    detail =
      "native message queued behind the receiver's current turn; no model response to it observed yet"

    Env.put_app_env(:deliver_test_receipt, {"unknown", detail, 1})

    body =
      api_conn()
      |> post(
        "/api/v1/deliver",
        Jason.encode!(%{"fiber_id" => "tests/deliver-unconfirmed", "text" => "Meeting mode."})
      )
      |> json_response(202)

    assert %{"delivered" => nil, "delivery" => "message", "detail" => ^detail} = body
    assert body["receipt"]["status"] == "unknown"
    refute Map.has_key?(body, "error")
  end

  test "a refused message is not delivered" do
    message_live_worker("tests/deliver-refused")

    Env.put_app_env(
      :deliver_test_receipt,
      {"rejected", "receiver native inbox denied this message; no turn started", 1}
    )

    body =
      api_conn()
      |> post(
        "/api/v1/deliver",
        Jason.encode!(%{"fiber_id" => "tests/deliver-refused", "text" => "Meeting mode."})
      )
      |> json_response(502)

    assert %{"delivered" => false, "error" => "receiver native inbox denied" <> _} = body
  end

  test "an owner's unconfirmed receipt is relayed as unconfirmed, whatever status it answered" do
    receipt = %{
      "message_id" => "deliver-x",
      "address" => "shuttle://cineca/claude/abc",
      "status" => "unknown",
      "transport" => "claude-native",
      "detail" => "native message sent; no correlated receiver turn observed"
    }

    stub_forward(
      "cineca",
      "http://localhost:4002",
      {:ok, 400,
       Jason.encode!(%{
         "delivered" => false,
         "delivery" => "message",
         "fiber_id" => "tests/remote",
         "receipt" => receipt,
         "error" => receipt["detail"]
       })},
      StubPostClient
    )

    body =
      api_conn()
      |> post(
        "/api/v1/deliver",
        Jason.encode!(%{"fiber_id" => "tests/remote", "text" => "hello", "origin" => "cineca"})
      )
      |> json_response(202)

    assert %{"delivered" => nil, "receipt" => ^receipt, "fiber_id" => "tests/remote"} = body
    assert body["detail"] == receipt["detail"]
    refute Map.has_key?(body, "error")
  end

  test "an owner that does not answer in time leaves the delivery unconfirmed" do
    stub_forward("cineca", "http://localhost:4002", {:error, :timeout}, StubPostClient)

    body =
      api_conn()
      |> post(
        "/api/v1/deliver",
        Jason.encode!(%{"fiber_id" => "tests/remote", "text" => "hello", "origin" => "cineca"})
      )
      |> json_response(202)

    assert %{"delivered" => nil, "reason" => "forward_timeout", "origin" => "cineca"} = body
  end

  test "a remote-owned constitution is delivered by its owner" do
    signal = %{
      "uid" => "child-uid",
      "verb" => "closed",
      "stamp" => "stamp",
      "owner" => "test-host"
    }

    stub_forward(
      "cineca",
      "http://localhost:4002",
      {:ok, 200, Jason.encode!(%{"delivered" => true, "delivery" => "message"})},
      StubPostClient
    )

    body =
      api_conn()
      |> post(
        "/api/v1/deliver",
        Jason.encode!(%{
          "fiber_id" => "tests/remote",
          "text" => "hello",
          "origin" => "cineca",
          "context_only" => true,
          "wake" => false,
          "message_id" => "thread-forwarded",
          "thread_signal" => signal
        })
      )
      |> json_response(200)

    assert body == %{"delivered" => true, "delivery" => "message"}
    last = StubPostClient.last()
    assert last.url == "http://localhost:4002/api/v1/deliver"

    assert Jason.decode!(last.body) == %{
             "fiber_id" => "tests/remote",
             "text" => "hello",
             "context_only" => true,
             "wake" => false,
             "message_id" => "thread-forwarded",
             "thread_signal" => signal,
             "from" => "shuttle"
           }

    api_conn()
    |> post(
      "/api/v1/deliver",
      Jason.encode!(%{
        "fiber_id" => "tests/remote",
        "text" => "hello",
        "origin" => "cineca",
        "from" => "unverified",
        "from_claim" => "shuttle://sender/codex/thread",
        "sender_proof" => "old"
      })
    )
    |> json_response(200)

    forwarded = StubPostClient.last().body |> Jason.decode!()
    assert forwarded["from"] == "shuttle://sender/codex/thread"
    refute Map.has_key?(forwarded, "from_claim")
    refute Map.has_key?(forwarded, "sender_proof")
  end

  # `shuttle message <fiber>`'s request: context unless a worker is live. The
  # context path reads the fiber from the configured stores.
  defp queue_for_next_worker(fiber_id, id, extra \\ %{}) do
    Env.put_env("SHUTTLE_STORES", MockRunner.felt_root())

    api_conn()
    |> post(
      "/api/v1/deliver",
      Jason.encode!(
        Map.merge(
          %{
            "fiber_id" => fiber_id,
            "text" => "read this when you start",
            "from" => "shuttle://elsewhere/claude/sender",
            "context_only" => true,
            "unless_live" => true,
            "wake" => true,
            "message_id" => id
          },
          extra
        )
      )
    )
  end

  defp mailbox_puts,
    do:
      for(
        {"shuttle", ["context-mailbox", "put" | _] = args} <- MockRunner.commands(),
        do: args
      )

  defp launches,
    do: Enum.count(MockRunner.commands(), &match?({"tmux", ["new-session" | _]}, &1))

  test "a message to a fiber with no live worker waits in its mailbox for the next worker" do
    put_constitution("tests/deliver-dormant")
    Env.put_app_env(:felt_runner, MockRunner)
    before = launches()

    body = "tests/deliver-dormant" |> queue_for_next_worker("msg-dormant-1") |> json_response(202)

    assert %{
             "delivery" => "context",
             "queued" => true,
             "delivered" => false,
             "status" => "queued_for_next_worker"
           } = body

    assert [args] = mailbox_puts()
    assert "msg-dormant-1" in args and "read this when you start" in args
    assert ["--from", "shuttle://elsewhere/claude/sender"] -- args == []
    assert launches() == before

    # The same message id queues once.
    assert %{"queued" => true} =
             "tests/deliver-dormant"
             |> queue_for_next_worker("msg-dormant-1")
             |> json_response(202)
  end

  test "dormant context preserves the thread signal bound into sender evidence" do
    put_constitution("tests/deliver-signal")
    Env.put_app_env(:felt_runner, MockRunner)

    signal = %{
      "uid" => "child-uid",
      "verb" => "closed",
      "stamp" => "event-stamp",
      "owner" => "test-host"
    }

    "tests/deliver-signal"
    |> queue_for_next_worker("msg-signal", %{"thread_signal" => signal})
    |> json_response(202)

    assert [args] = mailbox_puts()
    index = Enum.find_index(args, &(&1 == "--thread-signal"))
    assert is_integer(index)
    assert args |> Enum.at(index + 1) |> Jason.decode!() == signal
  end

  test "the owner feed counts what waits for a dormant fiber's next worker" do
    # An unarmed constitution: the poll leaves it without a worker.
    MockRunner.set_fiber(
      "tests/deliver-waiting",
      make_fiber("tests/deliver-waiting", %{"status" => "open"})
    )

    MockRunner.set_shuttle("tests/deliver-waiting", oneshot_shuttle(), "open")
    Env.put_app_env(:felt_runner, MockRunner)

    for id <- ["msg-waiting-1", "msg-waiting-2"] do
      assert %{"queued" => true} =
               "tests/deliver-waiting" |> queue_for_next_worker(id) |> json_response(202)
    end

    Poller.refresh_document("tests/deliver-waiting")
    poller = GenServer.whereis(Shuttle.Env.server(Poller))
    send(poller, :run_poll_cycle)
    assert waiting(poller, "tests/deliver-waiting", 2) == 2
  end

  defp waiting(poller, fiber_id, want, attempts \\ 500) do
    {:ok, %{fibers: rows}} = Poller.cached_fiber_documents(poller)
    row = Enum.find(rows, &(&1.fiber["slug"] == fiber_id or &1.fiber["id"] == fiber_id))
    got = row && Map.get(row, :pending_results)

    if got == want or attempts == 0 do
      got
    else
      Process.sleep(20)
      waiting(poller, fiber_id, want, attempts - 1)
    end
  end

  test "a message to a fiber with a live worker is the sender's to deliver, not queued" do
    message_live_worker("tests/deliver-live-queue")

    body =
      "tests/deliver-live-queue" |> queue_for_next_worker("msg-live-1") |> json_response(409)

    assert %{"live" => true, "queued" => false} = body
    assert mailbox_puts() == []
    refute_received {:message, _}
  end

  test "fiber_id and text are required" do
    assert %{"error" => "text is required"} =
             api_conn()
             |> post("/api/v1/deliver", Jason.encode!(%{"fiber_id" => "tests/x"}))
             |> json_response(400)

    assert %{"error" => "fiber_id is required"} =
             api_conn()
             |> post("/api/v1/deliver", Jason.encode!(%{"text" => "x"}))
             |> json_response(400)
  end
end
