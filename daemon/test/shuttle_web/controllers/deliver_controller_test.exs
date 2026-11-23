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

  # Answers `shuttle message` with an accepted receipt and records the frame;
  # records each pasted buffer; every other command is the store mock's.
  defmodule MessageRunner do
    @behaviour Shuttle.Runner

    def cmd("shuttle", ["message", "--local", "--json", "--request-json"], opts) do
      request = opts[:input] |> String.trim() |> Jason.decode!()
      send(Shuttle.Env.app(:deliver_test_pid), {:message, request})

      {Jason.encode!(%{
         message_id: request["message_id"],
         address: request["address"],
         status: "accepted",
         transport: "claude-native"
       }), 0}
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
    Env.put_env("SHUTTLE_STORES", root)
    Env.put_app_env(:felt_runner, MockRunner)
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

  defp fresh_request(fiber, id, text \\ "start over") do
    api_conn()
    |> post(
      "/api/v1/deliver",
      Jason.encode!(%{
        "fiber_id" => fiber,
        "text" => text,
        "from" => "shuttle://elsewhere/claude/sender",
        "message_id" => id,
        "resume_mode" => "fresh"
      })
    )
  end

  defp inbox_key(fiber) do
    {:ok, %{fibers: [entry | _]}} = Shuttle.FiberDocuments.get_shuttle(fiber)
    Shuttle.Delivery.context_key(entry)
  end

  defp inbox_ids(fiber) do
    {:ok, output} = Shuttle.CLI.run(["inbox", "ls", inbox_key(fiber), "--json"])
    output |> Jason.decode!() |> Enum.map(& &1["id"])
  end

  test "an agent fresh request replaces a live worker with its text in the launch prompt, once per id" do
    fiber = "tests/agent-fresh-once"
    uuid = message_live_worker(fiber)
    before = launches()

    assert %{"delivery" => "fresh", "delivered" => true} =
             fiber |> fresh_request("fresh-once", "fresh publication") |> json_response(200)

    assert launches() == before + 1
    refute Poller.live_worker(fiber).session_uuid == uuid
    assert run_script() =~ "From shuttle://elsewhere/claude/sender:\nfresh publication"
    refute run_script() =~ "From User"
    refute "fresh-once" in inbox_ids(fiber)

    # A repeated id answers the stored outcome and never cuts twice.
    assert %{"delivered" => true, "duplicate" => true} =
             fiber |> fresh_request("fresh-once", "fresh publication") |> json_response(200)

    assert launches() == before + 1
  end

  test "a fresh request refused under quarantine is never swept into the old worker and is accepted under its id after release" do
    fiber = "tests/agent-fresh-refused"
    uuid = message_live_worker(fiber)
    server = Shuttle.Env.server(Poller)
    :sys.replace_state(server, &%{&1 | boot_quarantine: true})
    before = launches()

    assert %{"delivered" => false, "reason" => ":held", "error" => error} =
             fiber |> fresh_request("fresh-held") |> json_response(409)

    assert error =~ "quarantine" and error =~ "same message id"
    assert launches() == before
    assert Poller.live_worker(fiber).session_uuid == uuid

    # A waking message after the refusal reaches the old worker without the
    # fresh text: the request is a record, never an inbox entry.
    fiber |> queue_for_fiber("after-refusal") |> json_response(202)
    refute "fresh-held" in inbox_ids(fiber)
    refute_received {:message, %{"text" => "start over" <> _}}

    for {"shuttle", ["context-mailbox", "put" | _] = args} <- MockRunner.commands(),
        do: refute("start over" in args)

    Poller.release_boot_quarantine(server)

    assert %{"delivered" => true} = fiber |> fresh_request("fresh-held") |> json_response(200)
    assert launches() == before + 1
    refute Poller.live_worker(fiber).session_uuid == uuid
  end

  test "a dormant agent fresh request refused under quarantine starts once after release under the same id" do
    fiber = "tests/agent-fresh-quarantine"
    put_constitution(fiber)
    server = Shuttle.Env.server(Poller)
    :sys.replace_state(server, &%{&1 | boot_quarantine: true})
    before = launches()

    assert %{"delivered" => false, "error" => error} =
             fiber |> fresh_request("fresh-dormant", "fresh after release") |> json_response(409)

    assert error =~ "quarantine"
    assert launches() == before
    # The release may start the armed fiber on its own; the fresh request
    # then replaces that worker.
    Poller.release_boot_quarantine(server)

    assert %{"delivered" => true} =
             fiber |> fresh_request("fresh-dormant", "fresh after release") |> json_response(200)

    assert run_script() =~ "fresh after release"
    started = launches()

    assert %{"duplicate" => true} =
             fiber |> fresh_request("fresh-dormant", "fresh after release") |> json_response(200)

    assert launches() == started
  end

  test "an agent fresh request does not reopen a closed fiber" do
    fiber = "tests/agent-fresh-closed"
    put_constitution(fiber)
    MockRunner.set_fiber(fiber, Map.put(make_fiber(fiber), "status", "closed"))
    MockRunner.set_shuttle(fiber, oneshot_shuttle(), "closed")
    before = launches()

    assert %{"delivered" => false, "error" => error} =
             fiber |> fresh_request("closed-fresh", "wait") |> json_response(409)

    assert error =~ "closed"
    assert launches() == before
  end

  test "a plain agent delivery is an inbox entry, not a launch directive" do
    fiber = "tests/plain-agent"
    put_constitution(fiber)

    body =
      api_conn()
      |> post(
        "/api/v1/deliver",
        Jason.encode!(%{
          "fiber_id" => fiber,
          "text" => "agent publication",
          "message_id" => "plain-agent"
        })
      )
      |> json_response(202)

    assert %{"delivery" => "context", "queued" => true, "status" => "starting"} = body
    refute run_script() =~ "agent publication"
    assert [_] = mailbox_puts()
  end

  test "a human line is recorded and launches through quarantine once per id" do
    fiber = "tests/human-once"
    put_constitution(fiber)
    :sys.replace_state(Shuttle.Env.server(Poller), &%{&1 | boot_quarantine: true})

    request = %{
      "fiber_id" => fiber,
      "text" => "human instruction",
      "from" => "human",
      "message_id" => "human-once"
    }

    assert %{"delivered" => true, "delivery" => "input"} =
             api_conn() |> post("/api/v1/deliver", Jason.encode!(request)) |> json_response(200)

    assert run_script() =~ "human instruction"

    assert %{"duplicate" => true} =
             api_conn() |> post("/api/v1/deliver", Jason.encode!(request)) |> json_response(200)

    assert Enum.count(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and match?(["new-session" | _], args)
           end) == 1
  end

  test "a human line pastes only once and keeps the typed transport" do
    fiber = "tests/human-paste-once"
    put_constitution(fiber)
    {:ok, _} = Poller.dispatch_fiber(fiber, force: true)
    Env.put_app_env(:felt_runner, MessageRunner)
    Env.put_app_env(:deliver_test_pid, self())

    request = %{
      "fiber_id" => fiber,
      "text" => "typed line",
      "from" => "human",
      "message_id" => "human-paste-once"
    }

    assert %{"delivered" => true} =
             api_conn() |> post("/api/v1/deliver", Jason.encode!(request)) |> json_response(200)

    pastes = fn ->
      Enum.count(MockRunner.commands(), fn {cmd, args} ->
        cmd == "tmux" and match?(["load-buffer" | _], args)
      end)
    end

    assert pastes.() == 1

    assert %{"duplicate" => true, "disposition" => "delivered", "delivered" => true} =
             api_conn() |> post("/api/v1/deliver", Jason.encode!(request)) |> json_response(200)

    assert pastes.() == 1
  end

  test "a line recorded by a daemon that died before typing it is never reported delivered on retry" do
    fiber = "tests/human-crash"
    put_constitution(fiber)
    {:ok, _} = Poller.dispatch_fiber(fiber, force: true)
    Env.put_app_env(:felt_runner, MessageRunner)

    # The record a daemon leaves when it dies between recording and typing.
    {:ok, _} =
      Shuttle.CLI.run(["inbox", "record-begin", "--", inbox_key(fiber), "human-crash"],
        input: "lost line",
        input_eof: true
      )

    pastes = fn ->
      Enum.count(MockRunner.commands(), &match?({"tmux", ["load-buffer" | _]}, &1))
    end

    before = pastes.()

    # The Channels retry.
    assert %{"duplicate" => true, "disposition" => "unknown", "delivered" => nil} =
             api_conn()
             |> post(
               "/api/v1/deliver",
               Jason.encode!(%{
                 "fiber_id" => fiber,
                 "text" => "lost line",
                 "from" => "human",
                 "message_id" => "human-crash"
               })
             )
             |> json_response(200)

    # The Dock retry.
    assert %{"duplicate" => true, "disposition" => "unknown", "dispatched" => false} =
             api_conn()
             |> post(
               "/api/v1/dispatch",
               Jason.encode!(%{
                 "fiber_id" => fiber,
                 "user_message" => "lost line",
                 "resume_mode" => "previous",
                 "message_id" => "human-crash"
               })
             )
             |> json_response(200)

    assert pastes.() == before
  end

  test "a human line and a Dock line beginning with a dash are pasted as typed" do
    fiber = "tests/human-dash"
    put_constitution(fiber)
    {:ok, _} = Poller.dispatch_fiber(fiber, force: true)

    pastes = fn ->
      Enum.count(MockRunner.commands(), &match?({"tmux", ["load-buffer" | _]}, &1))
    end

    assert %{"delivered" => true} =
             api_conn()
             |> post(
               "/api/v1/deliver",
               Jason.encode!(%{
                 "fiber_id" => fiber,
                 "text" => "- keep the mask\n- drop the cut",
                 "from" => "human",
                 "message_id" => "human-dash"
               })
             )
             |> json_response(200)

    assert pastes.() == 1

    api_conn()
    |> post(
      "/api/v1/dispatch",
      Jason.encode!(%{
        "fiber_id" => fiber,
        "user_message" => "-v is broken, rerun it",
        "resume_mode" => "previous",
        "force" => true,
        "message_id" => "human-dock-dash"
      })
    )
    |> json_response(200)

    assert pastes.() == 2
  end

  test "an agent message beginning with a dash reaches the fiber inbox" do
    fiber = "tests/agent-dash"
    put_constitution(fiber)

    assert %{"queued" => true} =
             api_conn()
             |> post(
               "/api/v1/deliver",
               Jason.encode!(%{
                 "fiber_id" => fiber,
                 "text" => "- keep the mask",
                 "from" => "shuttle://elsewhere/claude/sender",
                 "message_id" => "agent-dash"
               })
             )
             |> json_response(202)

    assert [args] = mailbox_puts()
    assert Enum.take(args, -4) == ["--", Enum.at(args, -3), "agent-dash", "- keep the mask"]
  end

  test "a human line typed into a live worker leaves its question to the prompt hook" do
    fiber = "tests/human-answers"
    put_constitution(fiber)
    {:ok, _} = Poller.dispatch_fiber(fiber, force: true)
    clears = fn -> Enum.count(MockRunner.commands(), fn {_, args} -> "--clear" in args end) end
    before = clears.()

    assert %{"delivered" => true} =
             api_conn()
             |> post(
               "/api/v1/deliver",
               Jason.encode!(%{
                 "fiber_id" => fiber,
                 "text" => "Keep it.",
                 "from" => "human",
                 "message_id" => "human-answers"
               })
             )
             |> json_response(200)

    # The hook clears it as one "answered" row (Q — A); a clear here first
    # would leave the hook a plain human row beside a bare "cleared" one.
    assert clears.() == before
  end

  test "a human line writes its one board row with its record, and a launch's ask clear writes none" do
    begins = fn id ->
      for {"shuttle", ["inbox", "record-begin" | _] = args} <- MockRunner.commands(),
          id in args,
          do: args
    end

    no_board_clears = fn ->
      Enum.count(MockRunner.commands(), fn {_, args} ->
        "--clear" in args and "--no-board" in args
      end)
    end

    # Pasted into a live worker: the row is written with the record, keyed by
    # its id; the worker's prompt hook rewrites it under the same id.
    live = "tests/human-row-live"
    put_constitution(live)
    {:ok, _} = Poller.dispatch_fiber(live, force: true)
    {:ok, %{fibers: [entry | _]}} = Shuttle.FiberDocuments.get_shuttle(live)

    line = %{
      "fiber_id" => live,
      "text" => "a line",
      "from" => "human",
      "message_id" => "row-live"
    }

    api_conn() |> post("/api/v1/deliver", Jason.encode!(line)) |> json_response(200)
    api_conn() |> post("/api/v1/deliver", Jason.encode!(line)) |> json_response(200)
    assert [[_, _, _, _, "--fiber", uid | _]] = Enum.uniq(begins.("row-live"))
    assert uid == entry.fiber["uid"]

    # Launched with an outstanding question: the row is that question's answer,
    # so the launch clears the question without a row of its own.
    dormant = "tests/human-row-launch"
    MockRunner.set_fiber(dormant, make_fiber(dormant))

    MockRunner.set_shuttle(
      dormant,
      oneshot_shuttle() <> "ask:\n  text: Which?\n  at: \"2026-11-15T10:00:00Z\"\n"
    )

    before = no_board_clears.()

    api_conn()
    |> post(
      "/api/v1/deliver",
      Jason.encode!(%{line | "fiber_id" => dormant, "message_id" => "row-launch"})
    )
    |> json_response(200)

    assert [args] = begins.("row-launch")
    assert ["--ask", "Which?"] -- args == []
    assert no_board_clears.() == before + 1
  end

  # Regression: a worker's `shuttle dispatch --message` was recorded and typed
  # in as the human's line, so the board counted it as the human's turn and it
  # cleared the question the fiber had put to the human.
  test "an agent's dispatch directive is its message, not the human's line" do
    begins = fn id ->
      for {"shuttle", ["inbox", "record-begin" | _] = args} <- MockRunner.commands(),
          id in args,
          do: args
    end

    clears = fn ->
      for {"shuttle", args} <- MockRunner.commands(), "--clear" in args, do: args
    end

    fiber = "tests/agent-directive"
    MockRunner.set_fiber(fiber, make_fiber(fiber))

    MockRunner.set_shuttle(
      fiber,
      oneshot_shuttle() <> "ask:\n  text: Which?\n  at: \"2026-11-15T10:00:00Z\"\n"
    )

    {:ok, _} = Poller.dispatch_fiber(fiber, force: true)
    Env.put_app_env(:felt_runner, MessageRunner)
    Env.put_app_env(:deliver_test_pid, self())
    :sys.replace_state(Env.server!(Poller), fn state -> %{state | runner: MessageRunner} end)

    directive = fn extra ->
      api_conn()
      |> post(
        "/api/v1/dispatch",
        Jason.encode!(
          Map.merge(
            %{"fiber_id" => fiber, "resume_mode" => "continue", "force" => true},
            extra
          )
        )
      )
      |> json_response(200)
    end

    sender = "shuttle://elsewhere/claude/mill"
    before = length(clears.())

    directive.(%{
      "user_message" => "From the Mill: rerun the journeys",
      "message_id" => "agent-directive",
      "from" => sender,
      "reply_to" => "felt/mill"
    })

    assert_receive {:paste, text}, 30_000
    assert text == "[from felt/mill]\nFrom the Mill: rerun the journeys"
    assert [args] = begins.("agent-directive")
    assert ["--from", sender] -- args == []
    refute "--fiber" in args
    # The agent answers only a question addressed to it: the CLI decides.
    assert [clear] = Enum.drop(clears.(), before)
    assert ["--answered-by", sender] -- clear == []

    before = length(clears.())

    directive.(%{"user_message" => "keep going", "message_id" => "human-directive"})

    assert_receive {:paste, "keep going"}, 30_000
    assert [args] = begins.("human-directive")
    assert ["--from", "human"] -- args == []
    assert "--fiber" in args
    # The human's typed line answers through the worker's prompt hook.
    assert Enum.drop(clears.(), before) == []
  end

  test "a human line over the inbox limit is pasted" do
    fiber = "tests/human-long"
    put_constitution(fiber)
    {:ok, _} = Poller.dispatch_fiber(fiber, force: true)

    assert %{"delivered" => true} =
             api_conn()
             |> post(
               "/api/v1/deliver",
               Jason.encode!(%{
                 "fiber_id" => fiber,
                 "text" => String.duplicate("log line\n", 8_000),
                 "from" => "human",
                 "message_id" => "human-long"
               })
             )
             |> json_response(200)

    assert Enum.count(MockRunner.commands(), &match?({"tmux", ["load-buffer" | _]}, &1)) == 1
  end

  test "a fiber message carries a 7 MB attachment" do
    fiber = "tests/attach-7mb"
    put_constitution(fiber)
    data = :binary.copy("a", 7 * 1024 * 1024)

    assert %{"queued" => true} =
             api_conn()
             |> post(
               "/api/v1/deliver",
               Jason.encode!(%{
                 "fiber_id" => fiber,
                 "text" => "see attached",
                 "from" => "shuttle://elsewhere/claude/sender",
                 "message_id" => "attach-7mb",
                 "context_only" => true,
                 "turn" => "ask",
                 "attachments" => [
                   %{
                     "name" => "data.bin",
                     "data" => Base.encode64(data),
                     "sha256" => :crypto.hash(:sha256, data) |> Base.encode16(case: :lower)
                   }
                 ]
               })
             )
             |> json_response(202)
  end

  test "a never-run constitution dispatches fresh with the text as From User" do
    put_constitution("tests/deliver-fresh")

    body =
      api_conn()
      |> post(
        "/api/v1/deliver",
        Jason.encode!(%{
          "fiber_id" => "tests/deliver-fresh",
          "text" => "Meeting mode (call).",
          "from" => "human"
        })
      )
      |> json_response(200)

    assert %{"delivered" => true, "delivery" => "input"} = body
    script = run_script()
    assert script =~ "From User"
    assert script =~ "Meeting mode (call)."
  end

  test "voice records, deduplicates and writes one board row" do
    fiber = "tests/voice-dormant"
    events = Path.join(MockRunner.felt_root(), "voice-events.jsonl")
    Env.put_env("SHUTTLE_EVENTS_FILE", events)
    put_constitution(fiber)
    Env.put_app_env(:felt_runner, MessageRunner)
    Env.put_app_env(:deliver_test_pid, self())

    request = %{
      "fiber_id" => fiber,
      "text" => "me: Claude hello",
      "message_id" => "voice-first",
      "live_input" => true
    }

    assert %{"delivered" => true, "delivery" => "input"} =
             api_conn() |> post("/api/v1/deliver", Jason.encode!(request)) |> json_response(200)

    assert %{"duplicate" => true, "disposition" => "delivered"} =
             api_conn() |> post("/api/v1/deliver", Jason.encode!(request)) |> json_response(200)

    assert run_script() =~ "From User:\nme: Claude hello"
    refute_received {:message, _}

    records =
      Path.wildcard(Path.join(Shuttle.data_dir(), "mailboxes/fiber/*/offered/*.json"))
      |> Enum.map(&(File.read!(&1) |> Jason.decode!()))

    assert [%{"disposition" => "delivered", "wishes" => %{"source" => "voice"}}] = records

    rows =
      events |> File.read!() |> String.split("\n", trim: true) |> Enum.map(&Jason.decode!/1)

    assert [%{"id" => "brd-voice-first", "kind" => "human"}] =
             Enum.filter(rows, &(&1["type"] == "board"))
  end

  test "voice records bypass quarantine and survive an owner restart without another paste" do
    fiber = "tests/voice-once"
    put_constitution(fiber)
    :sys.replace_state(Shuttle.Env.server(Poller), &%{&1 | boot_quarantine: true})
    batch = %{fiber_id: fiber, origin: nil, message_id: "voice-once", text: "spoken command"}
    assert {200, %{delivered: true}} = Shuttle.Voice.TranscriptRelay.Worker.deliver(batch)
    assert run_script() =~ "From User:\nspoken command"

    # The owner dies after recording the next line, before it can paste it.
    assert {:ok, _} =
             Shuttle.CLI.run(
               [
                 "inbox",
                 "record-begin",
                 "--source",
                 "voice",
                 "--",
                 inbox_key(fiber),
                 "voice-interrupted"
               ],
               input: "interrupted command",
               input_eof: true
             )

    GenServer.stop(Shuttle.Env.server(Poller))

    {:ok, poller} =
      start_poller!(
        runner: MockRunner,
        poll_interval_ms: 600_000,
        felt_stores: [MockRunner.felt_root()]
      )

    await_boot_cycle!(poller)
    before = MockRunner.commands()

    assert {200, %{duplicate: true, disposition: "delivered"}} =
             Shuttle.Voice.TranscriptRelay.Worker.deliver(batch)

    assert {200, %{duplicate: true, disposition: "unknown", delivered: nil}} =
             Shuttle.Voice.TranscriptRelay.Worker.deliver(%{
               batch
               | message_id: "voice-interrupted",
                 text: "interrupted command"
             })

    assert Enum.count(MockRunner.commands() -- before, fn {cmd, args} ->
             cmd == "tmux" and match?(["load-buffer" | _], args)
           end) == 0
  end

  test "a relay forwards a voice batch to its owner in the live_input envelope" do
    stub_forward(
      "voice-owner",
      "http://localhost:4002",
      {:ok, 200, Jason.encode!(%{delivered: true, delivery: "input"})},
      StubPostClient
    )

    batch = %{
      fiber_id: "frozen-fiber",
      origin: "voice-owner",
      message_id: "voice-mixed",
      text: "words"
    }

    assert {200, _} = Shuttle.Voice.TranscriptRelay.Worker.deliver(batch)

    assert Jason.decode!(StubPostClient.last().body) == %{
             "fiber_id" => "frozen-fiber",
             "text" => "words",
             "from" => "shuttle",
             "message_id" => "voice-mixed",
             "live_input" => true
           }
  end

  test "voice delivery starts a never-run card with the same plain text as a composer send" do
    fiber = "tests/voice-fresh"
    put_constitution(fiber)

    assert {200, %{delivered: true, delivery: "input"}} =
             Shuttle.Voice.TranscriptRelay.Worker.deliver(%{
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

    assert {200, %{delivered: true, delivery: "input"}} =
             Shuttle.Voice.TranscriptRelay.Worker.deliver(%{
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
    alias Shuttle.Voice.TranscriptRelay
    dormant = "tests/voice-pipeline-dormant"
    live = "tests/voice-pipeline-live"
    session = "de11ae00-0000-4000-8000-000000000098"

    put_previous_run(dormant, session, %{
      "handed_off_at" => DateTime.to_iso8601(DateTime.utc_now())
    })

    write_transcript(session, 30)
    put_constitution(live)
    assert %{"delivery" => "input"} = deliver(live, "prepare receiver")
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
    {:ok, following} = Agent.start_link(fn -> true end)
    Env.put_server(TranscriptRelay, relay)

    start_supervised!(
      {TranscriptRelay,
       [
         name: relay,
         directory: Path.join(root, "relay"),
         poll_ms: 60_000,
         cold: fn target -> target["fiber_id"] == dormant end,
         thresholds: fn -> %{"words" => 1, "quiet_seconds" => 1} end,
         follow: fn -> Agent.get(following, & &1) end,
         observe: fn -> {:ok, %{capture: %{launch: "pipeline", state: "live", error: nil}}} end
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
    record.("2026-11-06T10:00:02Z", "raw correction needed, send")
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
    assert_receive {:paste, text}, 30_000
    assert text == "S1: ordinary live words\n"
    refute_receive {:paste, _}, 20
    refute_receive {:message, _}, 20

    assert Enum.count(MockRunner.commands(), fn {command, args} ->
             command == "tmux" and match?(["new-session" | _], args)
           end) == 2

    pinned = "tests/voice-pinned-cold"
    put_constitution(pinned)
    Agent.update(following, fn _ -> false end)
    write_route.("2026-11-06T10:00:05Z", pinned)
    record.("2026-11-06T10:00:06Z", "start this cold card without a trigger")
    poll.()

    for task <- Map.values(:sys.get_state(worker).task_handles) do
      ref = Process.monitor(task.pid)
      assert_receive {:DOWN, ^ref, :process, _, _}, 30_000
    end

    GenServer.call(worker, :status)
    assert is_map(Poller.live_worker(pinned))
    assert run_script() =~ "S1: start this cold card without a trigger"
    refute run_script() =~ "shuttle transcript --since"
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
    |> post(
      "/api/v1/deliver",
      Jason.encode!(%{"fiber_id" => fiber_id, "text" => text, "from" => "human"})
    )
    |> json_response(200)
  end

  test "a conversation cut off moments ago is resumed with the text" do
    session = "de11ae00-0000-4000-8000-000000000001"
    put_previous_run("tests/deliver-resume", session)
    write_transcript(session, 30)

    assert %{"delivered" => true, "delivery" => "input"} =
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

    assert %{"delivered" => true, "delivery" => "input"} =
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

    assert %{"delivered" => true, "delivery" => "input"} =
             deliver("tests/deliver-handed-off", "join the meeting")

    script = run_script()
    refute script =~ "--resume"
    refute script =~ "ended without a handoff"
    assert script =~ "From User"
    assert script =~ "join the meeting"
  end

  # The board console's plain send: `/dispatch` with `resume_mode: continue`
  # lets the worker's state choose, as a human line through `/deliver` does.
  defp console_send(fiber_id, text, id) do
    api_conn()
    |> post(
      "/api/v1/dispatch",
      Jason.encode!(%{
        "fiber_id" => fiber_id,
        "force" => true,
        "ad_hoc" => true,
        "resume_mode" => "continue",
        "user_message" => text,
        "message_id" => id
      })
    )
  end

  test "a console send after a clean handoff starts fresh carrying the line" do
    session = "de11ae00-0000-4000-8000-000000000004"

    put_previous_run("tests/console-handed-off", session, %{
      "handed_off_at" => DateTime.to_iso8601(DateTime.utc_now())
    })

    write_transcript(session, 30)

    assert %{"dispatched" => true} =
             console_send("tests/console-handed-off", "join the meeting", "human-c1")
             |> json_response(200)

    script = run_script()
    refute script =~ "--resume"
    assert script =~ "join the meeting"
  end

  test "a console send resumes a standing constitution's session cut off moments ago" do
    fiber_id = "tests/console-standing"
    session = "de11ae00-0000-4000-8000-000000000005"
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id))
    MockRunner.set_shuttle(fiber_id, "enabled: true\nkind: standing\nschedule: \"0 9 * * *\"\n")

    MockRunner.put_shuttle_fields(fiber_id, %{
      "session_uuid" => session,
      "dispatched_at" => DateTime.to_iso8601(DateTime.add(DateTime.utc_now(), -60))
    })

    Poller.refresh_document(fiber_id)
    write_transcript(session, 30)

    assert %{"dispatched" => true} =
             console_send(fiber_id, "pick it up", "human-c3") |> json_response(200)

    assert run_script() =~ "--resume '#{session}'"
  end

  test "a console send to a live worker types the line and cuts nothing" do
    fiber_id = "tests/console-live"
    put_constitution(fiber_id)
    assert {:ok, session} = Poller.dispatch_fiber(fiber_id, force: true)

    count = fn verb ->
      Enum.count(MockRunner.commands(), fn {cmd, args} -> cmd == "tmux" and hd(args) == verb end)
    end

    launches = count.("new-session")

    assert %{"tmux_session" => ^session} =
             console_send(fiber_id, "one more thing", "human-c2") |> json_response(200)

    assert count.("load-buffer") == 1
    assert count.("new-session") == launches
    assert Poller.live_worker(fiber_id).session == session
  end

  test "resume_mode fresh starts a new session over a live worker" do
    fiber_id = "tests/deliver-fresh-live"
    session_uuid = message_live_worker(fiber_id)

    assert %{"delivered" => true, "delivery" => "input"} =
             api_conn()
             |> post(
               "/api/v1/deliver",
               Jason.encode!(%{
                 "fiber_id" => fiber_id,
                 "text" => "join the meeting",
                 "resume_mode" => "fresh",
                 "from" => "human"
               })
             )
             |> json_response(200)

    refute_received {:message, _request}
    script = run_script()
    refute script =~ "--resume"
    assert script =~ "join the meeting"
    refute Poller.live_worker(fiber_id).session_uuid == session_uuid
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
        "from" => "shuttle://sender/codex/thread",
        "sender_proof" => "old"
      })
    )
    |> json_response(200)

    forwarded = StubPostClient.last().body |> Jason.decode!()
    assert forwarded["from"] == "shuttle://sender/codex/thread"
    refute Map.has_key?(forwarded, "sender_proof")
  end

  # `shuttle message <fiber>`'s request. The context path reads the fiber from
  # the configured stores.
  defp queue_for_fiber(fiber_id, id, extra \\ %{}) do
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

  # Inbox writes and consumption cross the real CLI boundary; execution is
  # the store fixture's terminal, so a waking entry can reserve one launch.
  test "a waking message to a fiber with no live worker starts it through the inbox" do
    put_constitution("tests/deliver-dormant")
    Env.put_app_env(:felt_runner, MockRunner)
    before = launches()

    body = "tests/deliver-dormant" |> queue_for_fiber("msg-dormant-1") |> json_response(202)

    assert %{
             "delivery" => "context",
             "queued" => true,
             "delivered" => false,
             "status" => "starting"
           } = body

    assert [args] = mailbox_puts()
    assert "msg-dormant-1" in args and "read this when you start" in args
    assert ["--from", "shuttle://elsewhere/claude/sender"] -- args == []
    assert ["--turn", "ask"] -- args == []
    assert launches() == before + 1

    # The same message id queues once.
    assert %{"queued" => true} =
             "tests/deliver-dormant"
             |> queue_for_fiber("msg-dormant-1")
             |> json_response(202)

    assert launches() == before + 1
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
    |> queue_for_fiber("msg-signal", %{"thread_signal" => signal})
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
               "tests/deliver-waiting" |> queue_for_fiber(id) |> json_response(202)
    end

    Poller.refresh_document("tests/deliver-waiting")
    poller = GenServer.whereis(Shuttle.Env.server(Poller))
    send(poller, :run_poll_cycle)
    assert waiting(poller, "tests/deliver-waiting", 2) == 2
  end

  defp waiting(poller, fiber_id, want, attempts \\ 1_500) do
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

  # The live worker here is a Claude session with no Shuttle hook, as every
  # Claude worker is for a few seconds after launch, so the inbox cannot be
  # handed to it now. The sender is told the message is queued for the fiber's
  # worker and why it could not be handed over, with nothing that reads as a
  # loss to resend under a new id.
  test "a message to a fiber with a live worker is queued in its inbox, and a failed consume says so" do
    message_live_worker("tests/deliver-live-queue")

    for _attempt <- 1..2 do
      body =
        "tests/deliver-live-queue" |> queue_for_fiber("msg-live-1") |> json_response(202)

      assert %{
               "delivery" => "context",
               "queued" => true,
               "status" => "queued",
               "delivered" => nil,
               "detail" => detail
             } = body

      assert detail =~
               ~r/^tests\/deliver-live-queue's inbox holds it, and its worker takes it from there; the live worker could not be handed it now \(.*has not registered a Shuttle message hook.*\)$/s

      refute detail =~ "not known"
      refute detail =~ "could not be consumed"
    end

    assert [args, _] = mailbox_puts()
    assert "msg-live-1" in args
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

  defp notify_only(fiber_id) do
    api_conn()
    |> post(
      "/api/v1/deliver",
      Jason.encode!(%{
        "fiber_id" => fiber_id,
        "notify_when_idle" => true,
        "from" => "shuttle://elsewhere/claude/sender",
        "message_id" => "n-#{System.unique_integer([:positive])}"
      })
    )
  end

  # A notify-only request reaches only the fiber's owner, as every other
  # delivery does: a daemon that does not own it says so.
  test "a notify-only request to a daemon that does not own the fiber is refused as such" do
    MockRunner.set_fiber("tests/notify-elsewhere", make_fiber("tests/notify-elsewhere"))
    MockRunner.set_shuttle("tests/notify-elsewhere", "kind: oneshot\nhost: elsewhere\n")

    assert %{"error" => "this daemon does not own the fiber"} =
             "tests/notify-elsewhere" |> notify_only() |> json_response(409)
  end

  # A live worker whose delivery address is not confirmed is reported as that,
  # not as a fiber with no live worker; nothing is subscribed.
  test "a notify-only request to a live worker with no confirmed delivery address says so" do
    message_live_worker("tests/notify-unconfirmed")
    poller = GenServer.whereis(Shuttle.Env.server(Poller))

    :sys.replace_state(poller, fn state ->
      key = Poller.running_key(state, "tests/notify-unconfirmed")
      update_in(state.running[key], &Map.merge(&1, %{context_epoch: nil, context_address: nil}))
    end)

    # Any handled message republishes the readers' view of the workers.
    Poller.refresh_document("tests/notify-unconfirmed")
    :sys.get_state(poller)

    assert %{"error" => error} =
             "tests/notify-unconfirmed" |> notify_only() |> json_response(409)

    assert error =~ "has no confirmed delivery address"
    refute_received {:message, _}
  end

  # Only a request with no text is notify-only; whitespace text is refused as
  # on any other request, and subscribes nobody.
  test "whitespace text with notify_when_idle is refused, not a subscription" do
    for extra <- [%{}, %{"context_only" => true, "wake" => true}] do
      assert %{"error" => "text is required"} =
               api_conn()
               |> post(
                 "/api/v1/deliver",
                 Jason.encode!(
                   Map.merge(
                     %{
                       "fiber_id" => "tests/x",
                       "text" => "   ",
                       "notify_when_idle" => true,
                       "message_id" => "n-space"
                     },
                     extra
                   )
                 )
               )
               |> json_response(400)
    end
  end
end
