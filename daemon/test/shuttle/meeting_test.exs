defmodule Shuttle.Test.MeetingRunner do
  @behaviour Shuttle.Runner

  def cmd(command, args, opts) do
    Process.put(:meeting_calls, [{command, args, opts} | Process.get(:meeting_calls, [])])

    case Process.get(:meeting_runner_fun) do
      nil -> default(command, args)
      fun -> fun.(command, args, opts)
    end
  end

  def calls, do: Enum.reverse(Process.get(:meeting_calls, []))

  defp default("tmux", ["display-message" | _]), do: {"can't find session: hark-meeting", 1}
  defp default(_command, _args), do: {"", 0}
end

defmodule Shuttle.MeetingTest do
  use ExUnit.Case, async: false

  import Phoenix.ConnTest
  import Shuttle.Test.ApiConn

  @endpoint ShuttleWeb.Endpoint
  @moduletag :tmp_dir
  @config_keys [:meeting_runner, :hark_dir, :hark_path, :remotes]

  setup %{tmp_dir: tmp_dir} do
    previous = Map.new(@config_keys, &{&1, Application.fetch_env(:shuttle, &1)})
    hark_dir = Path.join(tmp_dir, "hark")
    hark_path = Path.join(tmp_dir, "hark-bin")
    File.mkdir_p!(hark_dir)
    File.write!(hark_path, "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$MEETING_ARGV_FILE\"\n")
    File.chmod!(hark_path, 0o755)

    Application.put_env(:shuttle, :meeting_runner, Shuttle.Test.MeetingRunner)
    Application.put_env(:shuttle, :hark_dir, hark_dir)
    Application.put_env(:shuttle, :hark_path, hark_path)
    Application.put_env(:shuttle, :remotes, [])
    Process.put(:meeting_calls, [])
    Process.delete(:meeting_runner_fun)
    Process.delete(:meeting_script)

    on_exit(fn ->
      Enum.each(previous, fn
        {key, {:ok, value}} -> Application.put_env(:shuttle, key, value)
        {key, :error} -> Application.delete_env(:shuttle, key)
      end)
    end)

    %{tmp_dir: tmp_dir, hark_dir: hark_dir, hark_path: hark_path}
  end

  test "derive prioritizes a verified live process, then tmux, then dead-pane outcome" do
    metadata = %{
      "phase" => "live",
      "title" => "shear telecon",
      "host" => nil,
      "fiber" => "work/meetings/shear",
      "started" => "2026-09-25T14:03:12+02:00",
      "transcript" => "/tmp/meeting.txt"
    }

    for phase <- ["loading", "live", "local", "stopping"] do
      {row, false} = Shuttle.Meeting.derive(:absent, Map.put(metadata, "phase", phase), true)
      assert row.state == phase
      assert row.tmux_session == nil
    end

    {live, false} = Shuttle.Meeting.derive({:dead, 1}, metadata, true)
    assert %{state: "live", tmux_session: "hark-meeting", title: "shear telecon"} = live
    assert live.started_at == metadata["started"]

    {starting, false} = Shuttle.Meeting.derive(:alive, metadata, false)

    assert %{state: "starting", tmux_session: "hark-meeting", fiber: "work/meetings/shear"} =
             starting

    {nil, false} = Shuttle.Meeting.derive(:absent, metadata, false)
    {nil, true} = Shuttle.Meeting.derive({:dead, 0}, %{"phase" => "ended"}, false)

    {failed, false} =
      Shuttle.Meeting.derive(
        {:dead, 1},
        Map.put(metadata, "error", "scribe setup failed"),
        false,
        "pane tail"
      )

    assert %{state: "failed", error: "scribe setup failed", tmux_session: "hark-meeting"} = failed

    {failed_without_metadata, false} =
      Shuttle.Meeting.derive({:dead, 2}, nil, false, "last pane line")

    assert %{state: "failed", error: "last pane line"} = failed_without_metadata
  end

  test "command arguments keep local and remote scribe selection separate" do
    local = %{
      "title" => "shear telecon",
      "host" => "local",
      "project_dir" => "/work/project with spaces",
      "under" => "work/unions",
      "mode" => "call"
    }

    assert {:ok, local_argv} = Shuttle.Meeting.command_args(local, "/opt/hark")

    assert [
             "/opt/hark",
             "meeting",
             "--project",
             "/work/project with spaces",
             "--under",
             "work/unions",
             "--title",
             "shear telecon"
           ] = local_argv

    refute "--host" in local_argv
    refute "--room" in local_argv

    Application.put_env(:shuttle, :remotes, [
      %{name: "scribe", ssh: "scribe-ssh", url: "http://127.0.0.1:4001"}
    ])

    remote = %{local | "host" => "scribe", "mode" => "room", "title" => "signal 'and' shear"}
    assert {:ok, remote_argv} = Shuttle.Meeting.command_args(remote, "/opt/hark")

    assert [
             "/opt/hark",
             "meeting",
             "--project",
             "/work/project with spaces",
             "--under",
             "work/unions",
             "--title",
             "signal 'and' shear",
             "--host",
             "scribe-ssh",
             "--room"
           ] = remote_argv

    assert {:error, {:validation, message}} =
             Shuttle.Meeting.command_args(%{local | "host" => "unknown"}, "/opt/hark")

    assert message =~ "unknown remote"

    assert {:error, {:validation, under_error}} =
             Shuttle.Meeting.command_args(%{local | "under" => "../outside"}, "/opt/hark")

    assert under_error =~ "loom-relative"

    Application.put_env(:shuttle, :remotes, [
      %{name: "web-only", url: "https://example.invalid"}
    ])

    assert {:error, {:validation, ssh_error}} =
             Shuttle.Meeting.command_args(%{local | "host" => "web-only"}, "/opt/hark")

    assert ssh_error =~ "no SSH alias"
  end

  test "start creates a detached session and safely quotes the full hark argv", %{
    hark_path: hark_path
  } do
    params = %{
      "title" => "telecon with 'quotes'; echo unsafe",
      "host" => "local",
      "project_dir" => "/project with spaces",
      "under" => "work/unions",
      "mode" => "room"
    }

    script([{"can't find session: hark-meeting", 1}, {"", 0}, {"0 ", 0}])

    assert {:ok, %{available: true, meeting: %{state: "starting", tmux_session: "hark-meeting"}}} =
             Shuttle.Meeting.start(params)

    assert [
             {"tmux", ["display-message" | _], _},
             {"tmux", ["new-session" | new_args], _},
             {"tmux", ["display-message" | _], _}
           ] =
             Shuttle.Test.MeetingRunner.calls()

    assert Enum.take(new_args, 6) == [
             "-d",
             "-s",
             "hark-meeting",
             "-c",
             System.fetch_env!("HOME"),
             "--"
           ]

    [command | session_commands] = Enum.drop(new_args, 6)
    assert command =~ "'telecon with '\\''quotes'\\''; echo unsafe'"

    assert session_commands == [
             ";",
             "set-option",
             "-w",
             "-t",
             "=hark-meeting",
             "remain-on-exit",
             "on"
           ]

    assert command =~ "'#{Path.expand(hark_path)}' 'meeting' '--project' '/project with spaces'"

    argv_file = Path.join(Path.dirname(hark_path), "captured-argv")
    System.cmd("sh", ["-c", command], env: [{"MEETING_ARGV_FILE", argv_file}])

    assert File.read!(argv_file)
           |> String.split("\n", trim: true) == [
             "meeting",
             "--project",
             "/project with spaces",
             "--under",
             "work/unions",
             "--title",
             "telecon with 'quotes'; echo unsafe",
             "--room"
           ]
  end

  test "start returns 422 for malformed requests before checking availability" do
    Application.put_env(:shuttle, :hark_path, false)

    conn = api_conn() |> post("/api/v1/meeting", Jason.encode!(%{}))
    assert conn.status == 422
    assert Jason.decode!(conn.resp_body)["error"] =~ "title is required"
  end

  test "the controller starts and stops a local session with 202 responses" do
    params = %{
      "title" => "shear telecon",
      "host" => "local",
      "project_dir" => "/project",
      "under" => "work/unions",
      "mode" => "call"
    }

    script([
      {"can't find session: hark-meeting", 1},
      {"", 0},
      {"0 ", 0},
      {"0 ", 0},
      {"", 0},
      {"can't find session: hark-meeting", 1}
    ])

    conn = api_conn() |> post("/api/v1/meeting", Jason.encode!(params))
    assert conn.status == 202
    assert Jason.decode!(conn.resp_body)["meeting"]["state"] == "starting"

    conn = api_conn() |> post("/api/v1/meeting/stop", Jason.encode!(%{}))
    assert conn.status == 202
    assert Jason.decode!(conn.resp_body)["meeting"] == nil
  end

  test "stop returns 404 when no meeting exists" do
    conn = api_conn() |> post("/api/v1/meeting/stop", Jason.encode!(%{}))
    assert conn.status == 404
  end

  test "start returns 422 for an unknown remote and 503 when hark is unavailable" do
    params = %{
      "title" => "shear telecon",
      "host" => "not-configured",
      "project_dir" => "/project",
      "under" => "work/unions",
      "mode" => "call"
    }

    conn = api_conn() |> post("/api/v1/meeting", Jason.encode!(params))
    assert conn.status == 422
    assert Jason.decode!(conn.resp_body)["error"] =~ "unknown remote"

    Application.put_env(:shuttle, :hark_path, false)
    conn = api_conn() |> post("/api/v1/meeting", Jason.encode!(%{params | "host" => "local"}))
    assert conn.status == 503
    assert Jason.decode!(conn.resp_body)["error"] =~ "hark is not available"
  end

  test "meeting routes stay local and report an active meeting as a conflict" do
    write_meeting(%{
      "pid" => 12345,
      "phase" => "live",
      "title" => "shear telecon",
      "host" => "scribe",
      "project" => "/remote/project",
      "under" => "work/unions",
      "fiber" => "work/unions/meetings/shear",
      "started" => "2026-09-25T14:03:12+02:00",
      "transcript" => nil,
      "error" => nil
    })

    stub_runner(fn
      "tmux", ["display-message" | _args], _opts -> {"0 ", 0}
      "ps", ["-p", "12345", "-o", "command="], _opts -> {"python /opt/hark meeting", 0}
      _command, _args, _opts -> {"", 0}
    end)

    conn = api_conn() |> get("/api/v1/meeting")
    assert conn.status == 200

    assert %{"available" => true, "meeting" => %{"state" => "live", "host" => "scribe"}} =
             Jason.decode!(conn.resp_body)

    Application.put_env(:shuttle, :remotes, [
      %{name: "scribe", ssh: "scribe-ssh", url: "http://127.0.0.1:4001"}
    ])

    params = %{
      "title" => "second meeting",
      "host" => "local",
      "project_dir" => "/project",
      "under" => "work/unions",
      "mode" => "call",
      "origin" => "scribe"
    }

    conn = api_conn() |> post("/api/v1/meeting", Jason.encode!(params))
    assert conn.status == 409
    assert Jason.decode!(conn.resp_body)["meeting"]["state"] == "live"

    refute Enum.any?(Shuttle.Test.MeetingRunner.calls(), fn {command, _args, _opts} ->
             command == "ssh"
           end)
  end

  test "stop sends one SIGINT to a live meeting and does not signal again while stopping", %{
    hark_dir: hark_dir
  } do
    write_meeting(%{
      "pid" => 321,
      "phase" => "live",
      "title" => "shear telecon",
      "transcript" => nil
    })

    stub_runner(fn
      "tmux", ["display-message" | _args], _opts ->
        {"0 ", 0}

      "ps", ["-p", "321", "-o", "command="], _opts ->
        {"python /opt/hark meeting", 0}

      "kill", ["-INT", "321"], _opts ->
        File.write!(
          Path.join(hark_dir, "meeting.json"),
          Jason.encode!(%{"pid" => 321, "phase" => "stopping", "title" => "shear telecon"})
        )

        {"", 0}

      _command, _args, _opts ->
        {"", 0}
    end)

    assert {:ok, %{meeting: %{state: "stopping"}}} = Shuttle.Meeting.stop()

    assert Enum.count(Shuttle.Test.MeetingRunner.calls(), fn {command, args, _opts} ->
             command == "kill" and args == ["-INT", "321"]
           end) == 1

    Process.put(:meeting_calls, [])
    assert {:ok, %{meeting: %{state: "stopping"}}} = Shuttle.Meeting.stop()

    refute Enum.any?(Shuttle.Test.MeetingRunner.calls(), fn {command, _args, _opts} ->
             command == "kill"
           end)
  end

  test "stop kills a starting session and dismisses a failed dead pane", %{hark_dir: hark_dir} do
    script([{"0 ", 0}, {"", 0}, {"can't find session: hark-meeting", 1}])
    assert {:ok, %{meeting: nil}} = Shuttle.Meeting.stop()

    assert Enum.any?(Shuttle.Test.MeetingRunner.calls(), fn
             {"tmux", ["kill-session" | _], _} -> true
             _ -> false
           end)

    Process.put(:meeting_calls, [])

    write_meeting(%{
      "pid" => 654,
      "phase" => "failed",
      "title" => "failed setup",
      "error" => "model load failed"
    })

    script([
      {"1 1", 0},
      {"", 1},
      {"last pane line\n", 0},
      {"", 0},
      {"can't find session: hark-meeting", 1},
      {"", 1}
    ])

    assert {:ok, %{meeting: nil}} = Shuttle.Meeting.stop()
    calls = Shuttle.Test.MeetingRunner.calls()

    assert Enum.any?(calls, fn
             {"tmux", ["kill-session" | _], _} -> true
             _ -> false
           end)

    refute Enum.any?(calls, fn
             {"kill", _args, _opts} -> true
             _ -> false
           end)

    assert File.exists?(Path.join(hark_dir, "meeting.json"))
  end

  test "clean ended capture reaps its dead tmux session" do
    write_meeting(%{"phase" => "ended", "title" => "complete"})

    script([
      {"1 0", 0},
      {"", 0},
      {"can't find session: hark-meeting", 1}
    ])

    assert {:ok, %{meeting: nil}} = Shuttle.Meeting.show()

    assert Enum.count(Shuttle.Test.MeetingRunner.calls(), fn
             {"tmux", ["kill-session" | _], _} -> true
             _ -> false
           end) == 1
  end

  test "last transcript line skips comments and reads only the meeting summary" do
    transcript = Path.join(Application.fetch_env!(:shuttle, :hark_dir), "transcript.txt")

    File.write!(
      transcript,
      "# started\n14:05:31 S1  first thought\n# marker\n14:05:40 S2  covariance looks fine\n# ended\n"
    )

    write_meeting(%{"pid" => 12, "phase" => "live", "transcript" => transcript})

    stub_runner(fn
      "tmux", ["display-message" | _args], _opts -> {"0 ", 0}
      "ps", ["-p", "12", "-o", "command="], _opts -> {"python hark meeting", 0}
      _command, _args, _opts -> {"", 0}
    end)

    assert {:ok, %{meeting: %{state: "live", last_line: "14:05:40 S2  covariance looks fine"}}} =
             Shuttle.Meeting.show()
  end

  defp write_meeting(data) do
    dir = Application.fetch_env!(:shuttle, :hark_dir)
    File.write!(Path.join(dir, "meeting.json"), Jason.encode!(data))
  end

  defp stub_runner(fun), do: Process.put(:meeting_runner_fun, fun)

  defp script(responses) do
    Process.put(:meeting_script, responses)

    stub_runner(fn command, args, _opts ->
      case Process.get(:meeting_script) do
        [response | rest] ->
          Process.put(:meeting_script, rest)
          response

        [] ->
          flunk("unexpected command: #{command} #{inspect(args)}")
      end
    end)
  end
end
