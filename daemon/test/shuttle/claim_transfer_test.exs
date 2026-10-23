defmodule Shuttle.ClaimTransferTest do
  @moduledoc """
  A live worker that claims another fiber moves to it: the fiber it served is
  concluded and released, its worker keeps running for the claimed fiber, and
  nothing derived from tmux names ever stops, adopts or resumes it.
  """

  use ExUnit.Case, async: true

  import Shuttle.Test.PollerHelpers
  import Shuttle.Test.TranscriptHelpers

  alias Shuttle.{Continuation, Poller, SessionLedger}
  alias Shuttle.Test.{Env, FiberUid}
  alias Shuttle.Test.FeltStoreRunner, as: Runner

  @state_timeout 30_000

  setup do
    Runner.start!()
    Runner.reset()
    root = Runner.felt_root()
    on_exit(fn -> File.rm_rf(root) end)
    data = Path.join(System.tmp_dir!(), "shuttle-claim-#{System.unique_integer([:positive])}")
    File.mkdir_p!(data)
    Env.put_env("SHUTTLE_DATA_DIR", data)
    Env.delete_env("SHUTTLE_SESSIONS_FILE")

    for id <- ["tests/a", "tests/b", "tests/c"] do
      Runner.set_fiber(id, make_fiber(id))
      Runner.set_shuttle(id, "kind: oneshot\nagent: claude-sonnet\n")
    end

    :ok
  end

  defp start(opts \\ []) do
    {:ok, poller} =
      start_poller!(
        Keyword.merge(
          [
            runner: Runner,
            felt_stores: [Runner.felt_root()],
            max_concurrent_workers: 0,
            poll_interval_ms: 600_000,
            heartbeat_interval_ms: 20
          ],
          opts
        )
      )

    await_boot_cycle!(poller)
    settle(poller)
    poller
  end

  defp settle(poller) do
    assert wait_until(fn ->
             state = :sys.get_state(poller, @state_timeout)
             state.poll_cycles > 0 and not state.poll_check_in_progress
           end)
  end

  defp poll(poller) do
    settle(poller)
    before = :sys.get_state(poller, @state_timeout).poll_cycles
    send(poller, :run_poll_cycle)
    assert wait_until(fn -> :sys.get_state(poller, @state_timeout).poll_cycles > before end)
    settle(poller)
  end

  defp wait_until(fun, attempts \\ 3_000)
  defp wait_until(fun, 0), do: fun.()

  defp wait_until(fun, attempts) do
    if fun.(), do: true, else: Process.sleep(5) && wait_until(fun, attempts - 1)
  end

  defp runtime(id), do: get_in(Runner.fiber(id), ["shuttle", "runtime"]) || %{}
  defp concluded?(id), do: Continuation.clean_handoff_since_dispatch?(Runner.fiber(id))

  # A worker launched for `id`: its session, conversation and pane.
  defp launch!(poller, id) do
    assert {:ok, session} = Poller.dispatch_fiber(poller, id, force: true)
    %{session: session, uuid: runtime(id)["session_uuid"], pane: Runner.launched_pid(session)}
  end

  defp claim(poller, id, worker, opts \\ []),
    do: Poller.claim_session(poller, id, worker.session, [session_uuid: worker.uuid] ++ opts)

  defp signals,
    do:
      Enum.filter(Runner.commands(), fn
        {"kill", _} -> true
        {"tmux", [verb | _]} -> verb in ["kill-pane", "kill-session"]
        _ -> false
      end)

  defp scripts do
    for {"tmux", ["new-session" | _] = args} <- Runner.commands(),
        do: {Enum.at(args, 3), File.read!(List.last(args))}
  end

  defp ledger(kind), do: Enum.filter(SessionLedger.read_since(0), &(&1["kind"] == kind))

  test "a claim from a launched worker releases its fiber without signalling it" do
    poller = start()
    worker = launch!(poller, "tests/a")
    assert %{pid: watcher} = Poller.worker_status(poller, "tests/a")

    assert {:ok, %{session: session}} = claim(poller, "tests/b", worker)
    # Names never change.
    assert session == worker.session
    refute Enum.any?(Runner.commands(), &match?({"tmux", ["rename-session" | _]}, &1))

    # A: its watcher is gone without exit handling, its dispatch concluded.
    assert Poller.worker_status(poller, "tests/a") == nil
    refute Process.alive?(watcher)
    assert concluded?("tests/a")

    assert [%{"fiber" => "tests/a", "superseded_by" => "tests/b"} = row] =
             ledger("superseded_by_claim")

    assert row["session"] == worker.uuid

    # B: runs the same worker under a new generation naming its conversation.
    assert %{holder_uuid: uuid, session: ^session} = Poller.worker_status(poller, "tests/b")
    assert uuid == worker.uuid
    assert runtime("tests/b")["session_uuid"] == worker.uuid
    assert [%{"fiber" => "tests/b", "session" => ^uuid}] = ledger("claim")
    assert signals() == []

    # A is dispatchable again: a fresh launch of its own.
    assert {:ok, fresh} = Poller.dispatch_fiber(poller, "tests/a", [])
    refute fresh == session
    refute runtime("tests/a")["session_uuid"] == worker.uuid
  end

  test "a stop of the released fiber never signals the claimer" do
    poller = start()
    worker = launch!(poller, "tests/a")
    assert {:ok, _} = claim(poller, "tests/b", worker)

    assert {:ok, :no_session} = Poller.kill_session(poller, "tests/a")
    assert {:ok, output} = Poller.lifecycle_transition(poller, :rest, "tests/a")
    refute output =~ "worker: stopped"
    assert signals() == []
    assert Runner.launched_pid(worker.session) == worker.pane
    assert %{holder_uuid: _} = Poller.worker_status(poller, "tests/b")
  end

  test "after the claimer exits, the released fiber starts fresh and only the claimed one resumes" do
    poller = start()
    worker = launch!(poller, "tests/a")
    # A warm transcript: a resume would be chosen for any fiber still assigned it.
    write_transcript(worker.uuid)
    assert {:ok, _} = claim(poller, "tests/b", worker)

    Runner.remove_tmux_session(worker.session)
    assert wait_until(fn -> Poller.worker_status(poller, "tests/b") == nil end)
    poll(poller)

    assert {:ok, a_session} = Poller.dispatch_fiber(poller, "tests/a", [])
    {_, a_script} = List.keyfind(scripts(), a_session, 0)
    refute a_script =~ "--resume"
    refute a_script =~ "--session-id '#{worker.uuid}'"

    assert {:ok, b_session} = Poller.dispatch_fiber(poller, "tests/b", [])
    {_, b_script} = List.keyfind(scripts(), b_session, 0)
    assert b_script =~ "--resume '#{worker.uuid}'"
  end

  test "a source conclusion that cannot be written stops the claim before anything moves" do
    poller = start()
    worker = launch!(poller, "tests/a")
    generation = runtime("tests/b")["dispatched_at"]

    Runner.set_mark_runtime_failures(["tests/a"])

    assert {:error, {:source_not_concluded, "tests/a", _}} = claim(poller, "tests/b", worker)
    assert %{holder_uuid: _} = Poller.worker_status(poller, "tests/a")
    assert Poller.worker_status(poller, "tests/b") == nil
    assert runtime("tests/b")["dispatched_at"] == generation
    refute concluded?("tests/a")
    assert ledger("superseded_by_claim") == []

    Runner.set_mark_runtime_failures([])
    assert {:ok, _} = claim(poller, "tests/b", worker)
    assert Poller.worker_status(poller, "tests/a") == nil
  end

  test "a claim interrupted after the release leaves the worker unowned, then completes on retry" do
    poller = start()
    worker = launch!(poller, "tests/a")
    Runner.set_mark_runtime_failures(["tests/b"])

    assert {:error, _} = claim(poller, "tests/b", worker)
    assert concluded?("tests/a")
    assert Poller.worker_status(poller, "tests/a") == nil
    assert Poller.worker_status(poller, "tests/b") == nil

    # Nothing adopts the unowned worker, even across a restart; the snapshot
    # shows it.
    GenServer.stop(poller)
    poller = start()
    assert Poller.worker_status(poller, "tests/a") == nil
    assert Poller.worker_status(poller, "tests/b") == nil
    assert signals() == []
    uuid = worker.uuid
    session = worker.session
    assert [%{session_uuid: ^uuid, tmux_session: ^session}] = Poller.snapshot(poller).unowned

    Runner.set_mark_runtime_failures([])
    assert {:ok, _} = claim(poller, "tests/b", worker)
    assert %{holder_uuid: ^uuid} = Poller.worker_status(poller, "tests/b")
    poll(poller)
    assert Poller.snapshot(poller).unowned == []
  end

  test "a crash after the target is stamped is completed by adoption" do
    poller = start()
    worker = launch!(poller, "tests/a")
    GenServer.stop(poller)

    # Steps 1 and 2 landed; the daemon died before registering B.
    Runner.put_shuttle_fields("tests/a", %{
      "handed_off_at" => DateTime.to_iso8601(DateTime.add(DateTime.utc_now(), 1))
    })

    Runner.put_shuttle_fields("tests/b", %{
      "dispatched_at" => DateTime.to_iso8601(DateTime.utc_now()),
      "session_uuid" => worker.uuid
    })

    poller = start()
    assert %{holder_uuid: uuid, session: session} = Poller.worker_status(poller, "tests/b")
    assert uuid == worker.uuid
    assert session == worker.session
    assert Poller.worker_status(poller, "tests/a") == nil
  end

  test "a restart adopts the claimed fiber by its conversation and never resurrects the released one" do
    poller = start()
    worker = launch!(poller, "tests/a")
    assert {:ok, _} = claim(poller, "tests/b", worker)
    GenServer.stop(poller)

    poller = start(boot_quarantine: true)
    assert %{holder_uuid: uuid, session: session} = Poller.worker_status(poller, "tests/b")
    assert uuid == worker.uuid
    assert session == worker.session
    assert Poller.worker_status(poller, "tests/a") == nil
    assert concluded?("tests/a")
  end

  test "a claim chain moves the worker A → B → C" do
    poller = start()
    worker = launch!(poller, "tests/a")
    assert {:ok, _} = claim(poller, "tests/b", worker)
    assert {:ok, _} = claim(poller, "tests/c", worker)

    assert Poller.worker_status(poller, "tests/a") == nil
    assert Poller.worker_status(poller, "tests/b") == nil
    assert %{holder_uuid: uuid} = Poller.worker_status(poller, "tests/c")
    assert uuid == worker.uuid
    assert concluded?("tests/a") and concluded?("tests/b")

    assert [{"tests/a", "tests/b"}, {"tests/b", "tests/c"}] =
             Enum.map(ledger("superseded_by_claim"), &{&1["fiber"], &1["superseded_by"]})

    assert signals() == []
  end

  test "an identical retry answers as the first claim did and changes nothing" do
    poller = start()
    worker = launch!(poller, "tests/a")
    assert {:ok, first} = claim(poller, "tests/b", worker)
    stamped = runtime("tests/b")
    assert {:ok, ^first} = claim(poller, "tests/b", worker)
    assert runtime("tests/b") == stamped
    assert length(ledger("claim")) == 1
    assert length(ledger("superseded_by_claim")) == 1
  end

  test "a hand-started claimer with no conversation in its argv is bound by its own process" do
    uuid = "6d688234-9445-4d16-93d3-6bef110ea659"
    Runner.add_tmux_session("human")
    Runner.set_panes(%{9100 => "human"})

    Runner.set_ps_result(
      {"9100 1 -zsh\n9101 9100 claude --model opus\n9102 9101 bash -c shuttle\n" <>
         "9103 9102 shuttle claim tests/b\n", 0}
    )

    poller = start()

    assert {:ok, %{session: "human"}} =
             Poller.claim_session(poller, "tests/b", "human",
               session_uuid: uuid,
               tmux_pane: "%9100",
               claimer_pid: 9103
             )

    # The harness that ran the claim, not the pane's shell.
    assert %{pane: %{"pid" => 9101}, holder_uuid: ^uuid} = Poller.worker_status(poller, "tests/b")
    assert runtime("tests/b")["pane"] == "9101:start-9101"

    # Across a restart, the binding still finds it.
    GenServer.stop(poller)
    poller = start()
    assert %{session: "human"} = Poller.worker_status(poller, "tests/b")

    # A stop signals that harness alone: never the human's pane or shell.
    assert {:ok, "human"} = Poller.kill_session(poller, "tests/b")
    assert {"kill", ["-TERM", "9101"]} in Runner.commands()
    refute Enum.any?(Runner.commands(), &match?({"tmux", ["kill-pane" | _]}, &1))
    refute Enum.any?(Runner.commands(), &match?({"kill", [_, "--", "-9100" | _]}, &1))
  end

  test "a reused pid never stands for a bound worker" do
    uuid = "6d688234-9445-4d16-93d3-6bef110ea65a"
    Runner.add_tmux_session("human")
    Runner.set_panes(%{9200 => "human"})
    Runner.set_ps_result({"9200 1 -zsh\n9201 9200 claude --model opus\n", 0})
    poller = start()

    assert {:ok, _} =
             Poller.claim_session(poller, "tests/b", "human",
               session_uuid: uuid,
               tmux_pane: "%9200"
             )

    # The harness exits and an unrelated process takes its pid.
    Runner.set_process_start(9201, "another-lifetime")
    assert wait_until(fn -> Poller.worker_status(poller, "tests/b") == nil end)
    assert {:ok, :no_session} = Poller.kill_session(poller, "tests/b")
    assert signals() == []
  end

  describe "two live fibers naming one conversation (an earlier build's claim)" do
    # The cineca shape: A's run script, named for A's session, runs in a pane
    # whose session an older claim renamed to B's; both fibers' runtimes name
    # the conversation its claude holds.
    setup do
      uuid = "de3e1096-8500-4eec-bfd9-6e6f01b24fda"
      a_name = FiberUid.session("tests/a")
      b_name = FiberUid.session("tests/b")
      Runner.put_shuttle_fields("tests/a", %{"dispatched_at" => "2026-10-19T09:00:00Z"})
      Runner.put_shuttle_fields("tests/a", %{"session_uuid" => uuid})
      Runner.put_shuttle_fields("tests/b", %{"dispatched_at" => "2026-10-22T21:00:29Z"})
      Runner.put_shuttle_fields("tests/b", %{"session_uuid" => uuid})
      pane = Runner.add_worker(b_name, uuid, script_key: a_name, child: "claude --resume #{uuid}")
      write_transcript(uuid)
      %{uuid: uuid, b_name: b_name, pane: pane}
    end

    test "is held: neither adopted, stopped nor resumed, and shown blocked", ctx do
      poller = start()
      assert Poller.worker_status(poller, "tests/a") == nil
      assert Poller.worker_status(poller, "tests/b") == nil

      held = Enum.filter(Poller.snapshot(poller).blocked, &(&1.reason =~ "shared conversation"))
      assert [%{reason: reason}] = held
      assert reason =~ ctx.uuid

      for id <- ["tests/a", "tests/b"] do
        assert {:error, refusal} = Poller.kill_session(poller, id)
        assert refusal =~ "also named by"
        assert {:error, :already_running} = Poller.dispatch_fiber(poller, id, [])
        assert {:error, :already_running} = Poller.dispatch_fiber(poller, id, force: true)
      end

      assert signals() == []
      assert scripts() == []
    end

    test "heals when the holder exits: one fiber starts fresh, then the other may resume", ctx do
      poller = start()
      Runner.remove_tmux_session(ctx.b_name)
      poll(poller)
      assert Enum.filter(Poller.snapshot(poller).blocked, &(&1.reason =~ "shared")) == []

      # While both still name it, neither resumes it.
      assert {:ok, a_session} = Poller.dispatch_fiber(poller, "tests/a", [])
      {_, a_script} = List.keyfind(scripts(), a_session, 0)
      refute a_script =~ "--resume"
      refute a_script =~ "--session-id '#{ctx.uuid}'"

      # A now names its own conversation, so B alone names the old one.
      assert {:ok, b_session} = Poller.dispatch_fiber(poller, "tests/b", [])
      {_, b_script} = List.keyfind(scripts(), b_session, 0)
      assert b_script =~ "--resume '#{ctx.uuid}'"
    end

    test "heals when all but one fiber hand off: the other is adopted", ctx do
      poller = start()
      Runner.put_shuttle_fields("tests/a", %{"handed_off_at" => "2026-10-23T00:00:00Z"})
      poll(poller)

      assert %{session: session, holder_uuid: uuid} = Poller.worker_status(poller, "tests/b")
      assert session == ctx.b_name
      assert uuid == ctx.uuid
      assert Poller.worker_status(poller, "tests/a") == nil
      assert Enum.filter(Poller.snapshot(poller).blocked, &(&1.reason =~ "shared")) == []
    end

    test "heals when the claimed fiber claims again", ctx do
      poller = start()

      assert {:ok, _} =
               Poller.claim_session(poller, "tests/b", ctx.b_name, session_uuid: ctx.uuid)

      assert concluded?("tests/a")
      assert %{holder_uuid: _} = Poller.worker_status(poller, "tests/b")
      assert signals() == []
    end
  end

  test "an earlier build's renamed claimer is adopted by the only fiber naming its conversation" do
    uuid = "de3e1096-8500-4eec-bfd9-6e6f01b24fdb"
    a_name = FiberUid.session("tests/a")
    b_name = FiberUid.session("tests/b")
    # A has since been launched again under a conversation of its own.
    Runner.put_shuttle_fields("tests/a", %{
      "dispatched_at" => "2026-10-23T09:00:00Z",
      "session_uuid" => "11111111-2222-3333-4444-555555555555"
    })

    Runner.put_shuttle_fields("tests/b", %{
      "dispatched_at" => "2026-10-22T21:00:29Z",
      "session_uuid" => uuid
    })

    pane = Runner.add_worker(b_name, uuid, script_key: a_name, child: "claude --resume #{uuid}")
    poller = start()

    assert %{session: ^b_name, holder_uuid: ^uuid} = Poller.worker_status(poller, "tests/b")
    assert Poller.worker_status(poller, "tests/a") == nil
    assert {:ok, ^b_name} = Poller.kill_session(poller, "tests/b")
    assert {"tmux", ["kill-pane", "-t", "%#{pane}"]} in Runner.commands()
  end

  # The review probes of an earlier design, as regressions: no claim, worker
  # exit, external close or lost observation may leave a fiber permanently
  # undispatchable.
  describe "nothing strands" do
    test "after an earlier build's claimer exits, both fibers dispatch" do
      uuid = "6d688234-9445-4d16-93d3-6bef110ea6aa"
      b_name = FiberUid.session("tests/b")

      for id <- ["tests/a", "tests/b"],
          do:
            Runner.put_shuttle_fields(id, %{
              "dispatched_at" => "2026-10-22T10:00:00Z",
              "session_uuid" => uuid
            })

      Runner.add_worker(b_name, uuid,
        script_key: FiberUid.session("tests/a"),
        child: "claude --resume #{uuid}"
      )

      poller = start()
      Runner.remove_tmux_session(b_name)
      poll(poller)
      assert {:ok, _} = Poller.dispatch_fiber(poller, "tests/a", force: true)
      assert {:ok, _} = Poller.dispatch_fiber(poller, "tests/b", force: true)
      GenServer.stop(poller)
      poller = start()
      assert %{} = Poller.worker_status(poller, "tests/a")
      assert %{} = Poller.worker_status(poller, "tests/b")
    end

    test "a source whose generation moved is released, and both fibers dispatch after the exit" do
      poller = start()
      worker = launch!(poller, "tests/a")
      # A's stamp moved under the claim (a sync, a lost write) but still names it.
      Runner.put_shuttle_fields("tests/a", %{"dispatched_at" => "2026-01-01T00:00:00Z"})
      assert {:ok, _} = claim(poller, "tests/b", worker)
      assert concluded?("tests/a")
      Runner.remove_tmux_session(worker.session)
      assert wait_until(fn -> Poller.worker_status(poller, "tests/b") == nil end)
      poll(poller)
      assert {:ok, _} = Poller.dispatch_fiber(poller, "tests/a", force: true)
      assert {:ok, _} = Poller.dispatch_fiber(poller, "tests/b", force: true)
    end

    test "a bound harness that exits reads gone and frees its fiber, its shell notwithstanding" do
      Runner.add_tmux_session("human")
      Runner.set_panes(%{9300 => "human"})
      Runner.set_ps_result({"9300 1 -zsh\n9301 9300 claude --model opus\n", 0})
      poller = start()
      assert {:ok, _} = Poller.claim_session(poller, "tests/b", "human", tmux_pane: "%9300")
      Runner.set_ps_result({"9300 1 -zsh\n", 0})
      assert wait_until(fn -> Poller.worker_status(poller, "tests/b") == nil end)
      poll(poller)
      assert {:ok, _} = Poller.dispatch_fiber(poller, "tests/b", force: true)
    end

    test "a live worker whose fiber closes externally is reaped, and nothing strands" do
      poller = start()
      worker = launch!(poller, "tests/a")
      Runner.set_fiber("tests/a", Map.put(Runner.fiber("tests/a"), "status", "closed"))
      poll(poller)
      poll(poller)
      assert Poller.worker_status(poller, "tests/a") == nil
      assert concluded?("tests/a")
      assert Runner.launched_pid(worker.session) == nil
      assert {:ok, _} = Poller.dispatch_fiber(poller, "tests/b", force: true)
      assert {:ok, _} = Poller.dispatch_fiber(poller, "tests/a", force: true)
    end

    test "an earlier build's adopted worker claims another, and both dispatch after it exits" do
      uuid = "6d688234-9445-4d16-93d3-6bef110ea6ab"
      a_name = FiberUid.session("tests/a")

      Runner.put_shuttle_fields("tests/a", %{
        "dispatched_at" => "2026-10-22T10:00:00Z",
        "session_uuid" => uuid
      })

      Runner.add_worker(a_name, uuid, script_key: a_name, child: "claude --resume #{uuid}")
      poller = start()
      assert %{session: ^a_name} = Poller.worker_status(poller, "tests/a")

      assert {:ok, _} = Poller.claim_session(poller, "tests/b", a_name, session_uuid: uuid)
      assert Poller.worker_status(poller, "tests/a") == nil
      Runner.remove_tmux_session(a_name)
      assert wait_until(fn -> Poller.worker_status(poller, "tests/b") == nil end)
      poll(poller)
      assert {:ok, _} = Poller.dispatch_fiber(poller, "tests/a", force: true)
      assert {:ok, _} = Poller.dispatch_fiber(poller, "tests/b", force: true)
    end
  end
end
