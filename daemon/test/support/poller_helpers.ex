defmodule Shuttle.Test.PollerHelpers do
  @moduledoc """
  Fixture builders and the supervised-poller starter shared by the suites that
  drive a `Shuttle.Poller` against `Shuttle.Test.FeltStoreRunner`.

  `import Shuttle.Test.PollerHelpers` from a NON-async test module.
  """

  import ExUnit.Callbacks, only: [start_supervised!: 1]

  @doc """
  Minimal shuttle: block YAML for a oneshot fiber ready for dispatch.
  """
  def oneshot_shuttle, do: "enabled: true\nkind: oneshot\n"

  @doc """
  A minimal felt fiber map, with `attrs` merged over the defaults.
  """
  def make_fiber(id, attrs \\ %{}) do
    Map.merge(
      %{
        "id" => id,
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
  """
  def start_poller!(opts) do
    pid =
      start_supervised!(%{
        id: make_ref(),
        start: {Shuttle.Poller, :start_link, [opts]},
        restart: :temporary
      })

    {:ok, pid}
  end
end
