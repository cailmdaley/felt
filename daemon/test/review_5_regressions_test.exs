defmodule ShuttleWeb.VoiceImportRegressionTest do
  use ExUnit.Case, async: true

  import Shuttle.Test.ForwardStub
  import Shuttle.Test.PollerHelpers

  alias Shuttle.Test.FeltStoreRunner, as: MockRunner
  alias Shuttle.Test.{Env, StubPostClient}
  alias Shuttle.Voice.TranscriptRelay.Worker

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

  defp put_constitution(fiber_id, shuttle \\ oneshot_shuttle()) do
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id))
    MockRunner.set_shuttle(fiber_id, shuttle)
  end

  test "an import for a missing local fiber finishes unconfirmed" do
    batch = %{
      fiber_id: "tests/gone",
      origin: nil,
      message_id: "voice-gone",
      text: "old words\n",
      record_only: true
    }

    result = Worker.deliver(batch)
    assert {200, %{delivered: nil}} = result
  end

  test "an import for an unknown origin finishes unconfirmed" do
    batch = %{
      fiber_id: "tests/x",
      origin: "decommissioned-host",
      message_id: "voice-orphan",
      text: "old words\n",
      record_only: true
    }

    result = Worker.deliver(batch)
    assert {200, %{delivered: nil}} = result
  end

  test "an attempted-batch import writes no board row" do
    fiber = "tests/voice-import-row"
    put_constitution(fiber)
    before = MockRunner.commands()

    assert {200, %{duplicate: true, disposition: "unknown"}} =
             Worker.deliver(%{
               fiber_id: fiber,
               origin: nil,
               message_id: "voice-import-row",
               text: "old words\n",
               record_only: true
             })

    begin =
      Enum.find(MockRunner.commands() -- before, fn {cmd, args} ->
        cmd == "shuttle" and match?(["inbox", "record-begin" | _], args)
      end)

    assert {"shuttle", args} = begin
    refute "--fiber" in args
  end

  test "an obsolete relay-side record cannot prevent forwarding to the owner" do
    stub_forward(
      "voice-owner",
      "http://localhost:4002",
      {:ok, 200, Jason.encode!(%{delivered: true, delivery: "input"})},
      StubPostClient
    )

    StubPostClient.set_get_response({:ok, Jason.encode!(%{contract_level: 44})})

    # The relay died after `record-begin` in voice-forwards, before the POST.
    assert {:ok, out} =
             Shuttle.CLI.run(
               [
                 "inbox",
                 "record-begin",
                 "--from",
                 "human",
                 "--source",
                 "voice",
                 "--",
                 "voice-forwards",
                 "voice-crash-before-post"
               ],
               input: "words\n",
               input_eof: true
             )

    assert %{"created" => true} = Jason.decode!(out)

    # Recovery repeats the handoff.
    result =
      Worker.deliver(%{
        fiber_id: "frozen-fiber",
        origin: "voice-owner",
        message_id: "voice-crash-before-post",
        text: "words\n"
      })

    assert {200, %{"delivered" => true}} = result
    assert [_] = StubPostClient.posts()
  end
end

