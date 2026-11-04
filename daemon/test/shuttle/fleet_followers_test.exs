defmodule Shuttle.FleetFollowersTest do
  use ExUnit.Case, async: true, group: :tailnet_peers

  defmodule Client do
    def get(_url, _timeout), do: {:ok, Jason.encode!(%{"fibers" => [], "running" => []})}
  end

  @tag :tmp_dir
  test "empty automatic followers observe the first configured remote", %{tmp_dir: dir} do
    path = Path.join(dir, "remotes.json")
    File.write!(path, ~s({"defaults":{"discover":false},"remotes":[]}))
    Shuttle.Test.Env.delete_app_env(:remotes)
    Shuttle.Test.Env.put_env("SHUTTLE_REMOTES_FILE", path)

    health =
      start_supervised!({Shuttle.RemoteRegistry, name: nil, client: Client, tick_interval_ms: 5})

    fibers =
      start_supervised!(
        {Shuttle.RemoteFiberRegistry,
         name: nil, client: Client, tick_interval_ms: 5, store_dir: Path.join(dir, "feeds")}
      )

    File.write!(
      path,
      ~s({"defaults":{"discover":false},"remotes":[{"name":"peer-a","port":4401}]})
    )

    assert Enum.map(
             [
               {health, &Shuttle.RemoteRegistry.snapshots/1},
               {fibers, &Shuttle.RemoteFiberRegistry.feeds/1}
             ],
             fn {pid, read} -> await_remote(pid, read) end
           ) == [true, true]
  end

  defp await_remote(pid, read, attempts \\ 200)
  defp await_remote(pid, read, 0), do: Map.has_key?(read.(pid), "peer-a")

  defp await_remote(pid, read, attempts) do
    if Map.has_key?(read.(pid), "peer-a") do
      true
    else
      receive do
      after
        5 -> await_remote(pid, read, attempts - 1)
      end
    end
  end
end
