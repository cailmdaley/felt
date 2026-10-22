defmodule Shuttle.ThreadsTest do
  use ExUnit.Case, async: true
  alias Shuttle.{CLI, FiberDocuments, Threads, Test.Env}
  @moduletag :tmp_dir

  defmodule SocketRunner do
    @behaviour Shuttle.Runner
    def cmd("bash", ["-l" | args], opts),
      do: Shuttle.Runner.Default.cmd("bash", ["--noprofile", "--norc" | args], opts)

    def cmd(command, args, opts), do: Shuttle.Runner.Default.cmd(command, args, opts)
  end

  setup %{tmp_dir: dir} do
    home = Path.join(dir, "home")
    data = Path.join(dir, "data")
    File.mkdir_p!(home)
    File.mkdir_p!(data)
    Env.delete_env("TMUX")
    Env.delete_env("SHUTTLE_FIBER_PATH")
    Env.put_env("HOME", home)
    Env.put_env("SHUTTLE_DATA_DIR", data)
    Env.put_env("SHUTTLE_HOST", "test-host")
    Env.put_env("SHUTTLE_STORES", dir)
    Env.put_app_env(:felt_runner, Shuttle.Runner.Default)
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

    assert {:ok, _} =
             CLI.run_in_store(dir, [
               "thread",
               "hub",
               "Investigate",
               "--slug",
               "child",
               "--disabled"
             ])

    {:ok, store: dir, data: data}
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

  test "fresh, resume and standing prompts identify the nearest current orchestrator", %{
    store: store
  } do
    assert {:ok, _} = CLI.run_felt(["-C", store, "add", "hub/notes", "Notes"])
    assert {:ok, _} = CLI.run_felt(["-C", store, "add", "hub/notes/deep", "Deep"])

    for prompt <- [
          Shuttle.Dispatcher.render_prompt("hub/notes/deep", felt_store: store),
          Shuttle.Dispatcher.render_resume_prompt("hub/notes/deep", felt_store: store),
          Shuttle.Dispatcher.render_standing_run_prompt("hub/notes/deep", "run-1",
            felt_store: store
          )
        ] do
      assert prompt =~ "You are a thread of hub (Hub)."

      assert prompt =~
               "Your outcome is delivered to that orchestrator when you close or ask; write it for that reader."
    end

    assert {:ok, _} =
             CLI.run_in_store(store, ["install", "hub/notes", "--disabled", "--host", "test-host"])

    assert Shuttle.Dispatcher.render_prompt("hub/notes/deep", felt_store: store) =~
             "thread of hub/notes (Notes)"

    refute Shuttle.Dispatcher.render_prompt("hub", felt_store: store) =~ "You are a thread"
  end

  test "a non-owning mirror cannot publish results or queue parent context", %{
    store: store,
    data: data
  } do
    assert {:ok, _} = CLI.run_in_store(store, ["close", "hub/child", "--local"])
    assert {:ok, %{fibers: entries}} = FiberDocuments.list(felt_stores: [store])
    Threads.deliver_results(entries, "another-host")
    assert pending(data) == []
    [parent | _] = Enum.filter(entries, &(Threads.address(&1.fiber) == "hub"))
    parent = put_in(parent.fiber["shuttle"]["host"], "another-host")
    assert {:error, :not_owner} = Shuttle.Delivery.context(parent, "not here", "no")
    assert pending(data) == []
  end

  @tag skip: is_nil(System.find_executable("tmux"))
  test "an isolated daemon dispatches a real tmux process and offers dormant and live results once",
       %{store: store, data: data} do
    alias Shuttle.Poller
    import Shuttle.Test.PollerHelpers
    socket = Path.join(System.tmp_dir!(), "th-#{System.unique_integer([:positive])}.sock")
    bin = Path.join(store, "bin")
    File.mkdir_p!(bin)
    real_tmux = Shuttle.Env.find_executable("tmux")

    File.write!(
      Path.join(bin, "tmux"),
      "#!/bin/sh\nexec '#{real_tmux}' -S '#{socket}' -f /dev/null \"$@\"\n"
    )

    File.chmod!(Path.join(bin, "tmux"), 0o700)
    Env.prepend_path(bin)

    File.write!(
      Path.join(Shuttle.Env.home(), ".bash_profile"),
      "export PATH='#{bin}:#{Shuttle.Env.get("PATH")}'\n"
    )

    Env.put_app_env(:felt_runner, SocketRunner)
    Env.put_app_env(:os_type, {:unix, :linux})
    wrapper = Path.join(store, "receiver")
    cli = Shuttle.Env.find_executable("shuttle")
    gate = Path.join(store, "gate")
    assert {_, 0} = Shuttle.Env.cmd("mkfifo", [gate])
    native_dir = Path.join(System.tmp_dir!(), "tn-#{System.unique_integer([:positive])}")
    File.mkdir_p!(native_dir)
    File.chmod!(native_dir, 0o700)
    native_socket = Path.join(native_dir, "s")
    transcript = Path.join(store, "native.jsonl")
    File.write!(transcript, "")

    {:ok, listener} =
      :gen_tcp.listen(0, [:binary, active: false, packet: :line, ifaddr: {:local, native_socket}])

    File.chmod!(native_socket, 0o600)
    test_pid = self()

    start_supervised!(
      {Task, fn -> native_receiver(listener, transcript, Path.join(store, "ready"), test_pid) end}
    )

    on_exit(fn ->
      :gen_tcp.close(listener)
      File.rm_rf(native_dir)
    end)

    # This deterministic harness stand-in executes the real message hooks in
    # a real tmux pane; no transport or lifecycle call is mocked.
    File.write!(wrapper, """
    #!/bin/bash
    export HOME='#{Shuttle.Env.home()}' SHUTTLE_DATA_DIR='#{data}' SHUTTLE_HOST=test-host
    export CLAUDE_CODE_MESSAGING_SOCKET='#{native_socket}'
    while [ "$#" -gt 0 ]; do
      if [ "$1" = --session-id ]; then uuid="$2"; shift; fi
      shift
    done
    hook() {
      printf '{"session_id":"%s","hook_event_name":"%s","harness":"claude","transcript_path":"#{transcript}","cwd":"#{store}"}\\n' "$uuid" "$1" | '#{cli}' hook event >> '#{store}/received'
    }
    hook SessionStart
    echo "$uuid" > '#{store}/ready'
    while read line < '#{gate}'; do hook UserPromptSubmit; echo done >> '#{store}/rounds'; done
    """)

    File.chmod!(wrapper, 0o700)
    registry = Path.join(store, "agents.json")

    File.write!(
      registry,
      Jason.encode!(%{
        version: 1,
        agents: [
          %{id: "claude-opus", cli: "claude", model: "opus", wrapper: wrapper, default: true}
        ]
      })
    )

    Env.put_env("SHUTTLE_AGENTS_FILE", registry)
    assert {:ok, _} = CLI.run_in_store(store, ["set-model", "hub", "claude-opus", "--local"])
    assert {:ok, _} = CLI.run_in_store(store, ["close", "hub/child", "--local"])
    assert {:ok, %{fibers: entries}} = FiberDocuments.list(felt_stores: [store])
    Threads.deliver_results(entries, "test-host")
    assert [_] = pending(data)

    assert {_, 0} =
             SocketRunner.cmd("tmux", ["new-session", "-d", "-s", "anchor", "sleep", "300"], [])

    assert {actual_socket, 0} =
             SocketRunner.cmd("tmux", ["display-message", "-p", "\#{socket_path}"], [])

    assert String.trim(actual_socket) == socket

    on_exit(fn ->
      Shuttle.Env.cmd("tmux", ["-S", socket, "kill-server"], stderr_to_stdout: true)
    end)

    {:ok, poller} =
      start_poller!(
        runner: SocketRunner,
        own_host_id: "test-host",
        felt_stores: [store],
        boot_quarantine: true,
        poll_interval_ms: 600_000
      )

    await_boot_cycle!(poller)
    assert {:ok, _session} = Poller.dispatch_fiber(poller, "hub", force: true)
    await(fn -> File.exists?(Path.join(store, "ready")) end)

    await(fn ->
      match?(%{session_uuid: id} when is_binary(id), Poller.live_worker(poller, "hub"))
    end)

    assert {:ok, %{fibers: entries}} = FiberDocuments.list(felt_stores: [store])
    Threads.deliver_results(entries, "test-host")
    parent = Enum.find(entries, &(Threads.address(&1.fiber) == "hub"))
    assert {:ok, _} = Shuttle.Delivery.flush_context(parent)
    assert [_] = pending(data)
    first_native = File.read!(Path.join(store, "ready")) |> String.trim()
    # Replace A while its result is still waiting for a hook. The successor
    # offers the same fiber mailbox; no copy is stranded in A's session queue.
    assert {:ok, _} = Poller.lifecycle_transition(poller, :rest, "hub", [])
    File.rm!(Path.join(store, "ready"))
    assert {:ok, _} = Poller.dispatch_fiber(poller, "hub", force: true)
    await(fn -> File.exists?(Path.join(store, "ready")) end)

    await(fn ->
      case Poller.live_worker(poller, "hub") do
        %{session_uuid: uuid} when is_binary(uuid) -> uuid != first_native
        _ -> false
      end
    end)

    Threads.deliver_results(entries, "test-host")
    assert {:ok, _} = Shuttle.Delivery.flush_context(parent)
    assert [_] = pending(data)
    # A fresh process re-registers the stale session and runs its hook first.
    # Its old subscription is discovery only, not authority to drain B's mail.
    stale_hook = """
    for event in SessionStart UserPromptSubmit; do
      printf '{"session_id":"#{first_native}","hook_event_name":"%s","harness":"claude","cwd":"#{store}"}\\n' "$event" | '#{cli}' hook event
    done
    """

    assert {stale_output, 0} =
             Shuttle.Env.cmd("bash", ["--noprofile", "--norc", "-c", stale_hook])

    refute stale_output =~ "thread hub/child closed:"
    assert [_] = pending(data)
    File.write!(gate, "offer\n")
    await(fn -> File.exists?(Path.join(store, "rounds")) end)
    assert pending(data) == []
    received_result = File.read!(Path.join(store, "received"))
    assert length(String.split(received_result, "thread hub/child closed:")) == 2
    assert {:ok, _} = CLI.run_in_store(store, ["ask", "hub/child", "Choose a kernel?"])
    send(poller, :run_poll_cycle)

    await(fn ->
      length(Path.wildcard(Path.join(data, "mailboxes/fiber/*/offered/*.json"))) == 2
    end)

    assert_receive {:wake, ask_text}
    assert ask_text =~ "thread hub/child asked: Choose a kernel?"
    assert {:ok, _} = CLI.run_in_store(store, ["reopen", "hub/child", "--local"])
    assert {:ok, _} = CLI.run_in_store(store, ["close", "hub/child", "--local"])
    assert {:ok, %{fibers: latest}} = FiberDocuments.list(felt_stores: [store])
    Threads.deliver_results(latest, "test-host")
    assert_receive {:wake, close_text}
    assert close_text =~ "thread hub/child closed:"
    Threads.deliver_results(latest, "test-host")
    refute_receive {:wake, _}
    received = File.read!(Path.join(store, "received"))
    File.write!(gate, "offer\n")

    await(fn ->
      length(String.split(File.read!(Path.join(store, "rounds")), "\n", trim: true)) == 2
    end)

    assert File.read!(Path.join(store, "received")) == received
  end

  defp native_receiver(listener, transcript, ready, test_pid) do
    case :gen_tcp.accept(listener) do
      {:ok, socket} ->
        case :gen_tcp.recv(socket, 0, 10_000) do
          {:error, :closed} ->
            :ok

          {:ok, line} ->
            frame = Jason.decode!(line)
            session = ready |> File.read!() |> String.trim()
            uuid = frame["uuid"]

            rows = [
              %{type: "user", sessionId: session, uuid: uuid},
              %{
                type: "assistant",
                sessionId: session,
                uuid: "reply-" <> uuid,
                parentUuid: uuid,
                message: %{role: "assistant", model: "claude-test"}
              }
            ]

            File.write!(transcript, Enum.map(rows, &(Jason.encode!(&1) <> "\n")), [:append])
            send(test_pid, {:wake, frame["message"]["content"]})
        end

        :gen_tcp.close(socket)
        native_receiver(listener, transcript, ready, test_pid)

      {:error, :closed} ->
        :ok
    end
  end

  defp await(fun), do: await(fun, System.monotonic_time(:millisecond) + 20_000)

  defp await(fun, deadline) do
    unless fun.() do
      assert System.monotonic_time(:millisecond) < deadline,
             "timed out waiting for process evidence"

      Process.sleep(10)
      await(fun, deadline)
    end
  end

  defp pending(data) do
    Path.wildcard(Path.join(data, "mailboxes/fiber/*/pending/*.json"))
    |> Enum.map(&(&1 |> File.read!() |> Jason.decode!()))
    |> Enum.sort_by(& &1["request"]["message_id"])
  end
end
