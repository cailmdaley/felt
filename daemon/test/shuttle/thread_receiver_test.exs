defmodule Shuttle.ThreadReceiverTest do
  use ExUnit.Case, async: true
  alias Shuttle.{CLI, Delivery, Dispatcher, FiberDocuments, Poller, Test.Env}
  import Shuttle.Test.PollerHelpers
  @moduletag :tmp_dir
  @moduletag skip: is_nil(System.find_executable("tmux"))

  defmodule IsolatedRunner do
    @behaviour Shuttle.Runner
    # The private tmux server is the test's entire worker world, including
    # process-scan fallback. Never discover workers in the operator's server.
    def cmd("ps", _args, _opts), do: {"", 0}

    def cmd("tmux", ["ls" | _] = args, opts) do
      if Shuttle.Env.app(:receiver_scan_unknown, false),
        do: {"scan unavailable", :timeout},
        else: Shuttle.Runner.Default.cmd("tmux", args, opts)
    end

    def cmd("shuttle", args, opts) do
      if spy = Shuttle.Env.app(:receiver_spy, nil),
        do: if("context-mailbox" in args, do: send(spy, {:context_mailbox, args}))

      cond do
        Shuttle.Env.app(:receiver_runtime_write_fails, false) and "mark-runtime" in args ->
          {"injected runtime write failure", 1}

        Shuttle.Env.app(:receiver_documents_unavailable, false) and "ls" in args ->
          {"documents unavailable", :timeout}

        # A merged stderr line ahead of the stdout the daemon parses.
        Shuttle.Env.app(:receiver_stderr_noise, false) and "context-mailbox" in args ->
          {output, status} = Shuttle.Runner.Default.cmd("shuttle", args, opts)
          {"warning: injected stderr line\n" <> output, status}

        true ->
          Shuttle.Runner.Default.cmd("shuttle", args, opts)
      end
    end

    def cmd(command, args, opts), do: Shuttle.Runner.Default.cmd(command, args, opts)
  end

  setup %{tmp_dir: dir} do
    home = Path.join(dir, "home")
    data = Path.join(dir, "data")
    bin = Path.join(dir, "bin")
    Enum.each([home, data, bin], &File.mkdir_p!/1)
    Env.put_env("HOME", home)
    Env.put_env("SHUTTLE_DATA_DIR", data)
    Env.put_env("SHUTTLE_HOST", "test-host")
    Env.put_env("SHUTTLE_STORES", dir)
    Env.delete_env("TMUX")
    Env.delete_env("SHUTTLE_FIBER_PATH")
    Env.put_app_env(:felt_runner, IsolatedRunner)
    tmux = Shuttle.Env.find_executable("tmux")
    socket = Path.join(System.tmp_dir!(), "receiver-#{System.unique_integer([:positive])}.sock")

    File.write!(
      Path.join(bin, "tmux"),
      "#!/bin/sh\nexec '#{tmux}' -S '#{socket}' -f /dev/null \"$@\"\n"
    )

    File.chmod!(Path.join(bin, "tmux"), 0o700)
    Env.prepend_path(bin)

    on_exit(fn ->
      Shuttle.Env.cmd(tmux, ["-S", socket, "kill-server"], stderr_to_stdout: true)
    end)

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

    assert {:ok, json} = CLI.run_in_store(dir, ["show", "hub", "--json"])
    uid = Jason.decode!(json)["uid"]

    {:ok,
     store: dir,
     data: data,
     key: dir <> ":" <> uid,
     canonical: Dispatcher.session_name("hub", uid)}
  end

  for predecessor <- [nil, "A"] do
    @tag predecessor: predecessor
    test "claim binds supplied UUID before returning with prior runtime #{inspect(predecessor)}",
         context do
      %{store: store, data: data, key: key, predecessor: predecessor} = context

      if predecessor do
        assert {:ok, _} =
                 CLI.run_in_store(store, ["mark-runtime", "hub", "--session", predecessor])
      end

      start_tmux!("capture-B")
      poller = start_poller_for!(store)
      await_boot_cycle!(poller)
      # Subscribe A after boot to reproduce a genuinely authorized predecessor,
      # rather than merely an old UUID in frontmatter.
      if predecessor, do: seed_receiver!(store, key, "old-worker:A", "A")

      assert {:ok, _} =
               CLI.run(["context-mailbox", "put", key, "claim-result", "Only B can read this"])

      cycles = :sys.get_state(poller).poll_cycles
      assert {:ok, _} = Poller.claim_session(poller, "hub", "capture-B", session_uuid: "B")
      assert %{session_uuid: "B"} = Poller.live_worker(poller, "hub")
      authority = authority!(data)
      assert authority["ID"] == "B"
      assert authority["identity"] == context.canonical <> ":B"
      assert :sys.get_state(poller).poll_cycles == cycles
      # No poll, restart or flush may be needed to revoke A.
      refute hook!(store, "A") =~ "Only B can read this"
      assert [_] = pending(data)
      assert {:ok, %{fibers: [parent]}} = FiberDocuments.get_shuttle("hub", felt_stores: [store])
      # Claim establishes authority even before B's harness registers hooks.
      assert {:command_error, 1, detail} = Delivery.flush_context(parent)
      assert detail =~ "session has not registered"
      assert authority!(data) == authority
      hook!(store, "B")
      assert {:ok, _} = Delivery.flush_context(parent)
      assert hook!(store, "B") =~ "Only B can read this"
      assert pending(data) == []
      refute hook!(store, "B") =~ "Only B can read this"
      assert authority!(data) == authority
      drain_results!(poller)
    end
  end

  test "successful claim recovers durable B after runtime persistence fails, then repairs its mirror",
       context do
    %{store: store, data: data, key: key} = context
    assert {:ok, _} = CLI.run_in_store(store, ["mark-runtime", "hub", "--session", "A"])
    start_tmux!("capture-B")
    poller = start_poller_for!(store)
    await_boot_cycle!(poller)
    seed_receiver!(store, key, "old-worker:A", "A")
    Env.put_app_env(:receiver_runtime_write_fails, true)
    assert {:ok, _} = Poller.claim_session(poller, "hub", "capture-B", session_uuid: "B")
    assert %{session_uuid: "B"} = Poller.live_worker(poller, "hub")
    committed = authority!(data)
    assert committed["ID"] == "B"
    state = :sys.get_state(poller)
    worker = state.running[Poller.running_key(state, "hub")]
    assert worker.identity_error =~ "injected runtime write failure"
    assert {:ok, json} = CLI.run_in_store(store, ["show", "hub", "--json"])
    assert get_in(Jason.decode!(json), ["shuttle", "runtime", "session_uuid"]) == "A"

    assert {:ok, _} =
             CLI.run(["context-mailbox", "put", key, "persist-result", "Durable B context"])

    drain_results!(poller)
    GenServer.stop(poller)
    poller = start_poller_for!(store)
    await_boot_cycle!(poller)
    assert %{session_uuid: "B"} = Poller.live_worker(poller, "hub")
    assert authority!(data) == committed
    refute hook!(store, "A") =~ "Durable B context"
    assert [_] = pending(data)
    # Recovery remains B through repeated failed mirror writes.
    cycle!(poller)
    assert authority!(data) == committed
    Env.put_app_env(:receiver_runtime_write_fails, false)
    cycle!(poller)
    assert {:ok, json} = CLI.run_in_store(store, ["show", "hub", "--json"])
    assert get_in(Jason.decode!(json), ["shuttle", "runtime", "session_uuid"]) == "B"
    assert authority!(data) == committed
    state = :sys.get_state(poller)
    refute Map.has_key?(state.running[Poller.running_key(state, "hub")], :identity_error)
    hook!(store, "B")
    assert {:ok, %{fibers: [parent]}} = FiberDocuments.get_shuttle("hub", felt_stores: [store])
    assert {:ok, _} = Delivery.flush_context(parent)
    assert hook!(store, "B") =~ "Durable B context"
    assert pending(data) == []
    drain_results!(poller)
  end

  test "durable unknown receiver cannot recover predecessor A when runtime clearing fails",
       context do
    %{store: store, data: data, key: key, canonical: canonical} = context
    assert {:ok, _} = CLI.run_in_store(store, ["mark-runtime", "hub", "--session", "A"])
    start_tmux!(canonical)
    seed_receiver!(store, key, canonical <> ":A", "A")
    assert {:ok, _} = CLI.run(["context-mailbox", "receiver", key, canonical <> ":-", "-"])
    Env.put_app_env(:receiver_runtime_write_fails, true)

    assert {:error, _} =
             Shuttle.Continuation.backfill_session_uuid(IsolatedRunner, store, "hub", "")

    committed = authority!(data)
    poller = start_poller_for!(store)
    await_boot_cycle!(poller)
    assert %{session_uuid: nil} = Poller.live_worker(poller, "hub")
    assert authority!(data) == committed

    assert {:ok, _} =
             CLI.run([
               "context-mailbox",
               "put",
               key,
               "unknown-result",
               "Wait for identity capture"
             ])

    refute hook!(store, "A") =~ "Wait for identity capture"
    assert [_] = pending(data)
    drain_results!(poller)
  end

  for uuid <- ["B", nil] do
    @tag receiver_uuid: uuid
    test "unresolved agent recovery preserves durable receiver #{inspect(uuid)} without runtime A fallback",
         context do
      %{store: store, data: data, key: key, canonical: canonical, receiver_uuid: uuid} = context
      registry = Path.join(store, "agents.json")

      manifest = %{
        version: 1,
        builtins: "restrict",
        agents: [%{id: "receiver-custom", cli: "claude", model: "opus", wrapper: "bin/claude"}]
      }

      File.write!(registry, Jason.encode!(manifest))
      Env.put_env("SHUTTLE_AGENTS_FILE", registry)

      assert {:ok, _} =
               CLI.run_in_store(store, ["set-model", "hub", "receiver-custom", "--local"])

      assert {:ok, _} = CLI.run_in_store(store, ["mark-runtime", "hub", "--session", "A"])
      start_tmux!("capture-B")
      poller = start_poller_for!(store)
      await_boot_cycle!(poller)
      assert {:ok, _} = Poller.claim_session(poller, "hub", "capture-B", session_uuid: uuid)
      committed = authority!(data)
      # A stale mirror must not become a fallback when registry resolution vanishes.
      assert {:ok, _} = CLI.run_in_store(store, ["mark-runtime", "hub", "--session", "A"])
      File.write!(registry, Jason.encode!(%{manifest | agents: []}))
      assert {:ok, json} = CLI.run_in_store(store, ["show", "hub", "--json"])
      unresolved = Jason.decode!(json)
      assert get_in(unresolved, ["shuttle", "resolved", "agent"]) == nil
      assert get_in(unresolved, ["shuttle", "agent"]) == "receiver-custom"
      cycle!(poller)
      assert %{session_uuid: ^uuid, cli: nil} = Poller.live_worker(poller, "hub")
      assert authority!(data) == committed
      # Retain stale A across restart too, not just the healthy mirror repaired above.
      assert {:ok, _} = CLI.run_in_store(store, ["mark-runtime", "hub", "--session", "A"])
      drain_results!(poller)
      GenServer.stop(poller)
      poller = start_poller_for!(store)
      await_boot_cycle!(poller)
      assert %{session_uuid: ^uuid, cli: nil} = Poller.live_worker(poller, "hub")
      assert authority!(data) == committed
      assert {:ok, %{fibers: [entry]}} = Poller.cached_fiber_documents(poller)
      assert get_in(entry.fiber, ["shuttle", "resolved", "agent"]) == nil
      assert get_in(entry.fiber, ["shuttle", "agent"]) == "receiver-custom"

      assert {:ok, _} =
               CLI.run(["context-mailbox", "put", key, "unresolved-result", "Never authorize A"])

      refute hook!(store, "A") =~ "Never authorize A"
      assert [_] = pending(data)
      # Polling, mirror repair, the snapshot and delivery must all tolerate the missing agent.
      cycle!(poller)
      assert is_map(Poller.snapshot(poller))

      # Delivery follows the committed address, so a vanished registry entry
      # does not stall results for the live receiver.
      if uuid, do: hook!(store, uuid)
      assert {:ok, _} = Delivery.flush_context(entry)
      assert Process.alive?(poller)
      assert authority!(data) == committed
      refute hook!(store, "A") =~ "Never authorize A"

      if uuid do
        assert hook!(store, uuid) =~ "Never authorize A"
        assert pending(data) == []
      else
        assert [_] = pending(data)
      end

      # The other absent shapes of the optional resolved view obey the same contract.
      state = :sys.get_state(poller)
      worker = state.running[Poller.running_key(state, "hub")]

      for resolved <- [
            nil,
            %{},
            %{"agent" => nil},
            %{"agent" => %{}},
            %{"agent" => %{"cli" => nil}}
          ] do
        fiber = put_in(unresolved, ["shuttle", "resolved"], resolved)
        recovered = Poller.recover_context_receiver(state, worker, fiber)
        assert recovered.session_uuid == uuid
        Poller.put_running(state, Poller.running_key(state, "hub"), recovered)
        assert authority!(data) == committed
      end

      File.write!(registry, Jason.encode!(manifest))
      cycle!(poller)
      assert %{session_uuid: ^uuid, cli: "claude"} = Poller.live_worker(poller, "hub")
      assert authority!(data) == committed

      if uuid == nil do
        assert {:ok, _} = Poller.claim_session(poller, "hub", canonical, session_uuid: "B")
      end

      if uuid == nil do
        hook!(store, "B")

        assert {:ok, %{fibers: [parent]}} =
                 FiberDocuments.get_shuttle("hub", felt_stores: [store])

        assert {:ok, _} = Delivery.flush_context(parent)
        assert hook!(store, "B") =~ "Never authorize A"
      end

      assert pending(data) == []
      drain_results!(poller)
    end
  end

  for live? <- [false, true] do
    @tag live?: live?
    test "deferred authority recovery waits for healthy scan and documents with live worker #{live?}",
         context do
      %{store: store, data: data, key: key, live?: live?, canonical: canonical} = context
      assert {:ok, _} = CLI.run_in_store(store, ["mark-runtime", "hub", "--session", "A"])
      seed_receiver!(store, key, canonical <> ":A", "A")
      initial = authority!(data)
      start_tmux!(if live?, do: canonical, else: "anchor")
      Env.put_app_env(:receiver_scan_unknown, true)
      poller = start_poller_for!(store)
      await_boot_cycle!(poller)
      assert authority!(data) == initial
      refute :sys.get_state(poller).adopted?
      Env.put_app_env(:receiver_documents_unavailable, true)
      Env.put_app_env(:receiver_scan_unknown, false)
      cycle!(poller)
      assert authority!(data) == initial
      refute :sys.get_state(poller).adopted?
      assert :sys.get_state(poller).document_cache_partial
      Env.put_app_env(:receiver_documents_unavailable, false)
      cycle!(poller)
      state = :sys.get_state(poller)
      refute state.document_cache_partial

      assert {:ok, _} =
               CLI.run(["context-mailbox", "put", key, "recovery-result", "Recovery context"])

      if live? do
        assert %{session_uuid: "A"} = Poller.live_worker(poller, "hub")
        assert authority!(data) == initial
        assert hook!(store, "A") =~ "Recovery context"
        assert pending(data) == []
      else
        assert state.running == %{}
        authority = authority!(data)
        refute hook!(store, "A") =~ "Recovery context"
        assert [_] = pending(data)
        assert authority["identity"] == ""
        assert authority["generation"] > initial["generation"]
        # Recovery completes once; steady healthy polls do not rotate epochs.
        cycle!(poller)
        assert authority!(data) == authority
      end

      assert state.adopted?
    end
  end

  test "a corrupt receiver record fails closed for its fiber without crashing the Poller",
       context do
    %{store: store, data: data, key: key, canonical: canonical} = context
    assert {:ok, _} = CLI.run_in_store(store, ["mark-runtime", "hub", "--session", "A"])
    hook!(store, "A")
    start_tmux!(canonical)
    root = Path.join([data, "mailboxes", "fiber", mailbox_key(key)])
    File.mkdir_p!(root)
    File.write!(Path.join(root, "destination.json"), "{corrupt")

    log =
      ExUnit.CaptureLog.capture_log(fn ->
        poller = start_poller_for!(store)
        await_boot_cycle!(poller)
        cycle!(poller)
        send(self(), {:poller, poller})
      end)

    assert_received {:poller, poller}
    assert Process.alive?(poller)
    assert log =~ "receiver authority unknown for hub"
    assert log =~ "invalid character"
    state = :sys.get_state(poller)
    worker = state.running[Poller.running_key(state, "hub")]
    assert worker.session == canonical
    assert worker.context_epoch == nil
    # Unknown authority never falls back to the frontmatter predecessor.
    assert %{session_uuid: nil} = Poller.live_worker(poller, "hub")
    assert {:ok, _} = CLI.run(["context-mailbox", "put", key, "corrupt-result", "Hold for B"])
    assert {:ok, %{fibers: [parent]}} = FiberDocuments.get_shuttle("hub", felt_stores: [store])
    assert {:error, :authority_unknown} = Delivery.flush_context(parent)
    refute hook!(store, "A") =~ "Hold for B"
    assert [_] = pending(data)
    assert File.read!(Path.join(root, "destination.json")) == "{corrupt"
    drain_results!(poller)
  end

  test "stderr lines merged into receiver CLI output do not break authority", context do
    %{store: store, data: data} = context
    start_tmux!("capture-B")
    poller = start_poller_for!(store)
    await_boot_cycle!(poller)
    Env.put_app_env(:receiver_stderr_noise, true)
    assert {:ok, _} = Poller.claim_session(poller, "hub", "capture-B", session_uuid: "B")
    state = :sys.get_state(poller)
    worker = state.running[Poller.running_key(state, "hub")]
    assert worker.context_epoch == authority!(data)["generation"]
    assert authority!(data)["ID"] == "B"
    GenServer.stop(poller)
    poller = start_poller_for!(store)
    await_boot_cycle!(poller)
    assert %{session_uuid: "B"} = Poller.live_worker(poller, "hub")
    drain_results!(poller)
  end

  test "a restart between the claim rename and its publish recovers the successor, never A",
       context do
    %{store: store, data: data, key: key, canonical: canonical} = context
    # Predecessor A held authority in the canonical session, exited, and was
    # revoked; its runtime mirror still names A.
    assert {:ok, _} = CLI.run_in_store(store, ["mark-runtime", "hub", "--session", "A"])
    seed_receiver!(store, key, canonical <> ":A", "A")
    assert {:ok, _} = CLI.run(["context-mailbox", "receiver", key, "", "-"])
    revoked = authority!(data)
    # Claim of B renamed its session to the canonical name, then the daemon
    # died before put_running published B.
    start_tmux!(canonical)
    poller = start_poller_for!(store)
    await_boot_cycle!(poller)
    assert %{session: ^canonical, session_uuid: nil} = Poller.live_worker(poller, "hub")
    recovered = authority!(data)
    assert recovered["identity"] == canonical <> ":-"
    assert recovered["ID"] in [nil, ""]
    assert recovered["generation"] > revoked["generation"]

    assert {:ok, _} =
             CLI.run(["context-mailbox", "put", key, "window-result", "Successor only"])

    cycle!(poller)
    refute hook!(store, "A") =~ "Successor only"
    assert [_] = pending(data)
    # The retried claim completes the successor's lineage.
    assert {:ok, _} = Poller.claim_session(poller, "hub", canonical, session_uuid: "B")
    assert authority!(data)["ID"] == "B"
    hook!(store, "B")
    assert {:ok, %{fibers: [parent]}} = FiberDocuments.get_shuttle("hub", felt_stores: [store])
    assert {:ok, _} = Delivery.flush_context(parent)
    assert hook!(store, "B") =~ "Successor only"
    refute hook!(store, "A") =~ "Successor only"
    drain_results!(poller)
  end

  test "boot revocation creates no state for an inactive fiber without a mailbox", context do
    %{store: store, data: data} = context

    keys =
      for {slug, status} <- [done: "closed", gone: "closed", live: "active"], into: %{} do
        slug = Atom.to_string(slug)
        assert {:ok, _} = CLI.run_felt(["-C", store, "add", slug, slug])

        assert {:ok, _} =
                 CLI.run_in_store(store, [
                   "install",
                   slug,
                   "--host",
                   "test-host",
                   "--project-dir",
                   store | if(status == "active", do: [], else: ["--disabled"])
                 ])

        if status == "closed",
          do: assert({:ok, _} = CLI.run_felt(["-C", store, "edit", slug, "-s", "closed"]))

        assert {:ok, json} = CLI.run_in_store(store, ["show", slug, "--json"])
        {slug, store <> ":" <> Jason.decode!(json)["uid"]}
      end

    seed_receiver!(store, keys["gone"], "old-worker:G", "G")
    seeded = mailbox_record(data, keys["gone"])
    Env.put_app_env(:receiver_spy, self())
    poller = start_poller_for!(store)
    await_boot_cycle!(poller)
    assert :sys.get_state(poller).adopted?
    # One batched revocation per kind, never one spawn per listed fiber.
    revocations =
      for {:context_mailbox, ["context-mailbox", verb | _]} <- flush_messages(), do: verb

    assert Enum.count(revocations, &(&1 == "revoke")) <= 2
    refute "receiver" in revocations
    refute File.exists?(Path.join([data, "mailboxes", "fiber", mailbox_key(keys["done"])]))
    refute File.exists?(Path.join([data, "mailboxes", "fiber", mailbox_key(context.key)]))
    revoked = mailbox_record(data, keys["gone"])
    assert revoked["identity"] == ""
    assert revoked["generation"] > seeded["generation"]
    # An active fiber is fenced durably even before its first worker.
    assert mailbox_record(data, keys["live"])["identity"] == ""
    drain_results!(poller)
  end

  defp flush_messages(acc \\ []) do
    receive do
      message -> flush_messages([message | acc])
    after
      0 -> Enum.reverse(acc)
    end
  end

  defp mailbox_record(data, key) do
    Path.join([data, "mailboxes", "fiber", mailbox_key(key), "destination.json"])
    |> File.read!()
    |> Jason.decode!()
  end

  defp mailbox_key(key), do: :crypto.hash(:sha256, key) |> Base.encode16(case: :lower)

  defp start_poller_for!(store) do
    {:ok, poller} =
      start_poller!(
        runner: IsolatedRunner,
        own_host_id: "test-host",
        felt_stores: [store],
        boot_quarantine: true,
        poll_interval_ms: 600_000
      )

    poller
  end

  defp start_tmux!(session) do
    assert {_, 0} =
             IsolatedRunner.cmd("tmux", ["new-session", "-d", "-s", session, "sleep", "300"], [])
  end

  defp seed_receiver!(store, key, identity, uuid) do
    hook!(store, uuid)

    assert {:ok, epoch} =
             CLI.run([
               "context-mailbox",
               "receiver",
               key,
               identity,
               "shuttle://test-host/claude/#{uuid}"
             ])

    assert {:ok, _} =
             CLI.run([
               "context-mailbox",
               "deliver",
               key,
               "shuttle://test-host/claude/#{uuid}",
               String.trim(epoch)
             ])
  end

  defp hook!(store, uuid) do
    cli = Shuttle.Env.find_executable("shuttle")

    frame =
      Jason.encode!(%{
        session_id: uuid,
        hook_event_name: "SessionStart",
        harness: "claude",
        cwd: store
      })

    assert {output, 0} =
             Shuttle.Env.cmd("bash", [
               "--noprofile",
               "--norc",
               "-c",
               "printf '%s\\n' '#{frame}' | '#{cli}' hook event"
             ])

    output
  end

  defp authority!(data) do
    [path] = Path.wildcard(Path.join(data, "mailboxes/fiber/*/destination.json"))
    path |> File.read!() |> Jason.decode!()
  end

  defp pending(data), do: Path.wildcard(Path.join(data, "mailboxes/fiber/*/pending/*.json"))

  defp cycle!(poller) do
    previous = :sys.get_state(poller).poll_cycles
    send(poller, :run_poll_cycle)
    await_cycle!(poller, previous, 3_000)
    drain_results!(poller)
  end

  defp drain_results!(poller) do
    # Poll completion schedules delivery tasks. Finish only this Poller's tasks
    # before assertions/teardown, without waiting on concurrent tests' work.
    for pid <- Task.Supervisor.children(Shuttle.TaskSupervisor),
        {:dictionary, dict} <- [Process.info(pid, :dictionary)],
        poller in Keyword.get(dict, :"$callers", []) do
      ref = Process.monitor(pid)
      assert_receive {:DOWN, ^ref, :process, ^pid, reason}
      assert reason in [:normal, :noproc]
    end
  end

  defp await_cycle!(poller, previous, attempts) do
    state = :sys.get_state(poller, 30_000)

    cond do
      state.poll_cycles > previous and not state.poll_check_in_progress ->
        :ok

      attempts == 0 ->
        flunk("poll cycle never completed")

      true ->
        Process.sleep(10)
        await_cycle!(poller, previous, attempts - 1)
    end
  end
end