defmodule Shuttle.VoiceImportLaneRegressionTest do
  use ExUnit.Case, async: true
  alias Shuttle.Voice.TranscriptRelay
  alias Shuttle.Voice.TranscriptRelay.Worker
  alias Shuttle.Test.Env
  @moduletag :tmp_dir

  defp run_relay(root, outbox) do
    Env.put_env("SHUTTLE_DATA_DIR", root)
    Env.put_env("SHUTTLE_VOICE_FILE", Path.join(root, "voice.json"))
    directory = Path.join(root, "relays")
    File.mkdir_p!(directory)
    transcript = Path.join(root, "voice.txt")
    File.write!(transcript, "")
    digest = :crypto.hash(:sha256, "old") |> Base.encode16(case: :lower)

    config = %{
      "launch" => "old",
      "created_at" => "2026-11-06T10:00:00Z",
      "kind" => "voice",
      "transcript" => transcript,
      "offset" => 0,
      "routes_path" => Path.join(root, "routes.jsonl"),
      "ended" => true,
      "outbox" => outbox
    }

    File.write!(Path.join(directory, digest <> ".json"), Jason.encode!(config))
    {:ok, attempts} = Agent.start_link(fn -> [] end)

    # The attempted import's owner is unavailable.
    deliver = fn message ->
      Agent.update(attempts, &[message.message_id | &1])

      if message[:record_only],
        do: Worker.deliver(message),
        else: {200, %{delivered: true}}
    end

    name = Module.concat(__MODULE__, "S#{System.unique_integer([:positive])}")

    start_supervised!(
      {TranscriptRelay,
       [
         name: name,
         directory: directory,
         poll_ms: 250,
         deliver: deliver,
         observe: fn -> {:ok, %{capture: nil}} end,
         clock: fn -> 1_000 end,
         thresholds: fn -> %{"words" => 10, "quiet_seconds" => 4} end,
         cold: fn _ -> false end,
         played: fn -> [] end
       ]}
    )

    Process.sleep(2_000)
    counts = Agent.get(attempts, &Enum.frequencies/1)
    on_disk = Path.join(directory, digest <> ".json") |> File.read!() |> Jason.decode!()
    lanes = :sys.get_state(Module.concat(name, Coordinator)).lanes

    lanes =
      Map.new(lanes, fn {k, lane} ->
        {k,
         Enum.map(lane, fn {owner, m} ->
           {if(owner, do: :submitted, else: :reserved), m.message_id}
         end)}
      end)

    # A later recording speaks to the same fiber/origin.
    later =
      try do
        GenServer.call(
          Module.concat(name, Coordinator),
          {:deliver,
           %{
             fiber_id: "fiber-a",
             origin: "owner",
             text: "later\n",
             message_id: "voice-c",
             record_only: false
           }},
          1_000
        )
      catch
        :exit, {:timeout, _} -> :timeout
      end

    assert {200, %{delivered: true}} = later
    {counts, Enum.map(on_disk["outbox"] || [], & &1["message_id"]), on_disk["completed"], lanes}
  end

  @a %{
    "fiber_id" => "fiber-a",
    "origin" => "owner",
    "text" => "first\n",
    "message_id" => "voice-a",
    "attempted" => true
  }
  @b %{
    "fiber_id" => "fiber-a",
    "origin" => "owner",
    "text" => "second\n",
    "message_id" => "voice-b"
  }

  test "a failed import finishes after one attempt", %{tmp_dir: root} do
    {counts, outbox, completed, lanes} = run_relay(root, [@a])
    assert counts == %{"voice-a" => 1}
    assert outbox == []
    assert completed
    assert lanes == %{}
  end

  test "a failed import releases recovered and later batches in its lane", %{tmp_dir: root} do
    {counts, outbox, completed, lanes} = run_relay(root, [@a, @b])
    assert counts == %{"voice-a" => 1, "voice-b" => 1}
    assert outbox == []
    assert completed
    assert lanes == %{}
  end
end

defmodule Shuttle.PulseRecordFailureRegressionTest do
  use ExUnit.Case, async: true
  import Shuttle.Test.PollerHelpers
  alias Shuttle.Pulse
  alias Shuttle.Test.{Env, FeltStoreRunner}

  setup do
    FeltStoreRunner.start!()

    FeltStoreRunner.set_shuttle("watch", """
    kind: oneshot
    agent: claude-sonnet
    pulse: 1m
    resolved:
      pulse_interval_ms: 60000
    """)

    parent = self()
    phase = start_supervised!({Agent, fn -> %{} end})
    Env.put_app_env(:waiting_phases_source, fn -> Agent.get(phase, & &1) end)

    Env.put_app_env(:pulse_sender, fn payload ->
      send(parent, {:pulse_sent, self(), payload})
      {:ok, 200, %{"status" => "accepted"}}
    end)

    {:ok, poller} =
      start_poller!(
        runner: FeltStoreRunner,
        felt_stores: [FeltStoreRunner.felt_root()],
        poll_interval_ms: 60_000,
        heartbeat_interval_ms: 60_000
      )

    await_boot_cycle!(poller)
    [worker] = Map.values(:sys.get_state(poller).running)
    uuid = worker.session_uuid
    Agent.update(phase, fn _ -> %{uuid => %{last_event_at: 0, phase: "waiting"}} end)
    %{poller: poller, uuid: uuid}
  end

  defp await(fun, n \\ 3000)

  defp await(fun, n) when n > 0,
    do:
      if(fun.(),
        do: :ok,
        else:
          (
            Process.sleep(5)
            await(fun, n - 1)
          )
      )

  defp await(_, 0), do: flunk("no")

  test "a failed record-begin releases an idle Claude worker's reservation",
       %{poller: poller} do
    # Fiber inboxes cannot be created: `record-begin` fails.
    mailboxes = Path.join(Shuttle.data_dir(), "mailboxes")
    File.rm_rf!(Path.join(mailboxes, "fiber"))
    File.mkdir_p!(mailboxes)
    File.write!(Path.join(mailboxes, "fiber"), "not a directory")

    :sys.replace_state(poller, fn state ->
      [key] = Map.keys(state.pulses)
      put_in(state.pulses[key]["next_tick"], "2026-01-01T00:00:00Z")
    end)

    send(poller, :run_poll_cycle)

    await(fn ->
      :sys.get_state(poller).poll_cycles > 0 and :sys.get_state(poller).pulse_jobs == %{}
    end)

    Process.sleep(200)
    await(fn -> :sys.get_state(poller).pulse_jobs == %{} end)
    refute_received {:pulse_sent, _, _}
    [row] = Map.values(Pulse.load())
    assert row["state"] == "scheduled"
    refute row["pending"]
  end
end
