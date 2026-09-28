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
end
