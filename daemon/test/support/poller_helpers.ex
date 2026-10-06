defmodule Shuttle.Test.PollerHelpers do
  @moduledoc """
  Fixture builders and the supervised-poller starter shared by the suites that
  drive a `Shuttle.Poller` against `Shuttle.Test.FeltStoreRunner`.

  """

  import ExUnit.Callbacks, only: [start_supervised!: 1, on_exit: 1]

  @doc """
  Minimal shuttle: block YAML for a oneshot fiber ready for dispatch.
  """
  def oneshot_shuttle, do: "enabled: true\nkind: oneshot\n"

  @doc """
  A minimal felt fiber map, with `attrs` merged over the defaults. Its `uid` is
  `Shuttle.Test.FiberUid.for(id)`, so its worker session is
  `Shuttle.Test.FiberUid.session(id)`.
  """
  def make_fiber(id, attrs \\ %{}) do
    Map.merge(
      %{
        "id" => id,
        "uid" => Shuttle.Test.FiberUid.for(id),
        "name" => id,
        "status" => "active",
        "tags" => ["constitution"],
        "created_at" => "2026-04-28T00:00:00Z"
      },
      attrs
    )
  end

  @doc """
  Start a Poller OWNED BY ExUnit's per-test supervisor, so it is terminated
  deterministically at the end of the test (before the next test runs).

  The bug this fixes: `Poller.start_link/1` links the poller to the *test
  process*, but a test process exits `:normal`, and normal exits do NOT
  propagate across links — so every poller SURVIVED its test as a zombie
  ticker. Dozens accumulated over a run, all polling the single shared
  MockRunner Agent + the /tmp/.felt store, dispatching and writing commands
  after later tests' `reset()`. That polluted later tests (sessions/commands
  they never created) and starved the scheduler (blowing the heartbeat-timing
  margins) — the rotating, order-dependent flakiness. `start_supervised!`
  hands the lifecycle to ExUnit; `restart: :temporary` so a poller that stops
  itself mid-test (crash-recovery cases) is not auto-restarted. Returns
  `{:ok, pid}` so existing `{:ok, poller} = ...` call sites are unchanged.

  The poller's worker watchers live under the app-wide
  `Shuttle.WatcherSupervisor`, not under the poller, and the poller does not
  trap exits, so stopping it leaves them heartbeating `runner` (a test's named
  Agent) into later tests, where each heartbeat's `tmux has-session` and
  process scan consumes that test's scripted answers. An `on_exit` stops every
  watcher whose poller is this one.
  """
  def start_poller!(opts) do
    opts = Keyword.put_new_lazy(opts, :daemon_heartbeat_file, &test_heartbeat_file/0)

    # No name (or the singleton's own) starts an unnamed Poller and makes it
    # this test's `Shuttle.Poller` (`Shuttle.Env.server/1`), so concurrent
    # tests each address their own; an explicit other name is kept as given.
    {scoped?, opts} =
      case Keyword.get(opts, :name, Shuttle.Poller) do
        Shuttle.Poller -> {true, Keyword.put(opts, :name, nil)}
        _name -> {false, opts}
      end

    pid =
      start_supervised!(%{
        id: make_ref(),
        start: {Shuttle.Poller, :start_link, [opts]},
        restart: :temporary
      })

    # A watcher names its poller by the registered atom or the pid (Poller's
    # `self_ref`), so those are the only names this cleanup can match.
    name = Keyword.get(opts, :name)

    unless is_nil(name) or is_atom(name) do
      raise ArgumentError, "start_poller!/1 takes an atom :name, got #{inspect(name)}"
    end

    poller_refs = Enum.reject([pid, name], &is_nil/1)
    on_exit(fn -> stop_watchers_of(poller_refs) end)

    if scoped?, do: Shuttle.Test.Env.put_server(Shuttle.Poller, pid)
    {:ok, pid}
  end

  defp stop_watchers_of(poller_refs) do
    for {_, watcher, _, _} <- DynamicSupervisor.which_children(Shuttle.WatcherSupervisor),
        is_pid(watcher),
        watcher_poller(watcher) in poller_refs do
      DynamicSupervisor.terminate_child(Shuttle.WatcherSupervisor, watcher)
    end
  end

  # A watcher that exits before answering is already gone; one that does not
  # answer would be left running, so that fails the test.
  defp watcher_poller(watcher) do
    :sys.get_state(watcher, 5_000).poller
  catch
    :exit, {:noproc, _} ->
      nil

    :exit, reason ->
      if Process.alive?(watcher) do
        raise "watcher #{inspect(watcher)} did not report its poller: #{inspect(reason)}"
      end

      nil
  end

  @doc "The suite-wide heartbeat path test Pollers write when a test names none."
  def test_heartbeat_file, do: Application.fetch_env!(:shuttle, :test_daemon_heartbeat_file)
end
