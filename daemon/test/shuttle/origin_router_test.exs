defmodule Shuttle.OriginRouterTest do
  use ExUnit.Case, async: true

  import ExUnit.CaptureLog

  alias Shuttle.{OriginRouter, Remote}

  @remotes [%{name: "candide", url: "http://localhost:4001"}]

  describe "route/2" do
    test "nil/empty/local/own-host origins all route :local, quietly" do
      for origin <- [nil, "", "local", "laptop"] do
        assert OriginRouter.route(origin, own_host_id: "laptop", remotes: @remotes) == :local
      end
    end

    test "an origin matching a configured remote routes to it" do
      assert {:remote, %Remote{name: "candide"}} =
               OriginRouter.route("candide", own_host_id: "laptop", remotes: @remotes)
    end

    test "C6: an unknown, remote-shaped origin still degrades to :local (never a silent wrong-host write) but logs a warning" do
      log =
        capture_log(fn ->
          assert OriginRouter.route("stale-remote", own_host_id: "laptop", remotes: @remotes) ==
                   :local
        end)

      assert log =~ "stale-remote"
      assert log =~ "OriginRouter"
    end

    test "a matching local/known-remote origin never logs" do
      # The capture sees every process's logs, including concurrent async
      # tests', so only the lines this process emitted count: route/2 logs on
      # its caller.
      own_pid = "pid=#{:erlang.pid_to_list(self())}"

      log =
        capture_log([format: "$metadata| $message\n", metadata: [:pid]], fn ->
          OriginRouter.route("candide", own_host_id: "laptop", remotes: @remotes)
          OriginRouter.route(nil, own_host_id: "laptop", remotes: @remotes)
        end)

      assert log |> String.split("\n", trim: true) |> Enum.filter(&(&1 =~ own_pid)) == []
    end

    test "C6: routes through the same normalize_remotes primitive the registries use — a keyword-list remote entry resolves identically to a map one" do
      kw_remotes = [[name: "candide", url: "http://localhost:4001"]]

      assert {:remote, %Remote{name: "candide", url: "http://localhost:4001"}} =
               OriginRouter.route("candide", own_host_id: "laptop", remotes: kw_remotes)
    end
  end
end
