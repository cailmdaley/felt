defmodule Shuttle.RemoteControlTest do
  use ExUnit.Case, async: true
  alias Shuttle.{RemoteControl, Test.Env}

  defmodule Runner do
    @behaviour Shuttle.Runner
    def cmd(command, args, _opts) do
      Agent.get_and_update(Env.server!(__MODULE__), fn state ->
        {reply, state} =
          case Map.fetch(Map.get(state, :overrides, %{}), {command, List.first(args)}) do
            {:ok, reply} -> {reply, state}
            :error -> respond(command, args, state)
          end

        {reply, %{state | calls: state.calls ++ [{command, args}]}}
      end)
    end

    defp respond("tmux", ["has-session" | _], s) do
      reply =
        case s.pane do
          :gone -> {"can't find session", 1}
          :unknown -> {"permission denied", 1}
          _ -> {"", 0}
        end

      {reply, s}
    end

    defp respond("ps", _, s), do: {{"", 0}, s}
    defp respond("tmux", ["display-message" | _], s), do: {{s.pane, 0}, s}

    defp respond("tmux", ["capture-pane" | _], s),
      do: {{Enum.map_join(1..25, "\n", &"line #{&1}") <> "\n\n", 0}, s}

    defp respond("tmux", ["kill-session" | _], s), do: {{"", 0}, %{s | pane: :gone}}

    defp respond("tmux", ["new-session" | _] = args, s) do
      index = Enum.find_index(args, &(&1 == "@shuttle_rc_script_sha"))
      digest = Enum.at(args, index + 1)
      {{"", 0}, %{s | pane: "#{digest}|0||123|#{s.now}|"}}
    end

    defp respond(_, _, s), do: {{"", 0}, s}
  end

  setup do
    Env.put_app_env(:os_type, {:unix, :linux})

    pid =
      start_supervised!(
        {Agent,
         fn -> %{pane: :gone, calls: [], now: 1_000, config: {:ok, %{dir: "/tmp", args: []}}} end}
      )

    Env.put_server(Runner, pid)

    rc =
      Env.start_scoped!(
        {RemoteControl,
         name: nil,
         runner: Runner,
         interval_ms: :infinity,
         clock: fn -> Agent.get(pid, & &1.now) end,
         config: fn -> Agent.get(pid, & &1.config) end}
      )

    # Synchronizes with the initial handle_continue.
    RemoteControl.status(rc)
    %{rc: rc, runner: pid}
  end

  defp change(pid, fields), do: Agent.update(pid, &Map.merge(&1, Map.new(fields)))
  defp calls(pid), do: Agent.get(pid, & &1.calls)

  defp starts(pid),
    do: Enum.count(calls(pid), fn {_, args} -> List.first(args) == "new-session" end)

  defp dead(pid, created, ended) do
    Agent.update(pid, fn s ->
      digest = s.pane |> String.split("|") |> hd()
      %{s | pane: "#{digest}|1|7|123|#{created}|#{ended}"}
    end)
  end

  test "gone spawns once; alive with the same digest is adopted without spawning", %{
    rc: rc,
    runner: runner
  } do
    assert starts(runner) == 1

    assert %{state: :running, pid: 123, started_at: started, args: [], dir: "/tmp"} =
             RemoteControl.reconcile(rc)

    assert DateTime.to_unix(started) == 1_000
    assert %{state: :running} = RemoteControl.reconcile(rc)
    assert starts(runner) == 1

    assert [{"tmux", ["new-session" | args]}] =
             Enum.filter(calls(runner), fn {_, args} -> List.first(args) == "new-session" end)

    assert Enum.find_index(args, &(&1 == "remain-on-exit")) <
             Enum.find_index(args, &(&1 == "respawn-pane"))
  end

  test "dead pane records status and last 20 nonempty lines before retry", %{
    rc: rc,
    runner: runner
  } do
    dead(runner, 1_000, 1_001)
    change(runner, now: 1_030)

    assert %{
             state: :waiting,
             last_exit: %{status: 7, at: at, screen: screen},
             next_attempt_at: due
           } = RemoteControl.reconcile(rc)

    assert DateTime.to_unix(at) == 1_001
    assert DateTime.to_unix(due) == 1_032
    assert screen == Enum.map(6..25, &"line #{&1}")
    assert %{state: :waiting, next_attempt_at: ^due} = RemoteControl.reconcile(rc)
    assert starts(runner) == 1
    change(runner, now: 1_032)
    assert %{state: :starting} = RemoteControl.reconcile(rc)
    assert starts(runner) == 2
  end

  test "adopting a dead pane uses death time, not the late poll, for backoff", %{
    rc: rc,
    runner: runner
  } do
    # No live observation in this daemon. Polling late must still see a short failure.
    dead(runner, 100, 101)
    change(runner, now: 1_100)
    %{next_attempt_at: due} = RemoteControl.reconcile(rc)
    assert DateTime.to_unix(due) == 1_102
  end

  # Negative control: replace the computed retry delay with a constant 2.
  test "backoff doubles to the cap and resets after an actual 60 second lifetime", %{
    rc: rc,
    runner: runner
  } do
    Enum.reduce([2, 4, 8, 16, 32, 64, 128, 256, 300, 300], 1_000, fn delay, now ->
      dead(runner, now, now + 1)
      change(runner, now: now + 1)
      %{next_attempt_at: due} = RemoteControl.reconcile(rc)
      assert DateTime.to_unix(due) == now + 1 + delay
      change(runner, now: DateTime.to_unix(due))
      assert %{state: :starting} = RemoteControl.reconcile(rc)
      DateTime.to_unix(due)
    end)

    now = Agent.get(runner, & &1.now)
    dead(runner, now, now + 60)
    change(runner, now: now + 60)
    %{next_attempt_at: due} = RemoteControl.reconcile(rc)
    assert DateTime.to_unix(due) == now + 62
  end

  test "changed script restarts; removing config stops and disables", %{rc: rc, runner: runner} do
    change(runner, config: {:ok, %{dir: "/var/tmp", args: ["--verbose"]}})
    assert %{state: :starting, dir: "/var/tmp", args: ["--verbose"]} = RemoteControl.reconcile(rc)
    assert starts(runner) == 2
    change(runner, config: nil)
    assert %{state: :disabled, dir: nil, pid: nil} = RemoteControl.reconcile(rc)
    assert %{state: :disabled} = RemoteControl.reconcile(rc)
    assert starts(runner) == 2
    assert Enum.count(calls(runner), fn {_, args} -> List.first(args) == "kill-session" end) == 2
  end

  test "uncertain or malformed tmux observations never spawn or kill", %{rc: rc, runner: runner} do
    for pane <- [:unknown, "broken", "hash|1|1|123|1000|"] do
      change(runner, pane: pane)
      assert %{state: :error} = RemoteControl.reconcile(rc)
      assert starts(runner) == 1
    end

    change(runner, config: nil)
    assert %{state: :error} = RemoteControl.reconcile(rc)
    refute Enum.any?(calls(runner), fn {_, args} -> List.first(args) == "kill-session" end)
  end

  test "capture, metadata and stop failures hold instead of replacing a host", %{
    rc: rc,
    runner: runner
  } do
    dead(runner, 1_000, 1_001)

    for {command, reply} <- [
          {"capture-pane", {"unavailable", :timeout}},
          {"display-message", {"unavailable", 1}}
        ] do
      change(runner, overrides: %{{"tmux", command} => reply})
      assert %{state: :error} = RemoteControl.reconcile(rc)
      assert starts(runner) == 1
    end

    change(runner,
      overrides: %{{"tmux", "kill-session"} => {"unavailable", :timeout}},
      config: {:ok, %{dir: "/var/tmp", args: []}}
    )

    assert %{state: :error} = RemoteControl.reconcile(rc)
    assert starts(runner) == 1
  end

  test "an uncertain server preflight cannot authorize a spawn", %{rc: rc, runner: runner} do
    RemoteControl.reconcile(rc)
    change(runner, pane: :gone, now: 1_001)
    assert %{state: :waiting} = RemoteControl.reconcile(rc)
    change(runner, now: 1_003, overrides: %{{"tmux", "ls"} => {"timeout", :timeout}})
    assert %{state: :error, message: message} = RemoteControl.reconcile(rc)
    assert message =~ "server is uncertain"
    assert starts(runner) == 1
  end

  test "launch errors grow backoff rather than retrying an expired deadline", %{
    rc: rc,
    runner: runner
  } do
    RemoteControl.reconcile(rc)
    change(runner, pane: :gone, now: 1_001)
    assert %{state: :waiting} = RemoteControl.reconcile(rc)
    change(runner, now: 1_003, overrides: %{{"tmux", "new-session"} => {"timeout", :timeout}})
    assert %{state: :error, next_attempt_at: at} = RemoteControl.reconcile(rc)
    assert DateTime.to_unix(at) == 1_007
    change(runner, now: 1_007)
    assert %{state: :error, next_attempt_at: at} = RemoteControl.reconcile(rc)
    assert DateTime.to_unix(at) == 1_015
    change(runner, pane: :unknown, now: 1_015)
    assert %{state: :error} = RemoteControl.reconcile(rc)
    assert starts(runner) == 3
  end

  test "a disappeared observed host backs off rather than spawning immediately", %{
    rc: rc,
    runner: runner
  } do
    RemoteControl.reconcile(rc)
    change(runner, pane: :gone, now: 1_002)
    assert %{state: :waiting, last_exit: %{status: nil}} = RemoteControl.reconcile(rc)
    assert starts(runner) == 1
  end
end
