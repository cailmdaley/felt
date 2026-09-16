defmodule ShuttleWeb.FleetControllerTest do
  @moduledoc """
  `/api/v1/fleet`, `/api/v1/fleet/remotes` and `/api/v1/tunnels` — the fleet as
  rows, and the two verbs that shell the Go CLI to change it.

  Both halves are stubbed at the `:felt_runner` seam, so nothing here depends on
  a real felt being on the developer's PATH or on what that felt would say about
  the developer's own fleet. `FELT_REMOTES_FILE` points at a throwaway path for
  the same reason `test_helper.exs` pins it suite-wide: the file summary in the
  response resolves through it.
  """
  use ExUnit.Case
  import Shuttle.Test.ApiConn
  import Shuttle.Test.EnvHelpers
  import Phoenix.ConnTest

  alias Shuttle.{Remote, RemoteRegistry}

  @endpoint ShuttleWeb.Endpoint

  # The normalized document `felt shuttle remotes list --json` prints: defaults
  # applied, `url` derived, the tunnel manager resolved. One managed entry and
  # one reached directly, which is the distinction `tunnel_label` renders.
  @fleet_doc %{
    "launchd_label_prefix" => "io.shuttle",
    "defaults" => %{"poll_interval_ms" => 5_000},
    "remotes" => [
      %{
        "name" => "candide",
        "url" => "http://localhost:4001",
        "port" => 4001,
        "tunnel" => %{"manager" => "launchd"}
      },
      %{
        "name" => "cineca",
        "url" => "https://cineca.example.ts.net",
        "tunnel" => %{"manager" => "none"}
      }
    ]
  }

  # A felt whose reply is scripted per call and whose argv is recorded — the
  # only thing three of these four endpoints actually do.
  defmodule MockFelt do
    @behaviour Shuttle.Runner

    use Agent

    def start_link(_ \\ []),
      do:
        Agent.start_link(fn -> %{reply: fn _args -> {"", 0} end, calls: []} end, name: __MODULE__)

    def reply_with(fun), do: Agent.update(__MODULE__, &Map.put(&1, :reply, fun))
    def calls, do: Agent.get(__MODULE__, & &1.calls)
    def last_args, do: calls() |> List.last() |> elem(1)

    @impl true
    def cmd(command, args, _opts) do
      Agent.update(__MODULE__, fn s -> %{s | calls: s.calls ++ [{command, args}]} end)
      Agent.get(__MODULE__, & &1.reply).(args)
    end
  end

  # The remote daemon's `/api/v1/state`, carrying the build stamp the fleet row
  # joins in as its third claim ("which host is on which build").
  defmodule MockClient do
    @behaviour Shuttle.RemoteRegistry.Client

    @impl true
    def get("http://localhost:4001/api/v1/state", _timeout) do
      {:ok,
       Jason.encode!(%{
         "host" => "candide",
         "eligible" => [],
         "blocked" => [],
         "build" => %{"git_short_sha" => "abc1234", "booted_at" => "2026-09-16T09:00:00Z"}
       })}
    end

    def get(_url, _timeout), do: {:error, :econnrefused}
  end

  setup do
    previous_file = System.get_env("FELT_REMOTES_FILE")
    previous_runner = Application.get_env(:shuttle, :felt_runner)
    previous_remotes = Application.get_env(:shuttle, :remotes)

    path =
      Path.join(
        System.tmp_dir!(),
        "shuttle-fleet-ctrl-#{System.unique_integer([:positive])}.json"
      )

    System.put_env("FELT_REMOTES_FILE", path)
    Application.put_env(:shuttle, :remotes, [])
    Application.put_env(:shuttle, :felt_runner, MockFelt)
    start_supervised!(MockFelt)

    on_exit(fn ->
      File.rm(path)
      restore_env("FELT_REMOTES_FILE", previous_file)
      restore_app_env(:felt_runner, previous_runner)
      restore_app_env(:remotes, previous_remotes)
    end)

    {:ok, path: path}
  end

  # The registry under its production name, since `FleetController` reads it
  # there. `auto_poll: false` keeps the one poll this test drives deterministic.
  defp start_registry! do
    start_supervised!(
      {RemoteRegistry,
       name: RemoteRegistry,
       remotes: [
         %Remote{
           name: "candide",
           url: "http://localhost:4001",
           port: 4001,
           poll_interval_ms: 60_000,
           request_timeout_ms: 100,
           stale_multiplier: 2
         }
       ],
       client: MockClient,
       auto_poll: false,
       tick_interval_ms: 60_000}
    )

    :ok = RemoteRegistry.poll_now(RemoteRegistry)
  end

  describe "GET /api/v1/fleet" do
    test "joins the normalized file to live health and each remote's build", %{path: path} do
      File.write!(path, "{}")
      MockFelt.reply_with(fn _args -> {Jason.encode!(@fleet_doc), 0} end)
      start_registry!()

      conn = get(api_conn(), "/api/v1/fleet")

      assert conn.status == 200
      body = Jason.decode!(conn.resp_body)

      assert MockFelt.last_args() == ["shuttle", "remotes", "list", "--json"]
      assert body["host"] == Shuttle.Poller.own_host_id()
      assert body["error"] == nil
      assert body["launchd_label_prefix"] == "io.shuttle"
      assert body["defaults"] == %{"poll_interval_ms" => 5_000}
      assert body["file"]["id"] == "remotes"
      assert body["file"]["path"] == Path.expand(path)
      assert body["supervisor"] in ["launchd", "systemd", "none"]

      [candide, cineca] = body["remotes"]

      # Configured + reachable + running, kept as three claims.
      assert candide["name"] == "candide"
      assert candide["url"] == "http://localhost:4001"
      assert candide["health"]["polled"] == true
      assert candide["health"]["stale"] == false
      assert is_binary(candide["health"]["last_polled_at"])
      assert candide["health"]["last_error"] == nil
      assert candide["health"]["recovery"]["state"] == "healthy"
      assert candide["build"]["git_short_sha"] == "abc1234"

      # A managed tunnel has a job, so it gets the label the installer derives.
      assert candide["tunnel_label"] == "io.shuttle.shuttle-tunnel-candide"

      # Configured and never polled — a different claim from "polled and stale".
      assert cineca["health"] == %{
               "polled" => false,
               "stale" => true,
               "last_polled_at" => nil,
               "last_error" => nil,
               "recovery" => nil
             }

      assert cineca["build"] == nil
      # `manager: "none"` is reached directly; naming a label would invite the
      # reader to look for a job that correctly does not exist.
      assert cineca["tunnel_label"] == nil
    end

    test "a host with no registry at all still renders its fleet" do
      MockFelt.reply_with(fn _args -> {Jason.encode!(@fleet_doc), 0} end)

      conn = get(api_conn(), "/api/v1/fleet")

      assert conn.status == 200
      body = Jason.decode!(conn.resp_body)
      assert Enum.map(body["remotes"], & &1["name"]) == ["candide", "cineca"]
      assert Enum.all?(body["remotes"], &(&1["health"]["polled"] == false))
    end

    test "an unparseable fleet file surfaces felt's diagnostic, not a 500" do
      MockFelt.reply_with(fn _args ->
        {~s(remotes.json: remote "hub-a": port 4001 already used by "hub-b"\n), 1}
      end)

      conn = get(api_conn(), "/api/v1/fleet")

      assert conn.status == 200
      body = Jason.decode!(conn.resp_body)

      # Empty rows — the daemon itself degrades to an empty fleet here — but the
      # reason reaches the screen, or the page reads "no remotes configured"
      # over a file full of them.
      assert body["remotes"] == []
      assert body["error"] == ~s(remotes.json: remote "hub-a": port 4001 already used by "hub-b")
      assert body["defaults"] == %{}
      assert body["launchd_label_prefix"] == nil
    end

    test "a host with no fleet file at all is an empty fleet, not an error" do
      MockFelt.reply_with(fn _args -> {"", 0} end)

      conn = get(api_conn(), "/api/v1/fleet")

      assert conn.status == 200
      body = Jason.decode!(conn.resp_body)
      assert body["remotes"] == []
      assert body["error"] == nil
      assert body["file"]["exists"] == false
    end
  end

  describe "POST /api/v1/fleet/remotes" do
    test "passes only the flags the caller actually set" do
      conn = post_json("/api/v1/fleet/remotes", %{"name" => "hub-a"})

      assert conn.status == 200
      body = Jason.decode!(conn.resp_body)
      assert body["ok"] == true
      assert body["host"] == Shuttle.Poller.own_host_id()

      # A sparse entry stays sparse: a flag we invented a default for would be
      # written into the file and take its portability away.
      assert MockFelt.last_args() == ["shuttle", "remotes", "add", "hub-a"]
    end

    test "builds the argv from the flags that are present" do
      conn =
        post_json("/api/v1/fleet/remotes", %{
          "name" => "hub-a",
          "ssh" => " hub-a ",
          "port" => 4001,
          "remote_port" => "4000",
          "tunnel_manager" => "launchd",
          "multiplex" => true,
          "display" => "",
          "checkout" => nil
        })

      assert conn.status == 200

      assert MockFelt.last_args() == [
               "shuttle",
               "remotes",
               "add",
               "hub-a",
               "--ssh",
               "hub-a",
               "--tunnel-manager",
               "launchd",
               "--port",
               "4001",
               "--remote-port",
               "4000",
               "--multiplex"
             ]
    end

    test "remove: true is the rm verb, with no flags at all" do
      conn =
        post_json("/api/v1/fleet/remotes", %{"name" => "hub-a", "remove" => true, "port" => 4001})

      assert conn.status == 200
      assert MockFelt.last_args() == ["shuttle", "remotes", "rm", "hub-a"]
    end

    test "a missing name is a 400, and felt is never run" do
      conn = post_json("/api/v1/fleet/remotes", %{"port" => 4001})

      assert conn.status == 400
      assert Jason.decode!(conn.resp_body)["error"] == "name is required"
      assert MockFelt.calls() == []
    end

    test "felt's refusal is relayed as a 400, in its own words" do
      MockFelt.reply_with(fn _args -> {~s(port 4001 already used by "hub-b"\n), 1} end)

      conn = post_json("/api/v1/fleet/remotes", %{"name" => "hub-a", "port" => 4001})

      assert conn.status == 400
      assert Jason.decode!(conn.resp_body)["error"] == ~s(port 4001 already used by "hub-b")
    end
  end

  describe "POST /api/v1/tunnels" do
    test "preview is the CLI's own --dry-run, and is the default" do
      assert post_json("/api/v1/tunnels", %{"action" => "preview"}).status == 200
      assert MockFelt.last_args() == ["shuttle", "tunnels", "install", "--dry-run"]

      assert post_json("/api/v1/tunnels", %{}).status == 200
      assert MockFelt.last_args() == ["shuttle", "tunnels", "install", "--dry-run"]
    end

    test "install carries no flag" do
      conn = post_json("/api/v1/tunnels", %{"action" => "install"})

      assert conn.status == 200
      assert Jason.decode!(conn.resp_body)["ok"] == true
      assert MockFelt.last_args() == ["shuttle", "tunnels", "install"]
    end

    test "a named remote narrows the job set" do
      assert post_json("/api/v1/tunnels", %{"action" => "install", "name" => " candide "}).status ==
               200

      assert MockFelt.last_args() == ["shuttle", "tunnels", "install", "candide"]
    end

    test "an unknown action is a 400 naming the two, and felt is never run" do
      conn = post_json("/api/v1/tunnels", %{"action" => "uninstall"})

      assert conn.status == 400
      body = Jason.decode!(conn.resp_body)
      assert body["error"] =~ ~s(unknown action "uninstall")
      assert body["error"] =~ "preview, install"
      assert MockFelt.calls() == []
    end
  end

  defp post_json(path, payload), do: post(api_conn(), path, Jason.encode!(payload))
end
