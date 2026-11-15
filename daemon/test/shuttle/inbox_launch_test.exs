defmodule Shuttle.InboxLaunchTest do
  # A waking inbox entry for a fiber with no worker starts a session, through
  # the real felt and shuttle CLIs, an on-disk inbox and the real hook; tmux
  # is the integration runner's in-memory session set.
  use Shuttle.Test.DispatchIntegrationCase, async: true

  alias Shuttle.{Delivery, FiberDocuments}

  @note "Shuttle started this session because messages are waiting"

  defp constitution(host, id, frontmatter) do
    write_fiber(host, id, """
    ---
    name: Inbox #{id}
    #{frontmatter}
    ---
    A constitution messages reach.
    """)

    Shuttle.Test.Env.put_env("SHUTTLE_STORES", host)
    id
  end

  defp oneshot(host, id, status, extra \\ "") do
    constitution(host, id, """
    status: #{status}
    #{extra}
    shuttle:
      kind: oneshot
      host: test-host
      agent: claude-sonnet
      project_dir: "#{host}"
    """)
  end

  defp entry(host, id) do
    {:ok, %{fibers: [entry]}} = FiberDocuments.get_shuttle(id, felt_stores: [host])
    entry
  end

  defp launches(id) do
    session = FiberUid.session(id)

    Enum.count(IntegrationRunner.commands(), fn {cmd, args} ->
      cmd == "tmux" and "new-session" in args and session in args
    end)
  end

  defp poller!(host, opts \\ []) do
    {:ok, poller} =
      start_poller!(
        Keyword.merge(
          [runner: IntegrationRunner, poll_interval_ms: 600_000, felt_stores: [host]],
          opts
        )
      )

    await_boot_cycle!(poller)
    drain!(poller)
    poller
  end

  # A poll, then the inbox work it hands to a task.
  defp poll!(poller) do
    sync_poll_cycle!(poller)
    drain!(poller)
  end

  defp drain!(poller) do
    :sys.get_state(poller, :infinity)

    for pid <- Task.Supervisor.children(Shuttle.TaskSupervisor),
        {:dictionary, dict} <- [Process.info(pid, :dictionary)],
        poller in Keyword.get(dict, :"$callers", []) do
      ref = Process.monitor(pid)
      assert_receive {:DOWN, ^ref, :process, ^pid, _}, 60_000
    end

    :sys.get_state(poller, :infinity)
  end

  defp pending(entry) do
    {:ok, output} = Shuttle.CLI.run(["inbox", "ls", Delivery.context_key(entry), "--json"])
    output |> Jason.decode!() |> Map.new(&{&1["id"], &1})
  end

  defp lapse_leases do
    for path <-
          Path.wildcard(
            Path.join(Shuttle.Env.get("SHUTTLE_DATA_DIR"), "mailboxes/fiber/*/pending/*.json")
          ) do
      entry = path |> File.read!() |> Jason.decode!()

      if entry["attempt"] do
        lapsed = System.os_time(:nanosecond) - 3 * 60 * 1_000_000_000
        File.write!(path, Jason.encode!(put_in(entry, ["attempt", "opened_at"], lapsed)))
      end
    end
  end

  defp hook!(uuid, event \\ "UserPromptSubmit") do
    frame =
      Jason.encode!(%{session_id: uuid, hook_event_name: event, harness: "claude", cwd: "/"})

    cli = Shuttle.Env.find_executable("shuttle")

    {output, 0} =
      Shuttle.Env.cmd(
        "bash",
        ["--noprofile", "--norc", "-c", "printf '%s\\n' '#{frame}' | '#{cli}' hook event"],
        env: [{"SHUTTLE_BOARD", "off"}, {"SHUTTLE_EVENTS", "off"}]
      )

    output
  end

  test "a waking message to a dormant constitution starts one session, whose first hook takes the batch",
       %{host: host} do
    id = oneshot(host, "tests/inbox-dormant", "open")
    poller = poller!(host)
    parent = entry(host, id)

    assert {:ok, :queued} = Delivery.context(parent, "quiet context", "m-quiet")
    assert launches(id) == 0
    assert {:ok, :starting} = Delivery.context(parent, "first message", "m-1", turn: "force")
    assert launches(id) == 1
    script = read_run_script()
    assert script =~ @note
    refute script =~ "first message"
    refute script =~ "quiet context"

    # The session is live: a second message and later polls start nothing more.
    assert {:ok, :queued} = Delivery.context(parent, "second message", "m-2", wake: true)
    for _ <- 1..3, do: poll!(poller)
    assert launches(id) == 1
    assert %{"m-1" => %{"turn" => "force"}, "m-2" => %{"turn" => "ask"}} = pending(parent)

    # The launched session's first prompt takes the whole batch, the forced
    # entry its launch reserved included.
    %{session_uuid: uuid} = Poller.live_worker(poller, id)
    assert is_binary(uuid)
    output = hook!(uuid)
    for text <- ["quiet context", "first message", "second message"], do: assert(output =~ text)
    assert pending(parent) == %{}
    refute hook!(uuid) =~ "first message"
  end

  test "a closed, resting or paused constitution keeps a waking entry without launching", %{
    host: host
  } do
    closed = oneshot(host, "tests/inbox-closed", "closed")
    resting = oneshot(host, "tests/inbox-resting", "open", "horizon: stashed")

    paused =
      constitution(host, "tests/inbox-paused", """
      status: open
      shuttle:
        kind: standing
        host: test-host
        agent: claude-sonnet
        project_dir: "#{host}"
        schedule:
          expr: "0 9 * * *"
          tz: UTC
      """)

    poller = poller!(host)

    for {id, why} <- [
          {closed, "is closed"},
          {resting, "is at rest"},
          {paused, "schedule is paused"}
        ] do
      parent = entry(host, id)

      assert {:ok, {:waiting, detail}} =
               Delivery.context(parent, "wake up", "m-#{id}", wake: true)

      assert detail =~ why
      message = "m-" <> id
      assert %{^message => %{"turn" => "ask"}} = pending(parent)
    end

    for _ <- 1..2, do: poll!(poller)
    assert Enum.map([closed, resting, paused], &launches/1) == [0, 0, 0]
    assert read_frontmatter(host, closed)["status"] == "closed"
    assert read_frontmatter(host, resting)["horizon"] == "stashed"
    assert read_frontmatter(host, paused)["status"] == "open"
  end

  test "the boot quarantine holds an inbox launch, drawn as held, until it is released", %{
    host: host
  } do
    id = oneshot(host, "tests/inbox-held", "active")
    poller = poller!(host, boot_quarantine: true)
    parent = entry(host, id)
    assert {:ok, {:waiting, detail}} = Delivery.context(parent, "hold me", "m-held", wake: true)
    assert detail =~ "boot quarantine"
    assert [%{fiber_id: ^id}] = Poller.snapshot(poller).pending_launch
    assert %{"m-held" => %{"turn" => "ask"} = held} = pending(parent)
    refute held["attempt"], "a held launch reserved its entries"

    for _ <- 1..2, do: poll!(poller)
    assert launches(id) == 0
    assert [%{fiber_id: ^id}] = Poller.snapshot(poller).pending_launch

    :ok = Poller.release_boot_quarantine(poller)
    assert eventually(fn -> launches(id) == 1 end)
    drain!(poller)
    assert launches(id) == 1
    assert Poller.snapshot(poller).pending_launch == []
  end

  test "an entry queued before a restart launches on the first poll; a reservation the old daemon left waits out its lease",
       %{host: host} do
    queued = oneshot(host, "tests/inbox-queued", "open")
    id = oneshot(host, "tests/inbox-restart", "open")
    key = Delivery.context_key(entry(host, id))

    # Queued while no daemon ran.
    assert {:ok, _} =
             Shuttle.CLI.run([
               "inbox",
               "put",
               Delivery.context_key(entry(host, queued)),
               "m-queued",
               "while down",
               "--turn",
               "force"
             ])

    # The daemon died after reserving the launch and before dispatching it.
    assert {:ok, _} =
             Shuttle.CLI.run(["inbox", "put", key, "m-restart", "after restart", "--turn", "ask"])

    assert {:ok, reserved} = Shuttle.CLI.run(["inbox", "consume", key, "-", "0"])
    assert %{"action" => "launch"} = Jason.decode!(reserved)

    poller = poller!(host)
    assert launches(queued) == 1
    for _ <- 1..2, do: poll!(poller)
    assert launches(id) == 0

    lapse_leases()
    poll!(poller)
    assert launches(id) == 1
    assert read_run_script() =~ @note
  end

  test "a message starts an armed standing constitution between runs without moving its schedule",
       %{host: host} do
    now = DateTime.utc_now()
    later = DateTime.add(now, 6 * 3600, :second)

    id =
      constitution(host, "tests/inbox-standing", """
      status: active
      shuttle:
        kind: standing
        host: test-host
        agent: claude-sonnet
        project_dir: "#{host}"
        schedule:
          expr: "#{later.minute} #{later.hour} * * *"
          tz: UTC
      """)

    write_dispatch_marker(host, id, "12345678-1234-4000-8000-000000000042", ago(120))
    write_handoff_marker(host, id, ago(60))
    before = read_frontmatter(host, id)
    poller = poller!(host)
    assert launches(id) == 0

    assert {:ok, :starting} =
             Delivery.context(entry(host, id), "between runs", "m-standing", wake: true)

    assert launches(id) == 1
    assert read_run_script() =~ "Run mode: ad-hoc"
    during = read_frontmatter(host, id)
    assert during["status"] == "active"
    assert during["shuttle"]["schedule"] == before["shuttle"]["schedule"]
    assert "inbox-" <> _ = during["shuttle"]["runtime"]["run_id"]

    # The run ends; its conclusion is not service, and nothing new is due.
    state = :sys.get_state(poller)
    %{pid: watcher, session: session} = state.running[Poller.running_key(state, id)]
    IntegrationRunner.remove_tmux_session(session)
    send(poller, {:worker_exited, id, watcher, session, :normal_exit})
    :sys.get_state(poller)
    for _ <- 1..2, do: poll!(poller)
    after_run = read_frontmatter(host, id)
    assert after_run["status"] == "active"
    assert after_run["shuttle"]["schedule"] == before["shuttle"]["schedule"]
    assert get_in(after_run, ["shuttle", "runtime", "thread_exit_verb"]) == "handed off"
    refute Poller.StandingRoles.standing_role_due?(entry(host, id).fiber)
    assert launches(id) == 1
  end

  test "a message to a standing constitution whose run is due waits for that run", %{host: host} do
    id = seed_due_standing(host)
    poller = poller!(host, max_concurrent_workers: 0)

    assert {:ok, {:waiting, detail}} =
             Delivery.context(entry(host, id), "for the run", "m-due", wake: true)

    assert detail =~ "scheduled run is due"
    poll!(poller)
    assert launches(id) == 0
    assert %{"m-due" => %{"turn" => "ask"}} = pending(entry(host, id))
  end

  # The due rule over the run markers alone: an occurrence that elapsed while
  # a run started for messages was live still fires after it hands off; one
  # during an ordinary ad-hoc run, or after a human's act on the inbox run,
  # does not.
  test "a run started for messages is not service of the schedule" do
    now = DateTime.utc_now()
    at = &(now |> DateTime.add(-&1, :second) |> DateTime.to_iso8601())

    fiber = fn run_id, verb ->
      %{
        "status" => "active",
        "shuttle" => %{
          "kind" => "standing",
          "resolved" => %{"prev_due" => at.(600), "next_due" => at.(-86_400)},
          "runtime" => %{
            "dispatched_at" => at.(900),
            "handed_off_at" => at.(300),
            "run_id" => run_id,
            "thread_exit_verb" => verb
          }
        }
      }
    end

    assert Poller.StandingRoles.standing_role_due?(fiber.("inbox-1", "handed off"))
    refute Poller.StandingRoles.standing_role_due?(fiber.("adhoc-1", "handed off"))
    refute Poller.StandingRoles.standing_role_due?(fiber.("inbox-1", "rearmed"))
    refute Poller.StandingRoles.standing_role_due?(fiber.("inbox-1", "tempered"))
  end
end
