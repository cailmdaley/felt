defmodule Shuttle.Test.MeetingRunner do
  use Agent

  def start_link(_opts) do
    Agent.start_link(fn -> %{handler: &default/4, custom: nil, calls: []} end, name: __MODULE__)
  end

  def set_handler(handler, custom \\ nil) do
    Agent.update(__MODULE__, &%{&1 | handler: handler, custom: custom, calls: []})
  end

  def calls, do: Agent.get(__MODULE__, &Enum.reverse(&1.calls))
  def custom, do: Agent.get(__MODULE__, & &1.custom)
  def set_custom(value), do: Agent.update(__MODULE__, &%{&1 | custom: value})

  def cmd(command, args, opts) do
    Agent.get_and_update(__MODULE__, fn state ->
      {response, custom} = state.handler.(command, args, opts, state.custom)
      {response, %{state | custom: custom, calls: [{command, args, opts} | state.calls]}}
    end)
  end

  defp default("tmux", ["display-message" | _], _opts, custom),
    do: {{"can't find session: hark-meeting", 1}, custom}

  defp default(_command, _args, _opts, custom), do: {{"", 0}, custom}
end

defmodule Shuttle.Test.MeetingCaptureForwardClient do
  use Agent

  def start_link(response),
    do: Agent.start_link(fn -> %{response: response, last: nil} end, name: __MODULE__)

  def last, do: Agent.get(__MODULE__, & &1.last)

  def post(url, body, _content_type, _timeout_ms) do
    Agent.update(__MODULE__, &Map.put(&1, :last, %{url: url, body: body}))
    Agent.get(__MODULE__, & &1.response)
  end
end

