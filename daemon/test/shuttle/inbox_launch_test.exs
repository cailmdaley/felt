defmodule Shuttle.InboxLaunchTest.CloseAfterRead do
  # The integration runner, closing the fiber the moment the nth full read
  # (`shuttle show`) after the gate is armed returns: another writer's close
  # landing between two reads of one dispatch.
  alias Shuttle.Test.DispatchIntegrationCase.IntegrationRunner

  def cmd(command, args, opts) do
    result = IntegrationRunner.cmd(command, args, opts)

    with "shuttle" <- command,
         true <- "show" in args,
         {gate, n, path} when not is_nil(gate) <- Shuttle.Env.app(:close_after_read) do
      if Agent.get_and_update(gate, &{&1 + 1, &1 + 1}) == n,
        do:
          File.write!(path, String.replace(File.read!(path), "status: active", "status: closed"))
    end

    result
  end
end

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

  # An armed standing constitution between runs: active, its next tick hours
  # away and its last one served, so only a message starts it.
  defp armed(host, id) do
    later = DateTime.add(DateTime.utc_now(), 6 * 3600, :second)

    constitution(host, id, """
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
    id
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

  # What `shuttle inbox pending --waking` counts: zero while a reservation in
  # its lease owes an entry.
  defp waking(entry) do
    key = Delivery.context_key(entry)

    {:ok, output} =
      Shuttle.CLI.run(["inbox", "pending", "--waking", key], stderr_to_stdout: false)

    Jason.decode!(output)[key]
  end

  defp lapse_leases do
    for path <-
          Path.wildcard(
            Path.join(Shuttle.Env.get("SHUTTLE_DATA_DIR"), "mailboxes/fiber/*/launch.json")
          ) do
      reservation = path |> File.read!() |> Jason.decode!()
      lapsed = System.os_time(:nanosecond) - 3 * 60 * 1_000_000_000
      File.write!(path, Jason.encode!(Map.put(reservation, "opened_at", lapsed)))
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

  test "a delayed entry is inert at enqueue and fires on one poll for a dormant fiber", %{
    host: host
  } do
    id = armed(host, "tests/delayed-dormant")
    poller = poller!(host)
    parent = entry(host, id)

    instant =
      DateTime.add(DateTime.utc_now(), 2, :second)
      |> DateTime.truncate(:second)
      |> DateTime.to_iso8601()

    assert {:ok, {:scheduled, ^instant}} =
             Delivery.context(parent, "check converged", "later",
               turn: "ask",
               not_before: instant
             )

    assert launches(id) == 0
    assert waking(parent) == 0
    poll!(poller)
    assert launches(id) == 0
    assert %{scheduled_messages: scheduled} = :sys.get_state(poller)
    assert [%{"id" => "later", "text" => "check converged"}] = scheduled[parent.fiber["uid"]]
    Process.sleep(2100)
    poll!(poller)
    assert launches(id) == 1
    %{session_uuid: uuid} = Poller.live_worker(poller, id)
    assert hook!(uuid) =~ "check converged"
    refute hook!(uuid) =~ "check converged"
    poll!(poller)
    assert launches(id) == 1
    assert pending(parent) == %{}
  end

  test "a live worker never takes a future entry and its poll notices it when due", %{host: host} do
    id = armed(host, "tests/delayed-live")
    poller = poller!(host)
    parent = entry(host, id)
    assert {:ok, :starting} = Delivery.context(parent, "start", "start", turn: "force")
    %{session_uuid: uuid} = Poller.live_worker(poller, id)
    assert hook!(uuid) =~ "start"

    instant =
      DateTime.add(DateTime.utc_now(), 2, :second)
      |> DateTime.truncate(:second)
      |> DateTime.to_iso8601()

    assert {:ok, {:scheduled, ^instant}} =
             Delivery.context(parent, "live check", "live-later",
               turn: "ask",
               not_before: instant
             )

    refute hook!(uuid, "PostToolUse") =~ "live check"
    poll!(poller)
    refute hook!(uuid, "PostToolUse") =~ "live check"
    Process.sleep(2100)
    poll!(poller)
    # Busy Claude keeps its hook window, and the first due hook takes it.
    assert hook!(uuid, "PostToolUse") =~ "live check"
    refute hook!(uuid, "PostToolUse") =~ "live check"
    assert launches(id) == 1
  end

  test "a delayed entry that became due while down waits under boot quarantine", %{host: host} do
    id = armed(host, "tests/delayed-boot")
    parent = entry(host, id)
    key = Delivery.context_key(parent)

    instant =
      DateTime.add(DateTime.utc_now(), 1, :second)
      |> DateTime.truncate(:second)
      |> DateTime.to_iso8601()

    assert {:ok, _} =
             Shuttle.CLI.run([
               "inbox",
               "put",
               key,
               "down",
               "check after boot",
               "--turn",
               "ask",
               "--not-before",
               instant,
               "--if-costly",
               "fresh"
             ])

    Process.sleep(1100)
    poller = poller!(host, boot_quarantine: true)
    poll!(poller)
    assert launches(id) == 0
    assert %{"down" => _} = pending(parent)
    :ok = Poller.release_boot_quarantine(poller)
    poll!(poller)
    assert launches(id) == 1
    %{session_uuid: uuid} = Poller.live_worker(poller, id)
    assert hook!(uuid) =~ "check after boot"
    refute hook!(uuid) =~ "check after boot"
  end

  test "delayed enqueue keeps an outstanding ask and lists and cancels through the owner API", %{
    host: host
  } do
    id = oneshot(host, "tests/delayed-ask", "open")
    path = Path.join([host, ".felt", id, "delayed-ask.md"])

    File.write!(
      path,
      String.replace(
        File.read!(path),
        "  kind: oneshot",
        "  ask:\n    text: Which kernel?\n  kind: oneshot"
      )
    )

    _poller = poller!(host)
    parent = entry(host, id)
    instant = DateTime.add(DateTime.utc_now(), 3600, :second) |> DateTime.to_iso8601()

    assert {:ok, {:scheduled, ^instant}} =
             Delivery.context(parent, "later", "ask-later",
               from: "agent",
               turn: "ask",
               not_before: instant
             )

    Process.sleep(50)
    assert File.read!(path) =~ "Which kernel?"

    conn =
      Phoenix.ConnTest.build_conn()
      |> Plug.Conn.put_req_header("content-type", "application/json")

    params = %{"fiber_id" => id, "action" => "list"}
    response = ShuttleWeb.InboxController.create(conn, params)

    assert %{"entries" => [%{"id" => "ask-later", "not_before" => ^instant}]} =
             Jason.decode!(response.resp_body)

    response =
      ShuttleWeb.InboxController.create(
        conn,
        Map.merge(params, %{"action" => "cancel", "message_id" => "ask-later"})
      )

    assert response.status == 200
    assert pending(parent) == %{}
  end

  test "inbox list and cancel forward to the owner and name an unreachable owner", %{host: host} do
    alias Shuttle.Test.{Env, StubPostClient}
    _poller = poller!(host)
    StubPostClient.start!()
    Env.put_app_env(:write_forward_client, StubPostClient)
    Env.put_app_env(:remotes, [%{name: "owner-host", port: 43210}])

    for action <- ["list", "cancel"] do
      StubPostClient.set_response({:ok, 200, ~s({"entries":[]})})
      conn = Phoenix.ConnTest.build_conn()

      params = %{
        "fiber_id" => "some-uid",
        "origin" => "owner-host",
        "action" => action,
        "message_id" => "later"
      }

      response = ShuttleWeb.InboxController.create(conn, params)
      assert response.status == 200
      assert %{body: body} = StubPostClient.last()
      forwarded = Jason.decode!(body)
      assert forwarded["action"] == action
      assert forwarded["fiber_id"] == "some-uid"
      StubPostClient.set_response({:error, :unavailable})
      response = ShuttleWeb.InboxController.create(conn, params)
      assert response.status == 502
      assert response.resp_body =~ "owner-host"
    end
  end

  test "a waking message to a dormant constitution starts one session, whose first hook takes the batch",
       %{host: host} do
    id = armed(host, "tests/inbox-dormant")
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

  test "/deliver answers what a waking message to a dormant fiber did", %{host: host} do
    dormant = armed(host, "tests/inbox-route")
    closed = oneshot(host, "tests/inbox-route-closed", "closed")
    _poller = poller!(host)

    send = fn id, message_id, extra ->
      ShuttleWeb.DeliverController.route(
        id,
        "hello",
        nil,
        "shuttle://test-host/claude/sender",
        Map.merge(
          %{
            "context_only" => true,
            "message_id" => message_id,
            "wake" => true,
            "turn" => "ask",
            "unless_live" => true
          },
          extra
        )
      )
    end

    assert {202, %{status: "starting", queued: true, delivered: false}} =
             send.(dormant, "r-1", %{})

    assert launches(dormant) == 1
    assert {409, %{live: true, queued: false}} = send.(dormant, "r-2", %{})
    assert {202, %{status: "queued", detail: detail}} = send.(closed, "r-3", %{})
    assert detail =~ "is closed"

    # A quiet send queues and asks nothing of the closed fiber.
    assert {202, %{status: "queued"} = quiet} =
             send.(closed, "r-4", %{"wake" => false, "turn" => nil, "unless_live" => false})

    refute Map.has_key?(quiet, :detail)
    assert launches(closed) == 0
  end

  test "a draft, closed, resting or paused constitution keeps a waking entry without launching",
       %{
         host: host
       } do
    draft = oneshot(host, "tests/inbox-draft", "open")
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
          {draft, "is not armed"},
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
    assert Enum.map([draft, closed, resting, paused], &launches/1) == [0, 0, 0, 0]
    assert read_frontmatter(host, draft)["status"] == "open"
    assert read_frontmatter(host, closed)["status"] == "closed"
    assert read_frontmatter(host, resting)["horizon"] == "stashed"
    assert read_frontmatter(host, paused)["status"] == "open"
  end

  test "an open resume-loop breaker or launch cooldown keeps the entries waiting", %{host: host} do
    looping = armed(host, "tests/inbox-looping")
    refused = armed(host, "tests/inbox-refused")
    poller = poller!(host)
    now = DateTime.utc_now()

    :sys.replace_state(poller, fn state ->
      %{
        state
        | resume_loop:
            Map.put(state.resume_loop, entry(host, looping).fiber["uid"], %{
              count: 3,
              opened_at: now,
              fiber_id: looping,
              uid: entry(host, looping).fiber["uid"]
            }),
          dispatch_failures:
            Map.put(state.dispatch_failures, entry(host, refused).fiber["uid"], %{
              reason: {:project_dir_missing, host},
              attempts: 1,
              attempted_at: now,
              first_attempted_at: now,
              fiber_id: refused,
              uid: entry(host, refused).fiber["uid"]
            })
      }
    end)

    for {id, why} <- [{looping, "resume-loop breaker is open"}, {refused, "launch was refused"}] do
      assert {:ok, {:waiting, detail}} =
               Delivery.context(entry(host, id), "keep trying", "m-" <> id, wake: true)

      assert detail =~ why
      assert %{} = pending(entry(host, id))

      assert waking(entry(host, id)) == 1, "a refused launch reserved its entries"
    end

    for _ <- 1..2, do: poll!(poller)
    assert launches(looping) == 0
    assert launches(refused) == 0

    assert %{opened_at: ^now} =
             :sys.get_state(poller).resume_loop[entry(host, looping).fiber["uid"]]
  end

  test "the boot quarantine holds an inbox launch, drawn as held, until it is released", %{
    host: host
  } do
    id = armed(host, "tests/inbox-held")
    poller = poller!(host, boot_quarantine: true)
    parent = entry(host, id)
    assert {:ok, {:waiting, detail}} = Delivery.context(parent, "hold me", "m-held", wake: true)
    assert detail =~ "boot quarantine"
    assert [%{fiber_id: ^id}] = Poller.snapshot(poller).pending_launch
    assert %{"m-held" => %{"turn" => "ask"} = held} = pending(parent)
    refute held["attempt"]
    assert waking(parent) == 1, "a held launch reserved its entries"

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
    queued = armed(host, "tests/inbox-queued")
    id = armed(host, "tests/inbox-restart")
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

  # An armed oneshot whose worker asked the human and ended passes the gate,
  # ask and all. An outstanding ask does not gate autonomous dispatch either:
  # the Poller starts the oneshot on its own, and the message reaches that
  # worker.
  test "an armed oneshot with an outstanding ask passes the gate and is dispatched anyway", %{
    host: host
  } do
    id =
      constitution(host, "tests/inbox-asking", """
      status: active
      shuttle:
        kind: oneshot
        host: test-host
        agent: claude-sonnet
        project_dir: "#{host}"
        ask:
          text: Which kernel?
          at: "#{DateTime.to_iso8601(ago(60))}"
      """)

    write_dispatch_marker(host, id, "12345678-1234-4000-8000-000000000043", ago(120))
    write_handoff_marker(host, id, ago(60))
    assert %{"text" => "Which kernel?"} = get_in(entry(host, id).fiber, ["shuttle", "ask"])
    assert :ok = Delivery.inbox_gate(entry(host, id).fiber, "test-host")
    poller = poller!(host)
    assert launches(id) == 1

    assert {:ok, :queued} =
             Delivery.context(entry(host, id), "the kernel", "m-answer", wake: true)

    poll!(poller)
    assert launches(id) == 1
  end

  # Another writer closes the constitution while its inbox launch is being
  # dispatched: after the request's own read (the first of the Poller's three
  # reads; its final read sees it), or after the Poller's final read (the
  # dispatcher's read sees it). Either way the launch is refused and nothing
  # reopens the document.
  for n <- [1, 3] do
    test "a close landing after read #{n} of an inbox dispatch is never undone", %{host: host} do
      id = armed(host, "tests/inbox-closing")
      poller = poller!(host, runner: Shuttle.InboxLaunchTest.CloseAfterRead)
      parent = entry(host, id)
      gate = start_supervised!({Agent, fn -> 0 end})
      Shuttle.Test.Env.put_app_env(:close_after_read, {gate, unquote(n), fiber_file(host, id)})

      assert {:ok, {:waiting, detail}} =
               Delivery.context(parent, "a pending message", "m-closing", wake: true)

      assert detail =~ "is closed"
      assert Agent.get(gate, & &1) >= unquote(n)
      assert read_frontmatter(host, id)["status"] == "closed"
      refute Poller.live_worker(poller, id)
      assert launches(id) == 0

      refute Enum.any?(IntegrationRunner.commands(), fn {_, args} -> "reopen" in args end),
             "an inbox launch reopened the document"

      assert %{"m-closing" => %{"turn" => "ask"}} = pending(parent)
    end
  end

  # A close the dispatcher's own read finds refuses the launch on policy: the
  # entries wait, and no failure is recorded, so repeated refusals open no
  # launch cooldown once the author arms the fiber again.
  test "a policy refusal from the dispatcher's read is a wait, not a launch failure", %{
    host: host
  } do
    id = armed(host, "tests/inbox-policy")
    poller = poller!(host, runner: Shuttle.InboxLaunchTest.CloseAfterRead)
    key = entry(host, id).fiber["uid"]
    gate = start_supervised!({Agent, fn -> 0 end})
    Shuttle.Test.Env.put_app_env(:close_after_read, {gate, 3, fiber_file(host, id)})

    for n <- 1..2 do
      Agent.update(gate, fn _ -> 0 end)

      assert {:ok, {:waiting, detail}} =
               Delivery.context(entry(host, id), "message #{n}", "m-policy-#{n}", wake: true)

      assert detail =~ "is closed"
      assert read_frontmatter(host, id)["status"] == "closed"
      refute :sys.get_state(poller).dispatch_failures[key]

      # The author arms it again before any poll sees it closed.
      path = fiber_file(host, id)
      File.write!(path, String.replace(File.read!(path), "status: closed", "status: active"))
      lapse_leases()
    end

    Shuttle.Test.Env.put_app_env(:close_after_read, nil)
    assert :ok = Poller.admit_inbox_launch(poller, key)
    assert launches(id) == 0
  end

  # Short standing runs that each take their message and hand off are not a
  # crash loop: each ends the sequence, so five in a row open no breaker.
  test "standing runs that took their messages and handed off do not open the breaker", %{
    host: host
  } do
    id = armed(host, "tests/inbox-delivered")
    poller = poller!(host)
    key = entry(host, id).fiber["uid"]

    for n <- 1..5 do
      parent = entry(host, id)

      assert {:ok, :starting} =
               Delivery.context(parent, "message #{n}", "m-delivered-#{n}", wake: true)

      %{session_uuid: uuid} = Poller.live_worker(poller, id)
      assert hook!(uuid) =~ "message #{n}"
      assert pending(parent) == %{}
      write_handoff_marker(host, id)
      %{pid: watcher, session: session} = :sys.get_state(poller).running[key]
      IntegrationRunner.remove_tmux_session(session)
      send(poller, {:worker_exited, id, watcher, session, :normal_exit})
      refute :sys.get_state(poller).resume_loop[key]
    end

    assert :ok = Poller.admit_inbox_launch(poller, key)
  end

  # An inbox launch is not a human's override: a retry after the breaker's
  # cooldown keeps its count, so a worker that dies at once reopens it.
  test "an inbox retry after the breaker's cooldown that dies at once reopens the breaker", %{
    host: host
  } do
    id = oneshot(host, "tests/inbox-breaker", "active")
    poller = poller!(host, max_concurrent_workers: 0)
    key = entry(host, id).fiber["uid"]

    :sys.replace_state(poller, fn state ->
      %{
        state
        | max_concurrent_workers: 10,
          resume_loop:
            Map.put(state.resume_loop, key, %{
              count: 5,
              opened_at: DateTime.add(DateTime.utc_now(), -601, :second),
              fiber_id: id,
              uid: key
            })
      }
    end)

    assert {:ok, :starting} = Delivery.context(entry(host, id), "retry", "m-breaker", wake: true)
    assert %{count: 5} = :sys.get_state(poller).resume_loop[key]

    %{pid: watcher, session: session} = :sys.get_state(poller).running[key]
    IntegrationRunner.remove_tmux_session(session)
    send(poller, {:worker_exited, id, watcher, session, :normal_exit})

    assert %{count: 6, opened_at: %DateTime{} = opened} =
             :sys.get_state(poller).resume_loop[key]

    assert DateTime.diff(DateTime.utc_now(), opened, :second) < 10
  end

  # A standing run started for messages is restarted outside the schedule, so
  # its rapid exits count toward the breaker that then holds the next one.
  test "rapid exits of standing runs started for messages open the breaker", %{host: host} do
    id = armed(host, "tests/inbox-standing-loop")
    poller = poller!(host)
    key = entry(host, id).fiber["uid"]

    :sys.replace_state(poller, fn state ->
      %{
        state
        | resume_loop:
            Map.put(state.resume_loop, key, %{count: 4, opened_at: nil, fiber_id: id, uid: key})
      }
    end)

    assert {:ok, :starting} = Delivery.context(entry(host, id), "again", "m-loop-1", wake: true)
    %{pid: watcher, session: session} = :sys.get_state(poller).running[key]
    IntegrationRunner.remove_tmux_session(session)
    send(poller, {:worker_exited, id, watcher, session, :normal_exit})
    assert %{count: 5, opened_at: %DateTime{}} = :sys.get_state(poller).resume_loop[key]

    lapse_leases()

    assert {:ok, {:waiting, detail}} =
             Delivery.context(entry(host, id), "and again", "m-loop-2", wake: true)

    assert detail =~ "resume-loop breaker is open"
    assert launches(id) == 1
  end
end
