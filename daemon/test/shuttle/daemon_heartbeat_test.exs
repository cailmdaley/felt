defmodule Shuttle.DaemonHeartbeatTest do
  use ExUnit.Case, async: true

  alias Shuttle.DaemonHeartbeat

  setup do
    dir = Path.join(System.tmp_dir!(), "shuttle-hb-#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)
    on_exit(fn -> File.rm_rf!(dir) end)
    %{path: Path.join(dir, "heartbeat.json")}
  end

  defp wait_for(fun, tries \\ 200) do
    cond do
      fun.() -> true
      tries == 0 -> false
      true -> Process.sleep(10) && wait_for(fun, tries - 1)
    end
  end

  describe "graceful-shutdown retirement" do
    test "write_async writes the record", %{path: path} do
      :ok = DaemonHeartbeat.write_async(path, booted_at: 1, workers: ["a"])
      assert wait_for(fn -> match?({:ok, _}, DaemonHeartbeat.read(path)) end)
      assert {:ok, %{"workers" => ["a"]}} = DaemonHeartbeat.read(path)
    end

    test "retire removes the file and no later write re-creates it", %{path: path} do
      :ok = DaemonHeartbeat.write(path, booted_at: 1)
      assert File.exists?(path)

      :ok = DaemonHeartbeat.retire(path)
      refute File.exists?(path)
      assert DaemonHeartbeat.retired?(path)

      for _ <- 1..5, do: DaemonHeartbeat.write_async(path, booted_at: 1)
      Process.sleep(100)
      refute File.exists?(path)
    end

    test "retire waits out a write already in flight", %{path: path} do
      # Hold the writer name as an in-flight writer would; retire must not
      # delete until it lets go, and a writer that lands in that window must
      # still be removed by the delete that follows.
      name = {DaemonHeartbeat, :writer, path}
      parent = self()

      writer =
        spawn(fn ->
          :yes = :global.register_name(name, self())
          send(parent, :holding)

          receive do
            :finish -> :ok = DaemonHeartbeat.write(path, booted_at: 1)
          end
        end)

      assert_receive :holding
      retirer = Task.async(fn -> DaemonHeartbeat.retire(path, 5_000) end)
      Process.sleep(50)
      assert Task.yield(retirer, 0) == nil

      send(writer, :finish)
      assert Task.await(retirer) == :ok
      refute File.exists?(path)
    end

    test "a tick that finds a write in flight skips instead of queueing", %{path: path} do
      name = {DaemonHeartbeat, :writer, path}
      :yes = :global.register_name(name, self())

      :ok = DaemonHeartbeat.write_async(path, booted_at: 1)
      Process.sleep(100)
      refute File.exists?(path)

      :global.unregister_name(name)
    end
  end

  # ── verdict ──
  #
  # A heartbeat that releases on its own, judged at `@now`: written 4s ago by
  # an incarnation up half an hour, one boot in the ring, no workers.
  @now 1_800_000_000_000

  defp hb(fields \\ %{}) do
    booted_at = @now - 1_800_000

    {:ok,
     Map.merge(
       %{
         "v" => 1,
         "host" => "fleet-host",
         "node" => "login01",
         "at" => @now - 4_000,
         "booted_at" => booted_at,
         "workers" => [],
         "boots" => [booted_at]
       },
       fields
     )}
  end

  defp judge(read_result, observed \\ %{}) do
    DaemonHeartbeat.verdict(
      read_result,
      Map.merge(%{now_ms: @now, live: [], host: "fleet-host", node: "login01"}, observed)
    )
  end

  describe "verdict" do
    test "the baseline heartbeat releases" do
      assert {:release, _} = judge(hb())
    end

    test "three boots in the window, this one included, release; four hold" do
      at = @now - 3_000

      two_before = %{
        "at" => at,
        "booted_at" => at - 100_000,
        "boots" => [at - 200_000, at - 100_000]
      }

      assert {:release, _} = judge(hb(two_before))

      three_before = %{two_before | "boots" => [at - 300_000, at - 200_000, at - 100_000]}
      assert {:hold, reason} = judge(hb(three_before))
      assert reason =~ "4 daemon boots"
    end

    test "a heartbeat from another login node sharing this $HOME holds" do
      # Same fleet identity (own_host_id), different machine: an idle daemon
      # there keeps a fresh heartbeat with no workers, which is no evidence
      # about this node's restart.
      assert {:hold, reason} = judge(hb(), %{node: "login02"})
      assert reason =~ "login01"
    end

    test "a heartbeat stamped with another host id holds" do
      assert {:hold, _} = judge(hb(), %{host: "other-host"})
    end

    test "a heartbeat with no host or node stamp holds" do
      {:ok, record} = hb()
      assert {:hold, _} = judge({:ok, Map.delete(record, "node")})
      assert {:hold, _} = judge({:ok, Map.delete(record, "host")})
    end

    test "write then read round-trips the host and node stamps", %{path: path} do
      :ok = DaemonHeartbeat.write(path, booted_at: 1, host: "fleet-host", node: "login01")
      assert {:ok, %{"host" => "fleet-host", "node" => "login01"}} = DaemonHeartbeat.read(path)
    end

    test "the previous incarnation's run length: 90_000ms releases, 89_999ms holds" do
      at = @now - 3_000
      assert {:release, _} = judge(hb(%{"at" => at, "booted_at" => at - 90_000}))
      assert {:hold, reason} = judge(hb(%{"at" => at, "booted_at" => at - 89_999}))
      assert reason =~ "crash loop"
    end

    test "freshness is symmetric: within ±60_000ms releases, beyond holds" do
      # A heartbeat from the future is a clock step, not evidence; the grace
      # bounds it the same way as one from the past.
      assert {:release, _} = judge(hb(%{"at" => @now - 60_000}))
      assert {:hold, _} = judge(hb(%{"at" => @now - 60_001}))
      assert {:release, _} = judge(hb(%{"at" => @now + 60_000}))
      assert {:hold, reason} = judge(hb(%{"at" => @now + 60_001}))
      assert reason =~ "-60001ms old"
    end

    test "recorded workers must all be live; extra live workers do not matter" do
      assert {:release, _} = judge(hb(%{"workers" => ["a"]}), %{live: ["a", "b"]})
      assert {:hold, reason} = judge(hb(%{"workers" => ["a", "c"]}), %{live: ["a"]})
      assert reason =~ "gone: c"
    end

    test "a recorded app worker holds, since adoption cannot observe it" do
      assert {:hold, reason} =
               judge(hb(%{"workers" => ["a", "b"]}), %{live: ["a", "b"], app: ["b"]})

      assert reason =~ "app workers"
      # A live app worker the heartbeat never recorded is not part of the proof.
      assert {:release, _} = judge(hb(%{"workers" => ["a"]}), %{live: ["a", "b"], app: ["b"]})
    end

    test "a heartbeat written before this machine booted holds" do
      assert {:hold, reason} = judge(hb(), %{machine_booted_at_ms: @now - 1_000})
      assert reason =~ "machine's boot"
      assert {:release, _} = judge(hb(), %{machine_booted_at_ms: @now - 86_400_000})
      assert {:release, _} = judge(hb(), %{machine_booted_at_ms: nil})
    end

    test "machine_booted_at_ms reads a plausible btime where /proc/stat exists" do
      case DaemonHeartbeat.machine_booted_at_ms() do
        nil -> refute File.exists?("/proc/stat")
        ms -> assert ms > 0 and ms < System.system_time(:millisecond)
      end
    end

    test "boots older than the window do not count" do
      at = @now - 3_000
      old = for k <- 1..5, do: @now - 600_001 - k
      assert {:release, _} = judge(hb(%{"at" => at, "booted_at" => at - 100_000, "boots" => old}))
    end
  end
end
