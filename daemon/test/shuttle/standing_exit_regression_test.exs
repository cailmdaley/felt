defmodule Shuttle.StandingExitRegressionTest do
  use ExUnit.Case, async: true
  alias Shuttle.LifecycleStore

  defmodule FailingWriter do
    @behaviour Shuttle.Runner
    def cmd("shuttle", args, opts) do
      if "conclude-run" in args or "mark-runtime" in args,
        do: {"simulated document write failure", 1},
        else: Shuttle.Runner.Default.cmd("shuttle", args, opts)
    end

    def cmd(command, args, opts), do: Shuttle.Runner.Default.cmd(command, args, opts)
  end

  alias Shuttle.Poller.{State, StandingRoles}
  alias Shuttle.Test.Env
  @moduletag :tmp_dir

  setup %{tmp_dir: root} do
    Env.put_env("SHUTTLE_STORES", root)
    Env.put_env("SHUTTLE_HOST", "test-host")
    path = Path.join([root, ".felt", "role", "role.md"])
    File.mkdir_p!(Path.dirname(path))

    text = """
    ---
    id: 01KTCA2CYQXYRS3F77JZNJD8HZ
    name: Scheduled role
    status: active
    shuttle:
      kind: standing
      host: test-host
      project_dir: #{root}
      agent: claude-sonnet
      schedule:
        expr: "0 9 * * *"
        tz: UTC
      runtime:
        dispatched_at: 2026-01-02T00:00:00Z
        run_id: scheduled-2
    ---

    Worker result.
    """

    File.write!(path, text)
    {:ok, _, _, fm, _} = Shuttle.FiberDoc.read_path(path)
    candidate = fm |> Map.put("id", "role") |> Map.put("uid", fm["id"]) |> Map.put("path", path)
    state = %State{own_host_id: "test-host", runner: Shuttle.Runner.Default, felt_stores: [root]}
    %{root: root, path: path, candidate: candidate, state: state}
  end

  test "standing exit takes the real Go document lock and preserves a committed body", c do
    helper = Path.join(c.root, "fiber-lock")
    fixture = Path.expand("../fixtures/fiber_lock/main.go", __DIR__)

    assert {_, 0} =
             System.cmd("go", ["build", "-p", "2", "-o", helper, fixture], stderr_to_stdout: true)

    port = Port.open({:spawn_executable, helper}, [:binary, :exit_status, args: [c.path]])
    assert_receive {^port, {:data, "locked\n"}}, 30_000

    try do
      task = Task.async(fn -> LifecycleStore.conclude("role") end)
      assert Task.yield(task, 200) == nil, "daemon mutation bypassed the CLI's advisory lock"

      text =
        File.read!(c.path) |> String.replace("Worker result.", "Concurrent committed result.")

      File.write!(c.path, text)
      Port.command(port, "\n")
      assert {:ok, "concluded" <> _} = Task.await(task, 30_000)
      assert File.read!(c.path) =~ "Concurrent committed result."
      assert File.read!(c.path) =~ "status: active"
      assert File.read!(c.path) =~ "handed_off_at:"
    after
      if Port.info(port), do: Port.command(port, "\n")
    end
  end

  test "an exit without handoff concludes the run and rests the role until its next tick", c do
    assert StandingRoles.standing_role_due?(show(c.root)),
           "fixture: an occurrence elapsed since the observed dispatch"

    before = DateTime.utc_now()
    assert {:ok, "concluded" <> _} = LifecycleStore.conclude("role")

    fiber = show(c.root)
    assert fiber["status"] == "active"
    assert get_in(fiber, ["shuttle", "runtime", "thread_exit_verb"]) == "handed off"

    {:ok, stamped, _} =
      DateTime.from_iso8601(get_in(fiber, ["shuttle", "runtime", "handed_off_at"]))

    assert DateTime.compare(stamped, before) != :lt
    refute StandingRoles.standing_role_due?(fiber)
  end

  test "an exit after the worker handed off leaves the document as it stands", c do
    assert {:ok, _} =
             Shuttle.CLI.run([
               "-C",
               c.root,
               "mark-runtime",
               "role",
               "--handed-off-at",
               "2026-01-03T00:00:00Z"
             ])

    handed_off = File.read!(c.path)
    assert {:ok, "left" <> _} = LifecycleStore.conclude("role")
    assert File.read!(c.path) == handed_off
  end

  for {name, args} <- [
        {"paused", ["rest", "role", "--local"]},
        {"retired", ["close", "role", "--tempered=false", "--local"]}
      ] do
    test "a #{name} role is untouched by the exit and recovery writers", c do
      assert {:ok, _} = Shuttle.CLI.run(["-C", c.root | unquote(args)])
      settled = File.read!(c.path)

      assert {:ok, "left" <> _} = LifecycleStore.conclude("role", observed: c.candidate)
      StandingRoles.reconcile_dead_standing_roles(c.state, [c.candidate], {:ok, []})
      assert File.read!(c.path) == settled
    end
  end

  test "recovery concludes a dead run at its dispatch instant and a missed tick still fires", c do
    StandingRoles.reconcile_dead_standing_roles(c.state, [c.candidate], {:ok, []})

    fiber = show(c.root)
    assert fiber["status"] == "active"

    {:ok, stamped, _} =
      DateTime.from_iso8601(get_in(fiber, ["shuttle", "runtime", "handed_off_at"]))

    assert DateTime.compare(stamped, ~U[2026-01-02 00:00:00Z]) == :eq
    assert StandingRoles.standing_role_due?(fiber)
  end

  test "a concluded run is skipped by recovery without a write", c do
    StandingRoles.reconcile_dead_standing_roles(c.state, [c.candidate], {:ok, []})
    concluded = File.read!(c.path)
    candidate = show(c.root) |> Map.put("id", "role") |> Map.put("path", c.path)

    StandingRoles.reconcile_dead_standing_roles(
      %{c.state | runner: FailingWriter},
      [candidate],
      {:ok, []}
    )

    assert File.read!(c.path) == concluded
  end

  test "a failed conclusion is retried by the next healthy absence observation", c do
    # An unavailable writer cannot conclude the run; the document remains the
    # input for the next poll, independent of the lost watcher notification.
    StandingRoles.reconcile_dead_standing_roles(
      %{c.state | runner: FailingWriter},
      [c.candidate],
      {:ok, []}
    )

    refute File.read!(c.path) =~ "handed_off_at:"
    StandingRoles.reconcile_dead_standing_roles(c.state, [c.candidate], {:ok, []})
    assert File.read!(c.path) =~ "handed_off_at:"
    assert File.read!(c.path) =~ "status: active"
  end

  defp show(root) do
    assert {:ok, output} = Shuttle.CLI.run(["-C", root, "show", "role", "--json"])
    output |> Jason.decode!() |> Map.put("id", "role")
  end
end
