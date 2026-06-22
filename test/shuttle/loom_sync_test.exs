defmodule Shuttle.LoomSyncTest do
  use ExUnit.Case, async: false

  alias Shuttle.LoomSync

  test "init returns :ignore when the interval is 0 (disabled)" do
    assert :ignore = GenServer.start_link(LoomSync, [interval_ms: 0, script: "/anything.sh"], [])
  end

  test "init returns :ignore when the sync script is absent" do
    assert :ignore =
             GenServer.start_link(LoomSync, [interval_ms: 1_000, script: "/no/such/loom-sync.sh"], [])
  end

  test "runs the sync script on the timer" do
    base = Path.join(System.tmp_dir!(), "loom_sync_#{System.unique_integer([:positive])}")
    script = base <> ".sh"
    marker = base <> ".marker"
    File.write!(script, "#!/usr/bin/env bash\ntouch \"#{marker}\"\n")
    File.chmod!(script, 0o755)
    on_exit(fn -> File.rm(script) && File.rm(marker) end)

    {:ok, pid} =
      GenServer.start_link(LoomSync, [script: script, interval_ms: 1_000, initial_delay_ms: 5], [])

    on_exit(fn -> if Process.alive?(pid), do: GenServer.stop(pid) end)

    assert wait_until(fn -> File.exists?(marker) end, 150),
           "expected loom-sync script to run and create #{marker}"
  end

  defp wait_until(_fun, 0), do: false

  defp wait_until(fun, attempts) do
    if fun.() do
      true
    else
      Process.sleep(20)
      wait_until(fun, attempts - 1)
    end
  end
end
