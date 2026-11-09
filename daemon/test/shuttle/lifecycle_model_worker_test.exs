defmodule Shuttle.LifecycleModelWorkerTest do
  @moduledoc """
  The runtime half of the lifecycle model's worker axis
  (`ui/harness/lifecycleModel.ts`, written out to
  `test/fixtures/lifecycle/model.json`): a real Poller answers `/kill` and a
  force `/dispatch` the way the model says, for a fiber with no worker, a live
  one, and a gone one.

  A gone worker is fir's phantom: the daemon holds its runtime, its terminal no
  longer lists it, the process-table scan times out, and its launch receipt's
  pid no longer runs.
  """
  use ExUnit.Case, async: true

  import Shuttle.Test.PollerHelpers

  alias Shuttle.{Poller, SessionResume}
  alias Shuttle.Terminal.{Receipts, Tmux}
  alias Shuttle.Test.Env
  alias Shuttle.Test.FeltStoreRunner, as: MockRunner

  @moduletag :tmp_dir

  @table "test/fixtures/lifecycle/model.json" |> File.read!() |> Jason.decode!()

  # The model's worker-axis answer to `request` from a fiber whose worker is
  # `worker`: one {outcome, next worker} across every fiber state, since the
  # owner's answer to these requests does not depend on the document.
  defp model(worker, request) do
    answers =
      for {key, answers} <- @table["answers"],
          @table["states"][key]["worker"] == worker,
          [outcome, next | _] = answers[request],
          uniq: true,
          do: {outcome, held(@table["states"][next]["worker"])}

    assert [answer] = answers, "#{worker}/#{request} depends on the fiber: #{inspect(answers)}"
    answer
  end

  # The daemon holds a gone or an unseen worker alike; requests tell them apart.
  defp held(worker) when worker in ["gone", "unseen"], do: "held"
  defp held(worker), do: worker

  setup %{tmp_dir: dir} do
    Env.put_app_env(:terminal_backend, Shuttle.Terminal.Tmux)
    Env.put_app_env(:os_type, {:unix, :linux})
    Env.put_app_env(:proc_root, Path.join(dir, "proc"))
    Env.put_app_env(:worker_stop_ladder, [{nil, 50}, {"TERM", 50}, {"KILL", 50}])
    File.mkdir_p!(Path.join(dir, "proc"))
    MockRunner.start!()
    MockRunner.reset()
    root = MockRunner.felt_root()
    on_exit(fn -> File.rm_rf(root) end)
    Env.put_env("SHUTTLE_DATA_DIR", Path.join(dir, "data"))
    Env.delete_env("SHUTTLE_SESSIONS_FILE")
    :ok
  end

  defp running(poller, fiber_id) do
    :sys.get_state(poller, 30_000).running
    |> Enum.find_value(fn {_key, meta} -> if meta.fiber_id == fiber_id, do: meta.session end)
  end

  defp wait_until(fun, attempts \\ 6_000)
  defp wait_until(fun, 0), do: fun.()

  defp wait_until(fun, attempts) do
    if fun.(), do: true, else: Process.sleep(5) && wait_until(fun, attempts - 1)
  end

  # A fiber whose worker is `worker`, held by a Poller that runs no further
  # cycle on its own.
  defp arrange(worker, scan) do
    fiber_id = "tests/model-#{worker}-#{System.unique_integer([:positive])}"
    status = if worker == "none", do: "open", else: "active"
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id, %{"status" => status}))
    MockRunner.set_shuttle(fiber_id, "kind: oneshot\nhost: candide\n", status)

    {:ok, poller} =
      start_poller!(
        runner: MockRunner,
        own_host_id: "candide",
        poll_interval_ms: 600_000,
        felt_stores: [MockRunner.felt_root()]
      )

    await_boot_cycle!(poller)
    cycles = :sys.get_state(poller, 30_000).poll_cycles
    # The one cycle that launches an active fiber's worker.
    send(poller, :run_poll_cycle)

    assert wait_until(fn ->
             state = :sys.get_state(poller, 30_000)
             state.poll_cycles > cycles and not state.poll_check_in_progress
           end)

    assert running(poller, fiber_id) != nil == (worker != "none")

    session = running(poller, fiber_id)

    receipt = session && String.trim_trailing(Receipts.pid_path(session), ".pid")

    case worker do
      "gone" ->
        # The run script recorded its pid and exited, and tmux no longer lists
        # the session.
        assert File.exists?(receipt)

        File.write!(
          Receipts.pid_path(session),
          "#{System.unique_integer([:positive]) + 100_000}\n"
        )

        MockRunner.remove_tmux_session(session)

      "unseen" ->
        # A launch from before receipts whose run script is still on disk:
        # with the scan failing, nothing can say whether it runs.
        File.rm!(receipt)
        MockRunner.remove_tmux_session(session)

      _ ->
        :ok
    end

    if scan == :failing, do: MockRunner.set_ps_result({"ps timed out", :timeout})

    {poller, fiber_id}
  end

  defp request(poller, fiber_id, "kill"), do: Poller.kill_session(poller, fiber_id)

  # The band starts fresh when asked to, and otherwise resumes the fiber's
  # conversation when it has one.
  defp request(poller, fiber_id, "dispatch" <> flags) do
    fresh? = String.contains?(flags, ":fresh")
    said? = String.contains?(flags, ":said")

    mode =
      cond do
        fresh? -> "fresh"
        String.contains?(fiber_id, "-none-") -> nil
        true -> "previous"
      end

    Poller.dispatch_fiber(poller, fiber_id,
      force: true,
      user_message: if(said?, do: "the mocks are in"),
      resume_mode: mode
    )
  end

  # `c` on a worker with no terminal reopens its past session, filed under a
  # project directory as Claude files it.
  defp request(_poller, fiber_id, "attach:past") do
    %{"session" => session} =
      Shuttle.SessionLedger.latest_for_uid(MockRunner.fiber(fiber_id)["uid"])

    root = Shuttle.data_dir()
    project = Path.join(root, "project")
    filed = Path.join([root, "claude", SessionResume.claude_slug(project)])
    Enum.each([project, filed], &File.mkdir_p!/1)
    line = Jason.encode!(%{"type" => "user", "cwd" => project})
    File.write!(Path.join(filed, "#{session}.jsonl"), line <> "\n")
    Env.put_env("SHUTTLE_CLAUDE_PROJECTS_DIR", Path.join(root, "claude"))

    SessionResume.prepare(session,
      runner: MockRunner,
      live_sessions: &SessionResume.live_sessions/0
    )
  end

  defp outcome({:ok, _}), do: "ok"
  defp outcome({:error, :already_running}), do: "conflict"
  defp outcome({:error, {:launch_reserved, _}}), do: "conflict"
  defp outcome({:error, {:live, _}}), do: "refused"
  defp outcome({:error, message}) when is_binary(message), do: "refused"
  defp outcome({:error, {:transcript_held, _}}), do: "refused"
  defp outcome(other), do: other

  defp worker_after(poller, fiber_id) do
    case running(poller, fiber_id) do
      nil -> "none"
      session -> if Tmux.probe(MockRunner, session) == :present, do: "live", else: "held"
    end
  end

  # The model abstracts the process scan away, and liveness without it is the
  # point: a fiber with no worker or a gone one answers as the model says with
  # the scan failing too (fir's loaded login node), except that resuming the
  # gone worker's conversation waits until a scan can show no other process
  # holds it. That refusal names its reason and leaves no phantom behind. An
  # unseen worker is only unseen while the scan fails. A live worker whose pid
  # is not yet recorded needs the scan to be proven stopped, so it is driven
  # with the scan up.
  cases =
    for worker <- ["none", "live", "gone", "unseen"],
        req <-
          ["kill", "dispatch", "dispatch:said", "dispatch:fresh", "dispatch:fresh:said"] ++
            if(worker in ["gone", "unseen"], do: ["attach:past"], else: []),
        scan <- [:ok, :failing],
        worker == "live" == (scan == :ok) or worker in ["none", "gone"],
        do: {worker, req, scan}

  for {worker, req, scan} <- cases do
    test "#{req} on a fiber whose worker is #{worker}, process scan #{scan}, answers as the model says, promptly" do
      {worker, req, scan} = {unquote(worker), unquote(req), unquote(scan)}
      {poller, fiber_id} = arrange(worker, scan)
      modelled = model(worker, req)

      want =
        if worker == "gone" and scan == :failing and
             req in ["dispatch", "dispatch:said", "attach:past"] do
          assert {"ok", _} = modelled
          # A dispatch still reaps the gone worker; c leaves it to the Poller.
          {"refused", if(req == "attach:past", do: "held", else: "none")}
        else
          modelled
        end

      # A stop never waits out the Poller's call timeout.
      {micros, reply} = :timer.tc(fn -> request(poller, fiber_id, req) end)
      assert micros < 5_000_000, "#{req} took #{div(micros, 1000)} ms"

      got =
        {outcome(reply),
         if(req == "attach:past", do: held(worker), else: worker_after(poller, fiber_id))}

      assert got == want
    end
  end
end