defmodule Shuttle.MeetingTest do
  use ExUnit.Case, async: false

  import Phoenix.ConnTest
  import Shuttle.Test.ApiConn

  alias Shuttle.Meeting

  @endpoint ShuttleWeb.Endpoint
  @moduletag :tmp_dir
  @config_keys [
    :meeting_runner,
    :hark_dir,
    :hark_path,
    :remotes,
    :own_host_id,
    :write_forward_client,
    :meeting_now,
    :meeting_launch_wait_ms
  ]
  @tmux_format "\#{pane_dead}|\#{pane_dead_status}|\#{session_created}|\#{@hark_launch}"

  setup %{tmp_dir: tmp_dir} do
    previous = Map.new(@config_keys, &{&1, Application.fetch_env(:shuttle, &1)})
    hark_dir = Path.join(tmp_dir, "hark")
    hark_path = Path.join(tmp_dir, "hark-bin")
    File.mkdir_p!(hark_dir)
    File.write!(hark_path, "#!/bin/sh\nexit 0\n")
    File.chmod!(hark_path, 0o755)

    start_supervised!(Shuttle.Test.MeetingRunner)
    Application.put_env(:shuttle, :meeting_runner, Shuttle.Test.MeetingRunner)
    Application.put_env(:shuttle, :hark_dir, hark_dir)
    Application.put_env(:shuttle, :hark_path, hark_path)
    Application.put_env(:shuttle, :remotes, [])
    Application.put_env(:shuttle, :own_host_id, "local-host")
    Application.put_env(:shuttle, :meeting_now, ~N[2026-09-25 14:03:12])
    Meeting.Control.reconcile(nil)

    on_exit(fn ->
      Meeting.Control.reconcile(nil)

      Enum.each(previous, fn
        {key, {:ok, value}} -> Application.put_env(:shuttle, key, value)
        {key, :error} -> Application.delete_env(:shuttle, key)
      end)
    end)

    %{tmp_dir: tmp_dir, hark_dir: hark_dir, hark_path: hark_path}
  end

  test "meeting name and title use the trimmed first line and at most six slug words" do
    now = ~N[2026-09-25 14:03:12]

    assert {"2026-09-25_1403_unions-shear-telecon-about-cross-correlations-and",
            "UNIONS shear telecon about cross-correlations and likelihoods for the next relea"} =
             Meeting.name_and_title(
               "UNIONS shear telecon about cross-correlations and likelihoods for the next release\nsecond line",
               now
             )

    assert {"2026-09-25_1403", "Meeting"} = Meeting.name_and_title("\nsecond line", now)

    assert {"2026-09-25_1403_cosmic-shear", "Cósmić shear"} =
             Meeting.name_and_title("Cósmić shear", now)
  end

  test "meeting message carries the facts and points at the skill's meeting reference" do
    call = Meeting.meeting_message("call", "/tmp/meetings/session.txt")
    room = Meeting.meeting_message("room", "/tmp/meetings/session.txt")

    assert call =~ "Meeting mode (call)."
    assert room =~ "Meeting mode (room)."
    assert call =~ "`/tmp/meetings/session.txt` on this host"
    assert call =~ "references/meeting.md"
    assert call =~ "The user's note about the meeting follows (it may be empty)."
  end

  test "an ended recording that carries an error is a failure, not a clean end" do
    dead = %{state: {:dead, 0}, session_created: 1, launch: "L1"}
    ended = %{"launch" => "L1", "phase" => "ended", "title" => "t", "error" => nil}

    assert {nil, true} = Meeting.derive(dead, ended, false)

    unfinished =
      Map.put(ended, "error", "mirror incomplete; resume with: hark mirror --resume a b")

    assert {%{state: "failed", error: "mirror incomplete; resume with: hark mirror --resume a b"},
            false} = Meeting.derive(dead, unfinished, false)
  end

  test "local and remote origins select the transcript path and mirror alias" do
    remotes = [%{name: "project-host", ssh: "remote-alias", url: "http://127.0.0.1:4001"}]
    Application.put_env(:shuttle, :remotes, remotes)
    opts = [hark_dir: "/tmp/hark-root", own_host_id: "local-host", remotes: remotes]

    assert {:ok,
            %{
              transcript: "/tmp/hark-root/meetings/session.txt",
              local_transcript: "/tmp/hark-root/meetings/session.txt",
              mirror: nil,
              mirror_host: nil
            }} = Meeting.meeting_paths("session", "local-host", opts)

    assert {:ok,
            %{
              transcript: "~/.hark/meetings/session.txt",
              local_transcript: "/tmp/hark-root/meetings/session.txt",
              mirror: "remote-alias:~/.hark/meetings/session.txt",
              mirror_host: "project-host"
            }} = Meeting.meeting_paths("session", "project-host", opts)

    assert {:error, {:validation, message}} =
             Meeting.meeting_paths("session", "web-only",
               hark_dir: "/tmp/hark-root",
               own_host_id: "local-host",
               remotes: [%{name: "web-only", url: "https://example.invalid"}]
             )

    assert message =~ "SSH alias"
  end

  test "pure state derivation rejects stale metadata and trusts terminal captures only while alive" do
    alive = %{state: :alive, session_created: 1_790_328_192, launch: "launch-new"}
    dead = %{state: {:dead, 7}, session_created: 1_790_328_192, launch: "launch-new"}

    stale = %{
      "launch" => "launch-old",
      "phase" => "ended",
      "title" => "stale title",
      "transcript" => "/tmp/stale.txt",
      "mirror" => "old-alias:~/.hark/meetings/stale.txt",
      "error" => "stale error"
    }

    {starting, false} = Meeting.derive(alive, stale, false)

    assert %{
             state: "starting",
             title: nil,
             started_at: nil,
             transcript: nil,
             mirror_host: nil,
             last_line: nil,
             error: nil
           } = starting

    {failed, false} = Meeting.derive(%{dead | state: {:dead, 0}}, stale, false, "pane tail")
    assert %{state: "failed", title: nil, transcript: nil, error: "pane tail"} = failed

    fresh_ended = %{"launch" => "launch-new", "phase" => "ended", "title" => "complete"}
    {nil, true} = Meeting.derive(%{dead | state: {:dead, 0}}, fresh_ended, false)

    active = %{
      "launch" => "launch-new",
      "phase" => "live",
      "pid" => 321,
      "title" => "current meeting",
      "started" => "2026-09-25T14:03:12+02:00",
      "transcript" => "/tmp/current.txt",
      "mirror" => "remote-alias:~/.hark/meetings/current.txt"
    }

    Application.put_env(:shuttle, :remotes, [
      %{name: "project-host", ssh: "remote-alias", url: "http://127.0.0.1:4001"}
    ])

    {live, false} = Meeting.derive(alive, active, true)

    assert %{state: "live", title: "current meeting", mirror_host: "project-host"} = live

    {starting_with_fresh_data, false} = Meeting.derive(alive, active, false)

    assert %{state: "starting", title: "current meeting", transcript: "/tmp/current.txt"} =
             starting_with_fresh_data

    {unmapped, false} =
      Meeting.derive(alive, Map.put(active, "mirror", "unknown-alias:path"), true)

    assert %{mirror_host: "unknown-alias"} = unmapped

    {terminal, false} = Meeting.derive(:absent, Map.delete(active, "launch"), true)
    assert %{state: "live", tmux_session: nil} = terminal
    {nil, false} = Meeting.derive(:absent, Map.put(active, "phase", "ended"), false)
  end

  test "tmux output parser distinguishes alive, dead exit status, and absent sessions" do
    assert {:ok, %{state: :alive, session_created: 1234, launch: "launch-a"}} =
             Meeting.parse_tmux_result("0|0|1234|launch-a\n", 0)

    assert {:ok, %{state: {:dead, 17}, session_created: 1234, launch: nil}} =
             Meeting.parse_tmux_result("1|17|1234|\n", 0)

    assert {:ok, :absent} = Meeting.parse_tmux_result("can't find session: throwaway", 1)
    assert {:error, {:tmux, _}} = Meeting.parse_tmux_result("garbled", 0)
  end

  @tag :tmux
  @tag skip: is_nil(System.find_executable("tmux"))
  test "real tmux accepts pane targets and retains a fast-exiting pane" do
    tmux = System.find_executable("tmux")
    unique = System.unique_integer([:positive])
    server = "meeting-test-#{unique}"
    alive_session = "meeting-alive-#{unique}"
    fast_session = "meeting-fast-#{unique}"

    tmux_cmd = fn args -> System.cmd(tmux, ["-L", server | args], stderr_to_stdout: true) end
    cleanup = fn name -> tmux_cmd.(["kill-session", "-t", "=" <> name]) end

    on_exit(fn ->
      _ = cleanup.(alive_session)
      _ = cleanup.(fast_session)
      _ = tmux_cmd.(["kill-server"])
    end)

    {_, 0} =
      tmux_cmd.([
        "new-session",
        "-d",
        "-P",
        "-F",
        IO.iodata_to_binary(["#", "{session_id}"]),
        "-s",
        alive_session,
        "-c",
        System.fetch_env!("HOME"),
        "--",
        "sleep 30",
        ";",
        "set-option",
        "-s",
        "-t",
        "=" <> alive_session,
        "@hark_launch",
        "throwaway-launch",
        ";",
        "set-option",
        "-w",
        "-t",
        "=" <> alive_session <> ":",
        "remain-on-exit",
        "on"
      ])

    {alive_output, 0} =
      tmux_cmd.(["display-message", "-p", "-t", "=" <> alive_session <> ":", @tmux_format])

    assert {:ok, %{state: :alive, launch: "throwaway-launch"}} =
             Meeting.parse_tmux_result(alive_output, 0)

    assert {"on\n", 0} =
             tmux_cmd.([
               "show-options",
               "-w",
               "-v",
               "-t",
               "=" <> alive_session <> ":",
               "remain-on-exit"
             ])

    assert {_, 0} =
             tmux_cmd.(["capture-pane", "-p", "-t", "=" <> alive_session <> ":"])

    {_, 0} =
      tmux_cmd.([
        "new-session",
        "-d",
        "-s",
        fast_session,
        "--",
        "exec sh -c 'exit 17'",
        ";",
        "set-option",
        "-w",
        "-t",
        "=" <> fast_session <> ":",
        "remain-on-exit",
        "on"
      ])

    {dead_output, dead_status} = wait_for_dead_pane(tmux_cmd, fast_session, @tmux_format, 50)

    assert dead_status == 0
    assert {:ok, %{state: {:dead, 17}}} = Meeting.parse_tmux_result(dead_output, 0)

    {absent_output, absent_status} =
      tmux_cmd.(["has-session", "-t", "=absent-#{unique}"])

    assert {:ok, :absent} = Meeting.parse_tmux_result(absent_output, absent_status)
  end

  test "GET reports the v2 row and POST meeting start is removed", %{hark_dir: hark_dir} do
    write_meeting(hark_dir, %{
      "launch" => "launch-current",
      "pid" => 321,
      "phase" => "live",
      "title" => "shear telecon",
      "started" => "2026-09-25T14:03:12+02:00",
      "transcript" => Path.join(hark_dir, "current.txt"),
      "mirror" => "remote-alias:~/.hark/meetings/current.txt"
    })

    Application.put_env(:shuttle, :remotes, [
      %{name: "project-host", ssh: "remote-alias", url: "http://127.0.0.1:4001"}
    ])

    set_current_meeting_handler("launch-current", 321)

    conn = api_conn() |> get("/api/v1/meeting")
    assert conn.status == 200

    assert %{
             "available" => true,
             "meeting" => %{
               "state" => "live",
               "title" => "shear telecon",
               "started_at" => "2026-09-25T14:03:12+02:00",
               "mirror_host" => "project-host",
               "tmux_session" => "hark-meeting"
             }
           } = Jason.decode!(conn.resp_body)

    conn =
      api_conn() |> post("/api/v1/meeting", Jason.encode!(%{"meeting" => %{"mode" => "call"}}))

    assert conn.status == 404
  end

  test "meeting mode starts locally, forwards a normal capture, and resolves the mirror name", %{
    hark_dir: hark_dir,
    tmp_dir: tmp_dir
  } do
    Application.put_env(:shuttle, :remotes, [
      %{name: "project-host", ssh: "remote-alias", url: "http://127.0.0.1:4001"}
    ])

    start_supervised!(
      {Shuttle.Test.MeetingCaptureForwardClient,
       {:ok, 200, Jason.encode!(%{"spawned" => true, "tmux_session" => "capture-session"})}}
    )

    Application.put_env(:shuttle, :write_forward_client, Shuttle.Test.MeetingCaptureForwardClient)
    set_starting_meeting_handler(hark_dir)

    conn =
      api_conn()
      |> post(
        "/api/v1/capture",
        Jason.encode!(%{
          "meeting" => %{"mode" => "room"},
          "prompt" => "Shear review\nDiscuss the residuals",
          "project_dir" => Path.join(tmp_dir, "remote-project"),
          "origin" => "project-host",
          "surface" => "app"
        })
      )

    assert conn.status == 422
    assert Jason.decode!(conn.resp_body)["error"] =~ "requires a terminal"

    refute Enum.any?(Shuttle.Test.MeetingRunner.calls(), fn {cmd, args, _} ->
             cmd == "tmux" and match?(["new-session" | _], args)
           end)

    conn =
      api_conn()
      |> post(
        "/api/v1/capture",
        Jason.encode!(%{
          "meeting" => %{"mode" => "room"},
          "prompt" => "Shear review\nDiscuss the residuals",
          "project_dir" => Path.join(tmp_dir, "remote-project"),
          "origin" => "project-host"
        })
      )

    assert conn.status == 200

    assert %{
             "spawned" => true,
             "meeting" => %{
               "state" => "live",
               "mirror_host" => "project-host",
               "transcript" => transcript
             }
           } = Jason.decode!(conn.resp_body)

    assert transcript =~ "meetings/2026-09-25_1403_shear-review.txt"
    refute File.exists?(Path.join(tmp_dir, "remote-project"))

    forwarded = Shuttle.Test.MeetingCaptureForwardClient.last()
    assert forwarded.url == "http://127.0.0.1:4001/api/v1/capture"
    request = Jason.decode!(forwarded.body)
    refute Map.has_key?(request, "meeting")
    refute Map.has_key?(request, "origin")
    assert request["surface"] == "cli"
    assert request["prompt"] =~ "Meeting mode (room)."
    assert request["prompt"] =~ "Discuss the residuals"

    new_session =
      Enum.find(Shuttle.Test.MeetingRunner.calls(), fn {cmd, args, _} ->
        cmd == "tmux" and match?(["new-session" | _], args)
      end)

    assert {"tmux", ["new-session" | args], _} = new_session
    command = List.last(Enum.take_while(args, &(&1 != ";")))
    assert command =~ "--mirror"
    assert command =~ "remote-alias:~/.hark/meetings/2026-09-25_1403_shear-review.txt"
    assert command =~ "--launch"
  end

  test "capture failure after hark starts returns the capture error and recording row", %{
    hark_dir: hark_dir
  } do
    set_starting_meeting_handler(hark_dir)

    conn =
      api_conn()
      |> post(
        "/api/v1/capture",
        Jason.encode!(%{"meeting" => %{"mode" => "call"}})
      )

    assert conn.status == 400

    assert %{
             "error" => "project_dir is required",
             "recording" => true,
             "meeting" => %{"state" => "live"}
           } = Jason.decode!(conn.resp_body)
  end

  test "meeting capture reports hark availability before attempting to start", %{
    hark_path: hark_path
  } do
    Application.put_env(:shuttle, :hark_path, false)

    conn =
      api_conn()
      |> post("/api/v1/capture", Jason.encode!(%{"meeting" => %{"mode" => "call"}}))

    assert conn.status == 503
    assert Jason.decode!(conn.resp_body)["error"] =~ "hark is not available"
    assert Shuttle.Test.MeetingRunner.calls() == []

    Application.put_env(:shuttle, :hark_path, hark_path)

    conn =
      api_conn()
      |> post(
        "/api/v1/capture",
        Jason.encode!(%{"meeting" => %{"mode" => "call"}, "surface" => "app"})
      )

    assert conn.status == 422
    assert Jason.decode!(conn.resp_body)["error"] =~ "requires a terminal"
  end

  test "a live meeting conflicts before a second tmux session can be created", %{
    hark_dir: hark_dir
  } do
    write_meeting(hark_dir, %{
      "launch" => "launch-current",
      "pid" => 321,
      "phase" => "live",
      "title" => "current meeting",
      "transcript" => "/tmp/current.txt"
    })

    set_current_meeting_handler("launch-current", 321)

    conn =
      api_conn()
      |> post(
        "/api/v1/capture",
        Jason.encode!(%{
          "meeting" => %{"mode" => "call"},
          "project_dir" => "/tmp/project"
        })
      )

    assert conn.status == 409
    assert Jason.decode!(conn.resp_body)["meeting"]["title"] == "current meeting"

    refute Enum.any?(Shuttle.Test.MeetingRunner.calls(), fn {cmd, args, _} ->
             cmd == "tmux" and match?(["new-session" | _], args)
           end)
  end

  test "concurrent starts serialize the idle check and session creation", %{hark_dir: hark_dir} do
    set_starting_meeting_handler(hark_dir)
    request = %{"mode" => "call"}

    results =
      1..2
      |> Task.async_stream(
        fn _ -> Meeting.start_capture(request, "", "local", "cli") end,
        timeout: 5_000
      )
      |> Enum.to_list()

    assert Enum.count(results, &match?({:ok, {:ok, _}}, &1)) == 1
    assert Enum.count(results, &match?({:ok, {:error, {:conflict, _}}}, &1)) == 1

    assert Enum.count(Shuttle.Test.MeetingRunner.calls(), fn {cmd, args, _} ->
             cmd == "tmux" and match?(["new-session" | _], args)
           end) == 1
  end

  test "concurrent and repeated stop requests signal a live pid only once", %{hark_dir: hark_dir} do
    write_meeting(hark_dir, %{
      "launch" => "launch-current",
      "pid" => 321,
      "phase" => "live",
      "title" => "current meeting",
      "transcript" => nil
    })

    set_current_meeting_handler("launch-current", 321)

    results =
      1..2
      |> Task.async_stream(fn _ -> Meeting.stop() end, timeout: 5_000)
      |> Enum.to_list()

    assert Enum.all?(results, &match?({:ok, {:ok, %{meeting: %{state: "live"}}}}, &1))
    assert {:ok, %{meeting: %{state: "live"}}} = Meeting.stop()

    assert Enum.count(Shuttle.Test.MeetingRunner.calls(), fn
             {"kill", ["-INT", "321"], _} -> true
             _ -> false
           end) == 1
  end

  test "a transient pid probe failure does not release a live meeting's stop claim", %{
    hark_dir: hark_dir
  } do
    write_meeting(hark_dir, %{
      "launch" => "launch-current",
      "pid" => 321,
      "phase" => "live",
      "title" => "current meeting",
      "transcript" => nil
    })

    set_current_meeting_handler("launch-current", 321)
    assert {:ok, %{meeting: %{state: "live"}}} = Meeting.stop()

    Shuttle.Test.MeetingRunner.set_custom(false)
    assert {:ok, %{meeting: %{state: "starting"}}} = Meeting.show()

    Shuttle.Test.MeetingRunner.set_custom(true)
    assert {:ok, %{meeting: %{state: "live"}}} = Meeting.stop()

    assert Enum.count(Shuttle.Test.MeetingRunner.calls(), fn
             {"kill", ["-INT", "321"], _} -> true
             _ -> false
           end) == 1
  end

  test "stop dismisses starting and failed tmux sessions without signalling" do
    Shuttle.Test.MeetingRunner.set_handler(
      fn
        "tmux", ["display-message" | _], _opts, :starting ->
          {{"0|0|1234|", 0}, :starting}

        "tmux", ["display-message" | _], _opts, :absent ->
          {{"can't find session: hark-meeting", 1}, :absent}

        "tmux", ["kill-session" | _], _opts, _state ->
          {{"", 0}, :absent}

        _command, _args, _opts, state ->
          {{"", 0}, state}
      end,
      :starting
    )

    assert {:ok, %{meeting: nil}} = Meeting.stop()

    assert Enum.any?(Shuttle.Test.MeetingRunner.calls(), fn
             {"tmux", ["kill-session", "-t", "=hark-meeting"], _} -> true
             _ -> false
           end)

    refute Enum.any?(Shuttle.Test.MeetingRunner.calls(), fn {cmd, _, _} -> cmd == "kill" end)
  end

  test "stop dismisses a fresh failed pane and keeps its error instead of signalling" do
    hark_dir = Application.fetch_env!(:shuttle, :hark_dir)

    write_meeting(hark_dir, %{
      "launch" => "launch-failed",
      "pid" => 321,
      "phase" => "failed",
      "title" => "failed meeting",
      "error" => "capture setup failed"
    })

    Shuttle.Test.MeetingRunner.set_handler(
      fn
        "tmux", ["has-session" | _], _opts, :present ->
          {{"", 0}, :present}

        "tmux", ["display-message" | _], _opts, :present ->
          {{"1|2|1234|launch-failed\\n", 0}, :present}

        "tmux", ["capture-pane" | _], _opts, :present ->
          {{"pane error\\n", 0}, :present}

        "tmux", ["kill-session" | _], _opts, :present ->
          {{"", 0}, :absent}

        "tmux", ["has-session" | _], _opts, :absent ->
          {{"can't find session: hark-meeting", 1}, :absent}

        _command, _args, _opts, state ->
          {{"", 0}, state}
      end,
      :present
    )

    assert {:ok, %{meeting: nil}} = Meeting.stop()

    calls = Shuttle.Test.MeetingRunner.calls()

    assert Enum.any?(calls, fn
             {"tmux", ["capture-pane", "-p", "-t", "=hark-meeting:" | _], _} -> true
             _ -> false
           end)

    assert Enum.any?(calls, fn
             {"tmux", ["kill-session", "-t", "=hark-meeting"], _} -> true
             _ -> false
           end)

    refute Enum.any?(calls, fn {command, _, _} -> command == "kill" end)
  end

  test "a second meeting in the same minute gets its own transcript and HARK_DIR is explicit", %{
    hark_dir: hark_dir
  } do
    existing = Path.join(hark_dir, "meetings/2026-09-25_1403_shear-review.txt")
    File.mkdir_p!(Path.dirname(existing))
    File.write!(existing, "# hark\n# ended 14:04:00\n")
    set_starting_meeting_handler(hark_dir)

    assert {:ok, %{prompt: prompt}} =
             Meeting.start_capture(%{"mode" => "call"}, "Shear review", "local", "cli")

    {"tmux", ["new-session" | args], _} =
      Enum.find(Shuttle.Test.MeetingRunner.calls(), fn {cmd, args, _} ->
        cmd == "tmux" and match?(["new-session" | _], args)
      end)

    command = List.last(Enum.take_while(args, &(&1 != ";")))
    assert command =~ "2026-09-25_1403_shear-review-2.txt"
    refute command =~ "shear-review.txt'"
    assert prompt =~ "2026-09-25_1403_shear-review-2.txt"

    assert ["-e", "HARK_DIR=" <> ^hark_dir] =
             Enum.slice(args, Enum.find_index(args, &(&1 == "-e")), 2)

    assert File.read!(existing) == "# hark\n# ended 14:04:00\n"
  end

  test "a hark that exits at launch starts no scribe and says why", %{tmp_dir: tmp_dir} do
    Application.put_env(:shuttle, :remotes, [
      %{name: "project-host", ssh: "remote-alias", url: "http://127.0.0.1:4001"}
    ])

    start_supervised!({Shuttle.Test.MeetingCaptureForwardClient, {:ok, 200, "{}"}})
    Application.put_env(:shuttle, :write_forward_client, Shuttle.Test.MeetingCaptureForwardClient)

    Shuttle.Test.MeetingRunner.set_handler(fn
      "tmux", ["has-session" | _], _opts, nil ->
        {{"can't find session: hark-meeting", 1}, nil}

      "tmux", ["display-message" | _], _opts, nil ->
        {{"can't find session: hark-meeting", 1}, nil}

      "tmux", ["new-session" | args], _opts, _state ->
        {{"$4\n", 0}, launch_from_tmux_args(args)}

      "tmux", ["display-message" | _], _opts, launch ->
        {{"1|2|1234|#{launch}\n", 0}, launch}

      "tmux", ["capture-pane" | _], _opts, launch ->
        {{"hark: error: unrecognized arguments: --launch\n", 0}, launch}

      _command, _args, _opts, state ->
        {{"", 0}, state}
    end)

    conn =
      api_conn()
      |> post(
        "/api/v1/capture",
        Jason.encode!(%{
          "meeting" => %{"mode" => "call"},
          "prompt" => "Shear review",
          "project_dir" => Path.join(tmp_dir, "remote-project"),
          "origin" => "project-host"
        })
      )

    assert conn.status == 503

    assert %{"recording" => false, "error" => error, "meeting" => %{"state" => "failed"}} =
             Jason.decode!(conn.resp_body)

    assert error =~ "recording did not start"
    assert error =~ "unrecognized arguments: --launch"
    assert Shuttle.Test.MeetingCaptureForwardClient.last() == nil
  end

  test "an unreadable tmux after creation still reports recording as starting" do
    Application.put_env(:shuttle, :meeting_launch_wait_ms, 300)

    Shuttle.Test.MeetingRunner.set_handler(fn
      "tmux", ["has-session" | _], _opts, nil ->
        {{"can't find session: hark-meeting", 1}, nil}

      "tmux", ["display-message" | _], _opts, nil ->
        {{"can't find session: hark-meeting", 1}, nil}

      "tmux", ["new-session" | _], _opts, _state ->
        {{"$4\n", 0}, :created}

      "tmux", ["has-session" | _], _opts, :created ->
        {{"server exited unexpectedly", 1}, :created}

      _command, _args, _opts, state ->
        {{"", 0}, state}
    end)

    assert {:ok, %{meeting: %{state: "starting", tmux_session: "hark-meeting"}}} =
             Meeting.start_capture(%{"mode" => "call"}, "Shear review", "local", "cli")
  end

  test "an unmatched observation after creation is uncertain, not a failed launch", %{
    hark_dir: hark_dir
  } do
    Application.put_env(:shuttle, :meeting_launch_wait_ms, 300)

    write_meeting(hark_dir, %{"launch" => "old", "phase" => "ended", "pid" => 1, "title" => "old"})

    Shuttle.Test.MeetingRunner.set_handler(fn
      "tmux", ["new-session" | _], _opts, _state ->
        {{"$4\n", 0}, :created}

      "tmux", ["has-session" | _], _opts, _state ->
        {{"can't find session: hark-meeting", 1}, :created}

      _command, _args, _opts, state ->
        {{"", 0}, state}
    end)

    assert {:ok, %{meeting: %{state: "starting", title: "Shear review"}}} =
             Meeting.start_capture(%{"mode" => "call"}, "Shear review", "local", "cli")
  end

  test "a reap never kills a newer launch that replaced the inspected one", %{
    hark_dir: hark_dir
  } do
    write_meeting(hark_dir, %{"launch" => "L1", "phase" => "ended", "pid" => 1, "title" => "old"})

    Shuttle.Test.MeetingRunner.set_handler(
      fn
        "tmux", ["display-message" | _], _opts, 0 ->
          {{"1|0|1234|L1\n", 0}, 1}

        "tmux", ["display-message" | _], _opts, n ->
          {{"0|0|1235|L2\n", 0}, n + 1}

        _command, _args, _opts, state ->
          {{"", 0}, state}
      end,
      0
    )

    assert {:ok, _snapshot} = Meeting.show()

    refute Enum.any?(Shuttle.Test.MeetingRunner.calls(), fn {cmd, args, _} ->
             cmd == "tmux" and match?(["kill-session" | _], args)
           end)
  end

  defp set_current_meeting_handler(launch, pid) do
    pid_string = Integer.to_string(pid)

    Shuttle.Test.MeetingRunner.set_handler(fn
      "tmux", ["display-message" | _], _opts, state ->
        {{"0|0|1234|#{launch}\n", 0}, state}

      "ps", ["-p", ^pid_string, "-o", "command="], _opts, false ->
        {{"", 1}, false}

      "ps", ["-p", ^pid_string, "-o", "command="], _opts, state ->
        {{"python hark capture", 0}, state}

      "kill", ["-INT", ^pid_string], _opts, state ->
        {{"", 0}, state}

      _command, _args, _opts, state ->
        {{"", 0}, state}
    end)
  end

  defp set_starting_meeting_handler(hark_dir) do
    Shuttle.Test.MeetingRunner.set_handler(fn
      "tmux", ["display-message" | _], _opts, nil ->
        {{"can't find session: hark-meeting", 1}, nil}

      "tmux", ["new-session" | args], _opts, _state ->
        launch = launch_from_tmux_args(args)

        write_meeting(hark_dir, %{
          "launch" => launch,
          "pid" => 321,
          "phase" => "live",
          "title" => "Shear review",
          "started" => "2026-09-25T14:03:00+02:00",
          "transcript" => Path.join(hark_dir, "meetings/2026-09-25_1403_shear-review.txt"),
          "mirror" => "remote-alias:~/.hark/meetings/2026-09-25_1403_shear-review.txt"
        })

        {{"$4\n", 0}, launch}

      "tmux", ["display-message" | _], _opts, launch ->
        {{"0|0|1234|#{launch}\n", 0}, launch}

      "ps", ["-p", "321", "-o", "command="], _opts, launch ->
        {{"python hark capture", 0}, launch}

      _command, _args, _opts, state ->
        {{"", 0}, state}
    end)
  end

  defp wait_for_dead_pane(tmux_cmd, session, format, attempts) do
    {output, status} =
      tmux_cmd.(["display-message", "-p", "-t", "=" <> session <> ":", format])

    case Meeting.parse_tmux_result(output, status) do
      {:ok, %{state: {:dead, _}}} ->
        {output, status}

      _ when attempts > 1 ->
        Process.sleep(10)
        wait_for_dead_pane(tmux_cmd, session, format, attempts - 1)

      _ ->
        {output, status}
    end
  end

  defp launch_from_tmux_args(args) do
    args
    |> Enum.chunk_every(2, 1, :discard)
    |> Enum.find_value(fn
      ["@hark_launch", launch] -> launch
      _ -> nil
    end)
  end

  defp write_meeting(hark_dir, data),
    do: File.write!(Path.join(hark_dir, "meeting.json"), Jason.encode!(data))
end
