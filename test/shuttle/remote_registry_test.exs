defmodule Shuttle.RemoteRegistryTest do
  use ExUnit.Case

  alias Shuttle.Remote
  alias Shuttle.RemoteRegistry
  alias Shuttle.Runner

  # ── Mock Client ──
  #
  # A deterministic stub for the HTTP transport. Tests script per-URL
  # responses (success body, error reason) so we can drive happy-path,
  # transient-failure, and stale paths without spinning up a Bandit
  # endpoint or stubbing :httpc directly.

  defmodule MockClient do
    @behaviour Shuttle.RemoteRegistry.Client

    use Agent

    def start_link(_ \\ []) do
      Agent.start_link(fn -> %{} end, name: __MODULE__)
    end

    def reset, do: Agent.update(__MODULE__, fn _ -> %{} end)

    def set(url, response), do: Agent.update(__MODULE__, &Map.put(&1, url, response))

    @impl true
    def get(url, _timeout_ms) do
      Agent.get(__MODULE__, &Map.get(&1, url, {:error, :not_set}))
    end
  end

  defmodule MockRunner do
    @behaviour Runner

    use Agent

    def start_link(_ \\ []) do
      Agent.start_link(fn -> %{responses: %{}, calls: []} end, name: __MODULE__)
    end

    def reset, do: Agent.update(__MODULE__, fn _ -> %{responses: %{}, calls: []} end)

    def set(command, responses) when is_binary(command) and is_list(responses) do
      Agent.update(__MODULE__, fn state ->
        put_in(state, [:responses, command], responses)
      end)
    end

    def calls do
      Agent.get(__MODULE__, fn state -> Enum.reverse(state.calls) end)
    end

    @impl true
    def cmd(command, args, _opts) do
      Agent.get_and_update(__MODULE__, fn state ->
        queue = Map.get(state.responses, command, [])

        {response, remaining} =
          case queue do
            [next | rest] -> {next, rest}
            [] -> {{"", 0}, []}
          end

        new_state = %{
          state
          | responses: Map.put(state.responses, command, remaining),
            calls: [{command, args} | state.calls]
        }

        {response, new_state}
      end)
    end
  end

  setup do
    start_supervised!(MockClient)
    start_supervised!(MockRunner)
    MockClient.reset()
    MockRunner.reset()
    :ok
  end

  defp candide_remote(opts \\ []) do
    %Remote{
      name: "candide",
      url: "http://localhost:4001",
      poll_interval_ms: Keyword.get(opts, :poll_interval_ms, 50),
      request_timeout_ms: Keyword.get(opts, :request_timeout_ms, 100),
      stale_multiplier: Keyword.get(opts, :stale_multiplier, 2)
    }
  end

  defp snapshot_with_running(fiber_ids) do
    Jason.encode!(%{
      "host" => "candide",
      "eligible" => Enum.map(fiber_ids, &%{"fiber_id" => &1}),
      "blocked" => [],
      "retrying" => []
    })
  end

  # ── Remote struct ──

  describe "Remote.from_config/1" do
    test "parses a complete map" do
      r =
        Remote.from_config(%{
          name: "candide",
          url: "http://localhost:4001",
          poll_interval_ms: 3000
        })

      assert r.name == "candide"
      assert r.url == "http://localhost:4001"
      assert r.poll_interval_ms == 3000
      # Default still applies for fields not provided
      assert r.request_timeout_ms == 2000
    end

    test "accepts string keys" do
      r = Remote.from_config(%{"name" => "candide", "url" => "http://localhost:4001"})
      assert r.name == "candide"
    end

    test "accepts keyword list" do
      r = Remote.from_config(name: "candide", url: "http://localhost:4001")
      assert r.name == "candide"
    end

    test "returns nil when name is missing" do
      assert Remote.from_config(%{url: "http://localhost:4001"}) == nil
    end

    test "returns nil when url is missing" do
      assert Remote.from_config(%{name: "candide"}) == nil
    end
  end

  describe "Remote.stale?/3" do
    test "nil last_polled_at is always stale" do
      assert Remote.stale?(candide_remote(), nil, DateTime.utc_now())
    end

    test "fresh poll within threshold is not stale" do
      now = DateTime.utc_now()
      recent = DateTime.add(now, -10, :millisecond)
      remote = candide_remote(poll_interval_ms: 100)
      refute Remote.stale?(remote, recent, now)
    end

    test "old poll past 2× threshold is stale" do
      now = DateTime.utc_now()
      old = DateTime.add(now, -300, :millisecond)
      remote = candide_remote(poll_interval_ms: 100, stale_multiplier: 2)
      assert Remote.stale?(remote, old, now)
    end
  end

  # ── RemoteRegistry happy path ──

  describe "registry polling" do
    test "polls configured remote and exposes the snapshot" do
      MockClient.set(
        "http://localhost:4001/api/v1/state",
        {:ok, snapshot_with_running(["work/foo"])}
      )

      {:ok, _pid} =
        RemoteRegistry.start_link(
          name: :reg_happy,
          remotes: [candide_remote()],
          client: MockClient,
          auto_poll: false,
          tick_interval_ms: 60_000
        )

      :ok = RemoteRegistry.poll_now(:reg_happy)

      snapshots = RemoteRegistry.snapshots(:reg_happy)
      assert Map.has_key?(snapshots, "candide")

      candide = snapshots["candide"]
      refute candide.stale
      assert is_struct(candide.last_polled_at, DateTime)
      assert candide.last_error == nil
      assert get_in(candide, [:snapshot, "host"]) == "candide"
    end
  end

  # ── Failure paths ──

  describe "transient failures" do
    test "non-200 response marks the remote stale with last_error set" do
      MockClient.set(
        "http://localhost:4001/api/v1/state",
        {:error, {:http_status, 502}}
      )

      {:ok, _pid} =
        RemoteRegistry.start_link(
          name: :reg_502,
          remotes: [candide_remote()],
          client: MockClient,
          auto_poll: false,
          tick_interval_ms: 60_000
        )

      :ok = RemoteRegistry.poll_now(:reg_502)

      candide = RemoteRegistry.snapshot(:reg_502, "candide")
      assert candide.stale
      assert candide.last_error == {:http_status, 502}
    end

    test "connection error marks the remote stale" do
      MockClient.set(
        "http://localhost:4001/api/v1/state",
        {:error, :econnrefused}
      )

      {:ok, _pid} =
        RemoteRegistry.start_link(
          name: :reg_refused,
          remotes: [candide_remote()],
          client: MockClient,
          auto_poll: false,
          tick_interval_ms: 60_000
        )

      :ok = RemoteRegistry.poll_now(:reg_refused)

      candide = RemoteRegistry.snapshot(:reg_refused, "candide")
      assert candide.stale
      assert candide.last_error == :econnrefused
    end

    test "malformed JSON marks the remote stale" do
      MockClient.set(
        "http://localhost:4001/api/v1/state",
        {:ok, "not json {"}
      )

      {:ok, _pid} =
        RemoteRegistry.start_link(
          name: :reg_garbage,
          remotes: [candide_remote()],
          client: MockClient,
          auto_poll: false,
          tick_interval_ms: 60_000
        )

      :ok = RemoteRegistry.poll_now(:reg_garbage)

      candide = RemoteRegistry.snapshot(:reg_garbage, "candide")
      assert candide.stale
      assert candide.last_error == :malformed_json
    end
  end

  # ── Staleness derivation ──

  describe "staleness derivation" do
    test "fresh poll, then long enough wait, becomes stale" do
      MockClient.set(
        "http://localhost:4001/api/v1/state",
        {:ok, snapshot_with_running(["work/temp"])}
      )

      {:ok, _pid} =
        RemoteRegistry.start_link(
          name: :reg_stale,
          # Tiny intervals so the test runs fast. stale = 2 × 50ms = 100ms.
          remotes: [candide_remote(poll_interval_ms: 50, stale_multiplier: 2)],
          client: MockClient,
          auto_poll: false,
          tick_interval_ms: 60_000
        )

      :ok = RemoteRegistry.poll_now(:reg_stale)

      # Right after polling, fresh + running.
      refute RemoteRegistry.snapshot(:reg_stale, "candide").stale

      # After 2 × poll_interval, the snapshot is stale for composite views.
      Process.sleep(120)

      assert RemoteRegistry.snapshot(:reg_stale, "candide").stale
    end
  end

  # ── Recovery cascade ──

  describe "recovery cascade" do
    test "bounces the tunnel after the failure threshold and returns healthy on the next good probe" do
      MockClient.set(
        "http://localhost:4001/api/v1/state",
        {:error, :econnrefused}
      )

      MockRunner.set("launchctl", [{"", 0}])

      {:ok, _pid} =
        RemoteRegistry.start_link(
          name: :reg_recovery_happy,
          remotes: [candide_remote(poll_interval_ms: 1)],
          client: MockClient,
          runner: MockRunner,
          auto_poll: false,
          tick_interval_ms: 60_000,
          failure_threshold: 3,
          bounce_wait_ms: 1,
          restart_wait_ms: 1,
          backoff_schedule_ms: [5],
          user_uid: "501"
        )

      Enum.each(1..3, fn _ ->
        :ok = RemoteRegistry.poll_now(:reg_recovery_happy)
        Process.sleep(2)
      end)

      degraded = RemoteRegistry.snapshot(:reg_recovery_happy, "candide")
      assert degraded.recovery.state == :degraded
      assert degraded.recovery.attempt == 1

      MockClient.set(
        "http://localhost:4001/api/v1/state",
        {:ok, snapshot_with_running(["work/recovered"])}
      )

      :ok = RemoteRegistry.poll_now(:reg_recovery_happy)
      Process.sleep(2)
      :ok = RemoteRegistry.poll_now(:reg_recovery_happy)

      healed = RemoteRegistry.snapshot(:reg_recovery_happy, "candide")
      refute healed.stale
      assert healed.recovery.state == :healthy
      assert healed.recovery.attempt == 0
      assert get_in(healed, [:snapshot, "eligible"]) == [%{"fiber_id" => "work/recovered"}]

      assert [{"launchctl", ["kickstart", "-k", "gui/501/com.cailmdaley.shuttle-tunnel-candide"]}] =
               MockRunner.calls()
    end

    test "escalates through SSH check, remote restart, and backoff" do
      MockClient.set(
        "http://localhost:4001/api/v1/state",
        {:error, :econnrefused}
      )

      MockRunner.set("launchctl", [{"", 0}])

      MockRunner.set("ssh", [
        {"session=absent\nhttp=unhealthy\n", 0},
        {"restart requested\n", 0}
      ])

      {:ok, _pid} =
        RemoteRegistry.start_link(
          name: :reg_recovery_backoff,
          remotes: [candide_remote(poll_interval_ms: 1)],
          client: MockClient,
          runner: MockRunner,
          auto_poll: false,
          tick_interval_ms: 60_000,
          failure_threshold: 3,
          bounce_wait_ms: 1,
          restart_wait_ms: 1,
          backoff_schedule_ms: [2],
          user_uid: "501"
        )

      Enum.each(1..3, fn _ ->
        :ok = RemoteRegistry.poll_now(:reg_recovery_backoff)
        Process.sleep(2)
      end)

      :ok = RemoteRegistry.poll_now(:reg_recovery_backoff)
      Process.sleep(2)
      :ok = RemoteRegistry.poll_now(:reg_recovery_backoff)
      :ok = RemoteRegistry.poll_now(:reg_recovery_backoff)
      :ok = RemoteRegistry.poll_now(:reg_recovery_backoff)
      Process.sleep(2)
      :ok = RemoteRegistry.poll_now(:reg_recovery_backoff)

      unreachable = RemoteRegistry.snapshot(:reg_recovery_backoff, "candide")
      assert unreachable.recovery.state == :unreachable
      assert unreachable.recovery.attempt == 1
      assert %DateTime{} = unreachable.recovery.next_retry_at
      assert unreachable.recovery.last_action == "probe after remote restart failed"

      calls = MockRunner.calls()
      assert Enum.map(calls, &elem(&1, 0)) == ["launchctl", "ssh", "ssh"]

      assert Enum.any?(calls, fn {command, args} ->
               command == "ssh" and
                 Enum.any?(args, &String.contains?(&1, "curl -sf --max-time 3"))
             end)

      assert Enum.any?(calls, fn {command, args} ->
               command == "ssh" and
                 Enum.any?(args, &String.contains?(&1, "$HOME/.local/bin/shuttle-launch"))
             end)

      Process.sleep(3)
      :ok = RemoteRegistry.poll_now(:reg_recovery_backoff)

      restarted = RemoteRegistry.snapshot(:reg_recovery_backoff, "candide")
      assert restarted.recovery.state == :degraded
      assert restarted.recovery.attempt == 2
      assert restarted.recovery.last_action == "backoff probe failed; restarting recovery cascade"
    end
  end

  # ── Module fallback when registry isn't running ──

  describe "graceful absence" do
    test "snapshot/2 returns nil when registry is not started" do
      # Use a name we know isn't registered.
      assert RemoteRegistry.snapshot(:reg_does_not_exist, "candide") == nil
    end
  end
end
