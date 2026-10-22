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
      if Shuttle.Env.app(:receiver_documents_unavailable, false) and "ls" in args,
        do: {"documents unavailable", :timeout},
        else: Shuttle.Runner.Default.cmd("shuttle", args, opts)
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
