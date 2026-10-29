defmodule Shuttle.OriginRouterTest do
  use ExUnit.Case, async: true

  import ExUnit.CaptureLog
  require Logger

  alias Shuttle.{OriginRouter, Remote}

  @remotes [%{name: "candide", url: "http://localhost:4001"}]

  defmodule StreamClient do
    def stream_get(url, headers, owner, timeout) do
      send(owner, {:stream_request, url, headers, owner, timeout})
      Shuttle.Env.app(:stream_result, {:ok, :opaque_stream})
    end
  end

  defmodule ReadOnlyClient do
    def get(_url, _timeout), do: {:ok, "{}"}
  end

  describe "forward_stream/4" do
    setup do
      Shuttle.Test.Env.put_app_env(:write_forward_client, StreamClient)
      {:ok, remote: %Remote{name: "owner", url: "http://localhost:4001"}}
    end

    test "strips both origin keys and forwards the URL, headers, owner and connect timeout", %{
      remote: remote
    } do
      owner = self()
      headers = [{"accept", "text/event-stream"}]

      assert {:ok, :opaque_stream} =
               OriginRouter.forward_stream(
                 remote,
                 "/api/v1/transcript/stream",
                 %{:origin => "hub", "origin" => "owner", "host" => "local", "offset" => "42"},
                 req_headers: headers,
                 owner: owner,
                 connect_timeout_ms: 1234
               )

      assert_receive {:stream_request, url, ^headers, ^owner, 1234}

      assert %URI{host: "localhost", port: 4001, path: "/api/v1/transcript/stream", query: query} =
               URI.parse(url)

      assert URI.decode_query(query) == %{"host" => "local", "offset" => "42"}
    end

    test "defaults to the calling process, no headers and a bounded connect timeout", %{
      remote: remote
    } do
      owner = self()
      assert {:ok, :opaque_stream} = OriginRouter.forward_stream(remote, "/stream", %{})
      assert_receive {:stream_request, _url, [], ^owner, 15_000}
    end

    test "returns transport errors without changing their shape", %{remote: remote} do
      Shuttle.Test.Env.put_app_env(:stream_result, {:error, :econnrefused})
      assert {:error, :econnrefused} = OriginRouter.forward_stream(remote, "/stream", %{})
    end

    test "refuses a client without stream_get instead of buffering a GET", %{remote: remote} do
      Shuttle.Test.Env.put_app_env(:write_forward_client, ReadOnlyClient)

      assert {:error, :stream_not_supported} =
               OriginRouter.forward_stream(remote, "/stream", %{"origin" => "owner"})
    end
  end

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

    test "an explicit unknown origin is refused instead of selecting a local mirror" do
      assert {:error, {:unknown_origin, "stale-remote"}} =
               OriginRouter.route("stale-remote", own_host_id: "laptop", remotes: @remotes)

      assert OriginRouter.unknown_origin_message("stale-remote",
               own_host_id: "laptop",
               remotes: @remotes
             ) =~
               ~s(unknown origin "stale-remote": not in this daemon's fleet)
    end

    test "a matching local/known-remote origin never logs" do
      # The capture sees every process's logs, including concurrent async
      # tests', so only the lines this process emitted count: route/2 logs on
      # its caller. A control line logged here proves the filter sees them.
      own_pid = "pid=#{:erlang.pid_to_list(self())}"

      log =
        capture_log([format: "$metadata| $message\n", metadata: [:pid]], fn ->
          OriginRouter.route("candide", own_host_id: "laptop", remotes: @remotes)
          OriginRouter.route(nil, own_host_id: "laptop", remotes: @remotes)
          Logger.warning("origin-router-test control line")
        end)

      assert [control] =
               log |> String.split("\n", trim: true) |> Enum.filter(&(&1 =~ own_pid))

      assert control =~ "origin-router-test control line"
    end

    test "C6: routes through the same normalize_remotes primitive the registries use — a keyword-list remote entry resolves identically to a map one" do
      kw_remotes = [[name: "candide", url: "http://localhost:4001"]]

      assert {:remote, %Remote{name: "candide", url: "http://localhost:4001"}} =
               OriginRouter.route("candide", own_host_id: "laptop", remotes: kw_remotes)
    end
  end
end
