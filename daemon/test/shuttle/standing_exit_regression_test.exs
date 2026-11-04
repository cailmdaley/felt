defmodule Shuttle.StandingExitRegressionTest do
  use ExUnit.Case, async: true
  alias Shuttle.LifecycleStore

  defmodule FailingWriter do
    @behaviour Shuttle.Runner
    def cmd("shuttle", args, opts) do
      if "standing-transition" in args or "mark-runtime" in args,
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
        expr: "0 9 1 1 *"
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
    assert {_, 0} = System.cmd("go", ["build", "-p", "2", "-o", helper, fixture], stderr_to_stdout: true)
    port = Port.open({:spawn_executable, helper}, [:binary, :exit_status, args: [c.path]])
    assert_receive {^port, {:data, "locked\n"}}, 30_000

    try do
      task = Task.async(fn -> LifecycleStore.mark_awaiting("role") end)
      assert Task.yield(task, 200) == nil, "daemon mutation bypassed the CLI's advisory lock"

      text =
        File.read!(c.path) |> String.replace("Worker result.", "Concurrent committed result.")

      File.write!(c.path, text)
      Port.command(port, "\n")
      assert {:ok, _} = Task.await(task, 30_000)
      assert File.read!(c.path) =~ "Concurrent committed result."
      assert File.read!(c.path) =~ "status: closed"
    after
      if Port.info(port), do: Port.command(port, "\n")
    end
  end

  for verb <- ["accept", "rest"] do
    test "a stale dead-run observation cannot undo #{verb}", context do
      assert {:ok, _} = Shuttle.CLI.run(["-C", context.root, unquote(verb), "role", "--local"])
      accepted = File.read!(context.path)
      StandingRoles.reconcile_dead_standing_roles(context.state, [context.candidate], {:ok, []})
      assert File.read!(context.path) == accepted
    end
  end

  test "a clean scheduled handoff during downtime owes review", c do
    text =
      File.read!(c.path)
      |> String.replace(
        "    run_id: scheduled-2",
        "    run_id: scheduled-2\n    handed_off_at: 2026-01-03T00:00:00Z\n    thread_exit_verb: handed off"
      )

    File.write!(c.path, text)

    candidate =
      put_in(c.candidate, ["shuttle", "runtime", "handed_off_at"], "2026-01-03T00:00:00Z")

    candidate = put_in(candidate, ["shuttle", "runtime", "thread_exit_verb"], "handed off")
    StandingRoles.reconcile_dead_standing_roles(c.state, [candidate], {:ok, []})
    assert File.read!(c.path) =~ "status: closed"
  end

  test "accept followed by a later dispatch stamp does not manufacture a conclusion", c do
    assert {:ok, _} = Shuttle.CLI.run(["-C", c.root, "accept", "role", "--local"])
    assert {:ok, output} = Shuttle.CLI.run(["-C", c.root, "show", "role", "--json"])
    accepted = Jason.decode!(output)
    prior_handoff = get_in(accepted, ["shuttle", "runtime", "handed_off_at"])
    {:ok, at, _} = DateTime.from_iso8601(prior_handoff)
    next_dispatch = DateTime.add(at, 2, :second) |> DateTime.to_iso8601()

    assert {:ok, _} =
             Shuttle.CLI.run([
               "-C",
               c.root,
               "mark-runtime",
               "role",
               "--dispatched-at",
               next_dispatch,
               "--run-id",
               "scheduled-3"
             ])

    assert {:ok, output} = Shuttle.CLI.run(["-C", c.root, "show", "role", "--json"])
    candidate = Jason.decode!(output)
    assert get_in(candidate, ["shuttle", "runtime", "handed_off_at"]) == prior_handoff
    StandingRoles.reconcile_dead_standing_roles(c.state, [candidate], {:ok, []})
    assert File.read!(c.path) =~ "status: closed"
    assert {:ok, _, _, fm, _} = Shuttle.FiberDoc.read_path(c.path)
    assert get_in(fm, ["shuttle", "runtime", "handed_off_at"]) == prior_handoff
  end

  test "a failed close is retried by the next healthy absence observation", c do
    # An unavailable writer cannot conclude the run; the document remains the
    # input for the next poll, independent of the lost watcher notification.
    StandingRoles.reconcile_dead_standing_roles(
      %{c.state | runner: FailingWriter},
      [c.candidate],
      {:ok, []}
    )

    assert File.read!(c.path) =~ "status: active"
    StandingRoles.reconcile_dead_standing_roles(c.state, [c.candidate], {:ok, []})
    assert File.read!(c.path) =~ "status: closed"
  end

  test "force rearm propagates a failed CLI mutation without arming the document", c do
    File.write!(c.path, String.replace(File.read!(c.path), "status: active", "status: closed"))
    before = File.read!(c.path)

    assert {:error, _} =
             LifecycleStore.rearm("role", runner: FailingWriter, felt_stores: [c.root])

    assert File.read!(c.path) == before
  end
end
