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

defmodule Shuttle.MeetingRexTest do
  use ExUnit.Case, async: false
  alias Shuttle.RetainedTerminal
  alias Shuttle.Rex, as: RexCLI
  alias Shuttle.Terminal.Rex
  @moduletag :tmp_dir
  @moduletag skip: is_nil(Shuttle.Rex.bin())

  test "a Hark block exit is shown as failed with its transcript intact", %{tmp_dir: root} do
    start_rex_server(root)
    hark_dir = Path.join(root, "hark")
    File.mkdir_p!(Path.join(hark_dir, "meetings"))
    transcript = Path.join(hark_dir, "meetings/capture.txt")
    File.write!(transcript, "The lensing result is stable.\n")
    launch = "rex-meeting-#{System.unique_integer([:positive])}"
    script = Path.join(root, "hark-bin")

    File.write!(
      script,
      "#!/bin/bash\nprintf '{\"launch\":\"%s\",\"phase\":\"live\",\"pid\":%s,\"title\":\"Test\",\"transcript\":\"%s\",\"started\":\"2026-11-04T12:00:00Z\"}' '#{launch}' \"$$\" '#{transcript}' > \"$HARK_DIR/meeting.json\"\nexit 9\n"
    )

    File.chmod!(script, 0o755)
    state_dir = Path.join(root, "retained")

    opts = [
      terminal: Rex,
      runner: Shuttle.Runner.Default,
      state_dir: state_dir,
      hark_dir: hark_dir
    ]

    assert :ok =
             RetainedTerminal.start(
               "hark-meeting",
               root,
               [script],
               %{"launch" => launch, "fiber" => "project/meeting"},
               Shuttle.Runner.Default,
               Keyword.put(opts, :env, %{"HARK_DIR" => hark_dir})
             )

    wait_for(fn -> File.exists?(Path.join(state_dir, "hark-meeting.json")) end)

    wait_for(fn ->
      match?(
        {:ok, %{dead: true}},
        RetainedTerminal.observe("hark-meeting", Shuttle.Runner.Default, opts)
      )
    end)

    assert {:ok, %{meeting: meeting}} = Shuttle.Meeting.show(opts)

    assert %{
             state: "failed",
             title: "Test",
             launch: ^launch,
             transcript: ^transcript,
             fiber: "project/meeting",
             joined: true
           } = meeting

    assert meeting.tail == ["The lensing result is stable."]
  end

  @tag :rex_meeting
  test "a Rex server loss turns the live capture into a failed row with its transcript", %{
    tmp_dir: root
  } do
    server_pid = start_rex_server(root)
    {hark_dir, transcript, script, launch} = live_hark_fixture(root)
    state_dir = Path.join(root, "retained")
    opts = meeting_opts(state_dir, hark_dir)

    assert :ok = start_retained(script, launch, root, hark_dir, opts)
    wait_for(fn -> File.exists?(Path.join(hark_dir, "meeting.json")) end)

    wait_for(fn ->
      match?({:ok, %{dead: false, pid: pid}} when is_integer(pid), observe(opts))
    end)

    assert {:ok, %{meeting: %{state: "live", launch: ^launch}}} = Shuttle.Meeting.show(opts)

    assert {_, 0} = System.cmd("kill", ["-9", to_string(server_pid)])

    wait_for(fn ->
      match?({:ok, %{meeting: %{state: "failed", launch: ^launch}}}, Shuttle.Meeting.show(opts))
    end)

    assert {:ok, %{meeting: meeting}} = Shuttle.Meeting.show(opts)
    assert meeting.transcript == transcript
    assert meeting.tail == ["The lensing result is stable."]
  end

  @tag :rex_meeting
  test "Meeting.start and Meeting.stop restart Hark through clean Rex blocks", %{tmp_dir: root} do
    start_rex_server(root)
    {hark_dir, _transcript, script, _launch} = live_hark_fixture(root)
    state_dir = Path.join(root, "retained")

    opts =
      meeting_opts(state_dir, hark_dir) ++
        [
          hark_path: script,
          home_dir: root,
          os_type: {:unix, :darwin},
          now: ~N[2026-11-04 12:00:00]
        ]

    assert {:ok, %{meeting: %{state: "live", launch: first_launch}}} =
             Shuttle.Meeting.start(%{"mode" => "call"}, :record, "test", nil, opts)

    assert {:ok, %{meeting: %{state: "live", launch: ^first_launch}}} = Shuttle.Meeting.show(opts)
    assert {:ok, _} = Shuttle.Meeting.stop(Keyword.put(opts, :launch, first_launch))

    wait_for(fn -> match?({:ok, %{meeting: nil}}, Shuttle.Meeting.show(opts)) end)

    assert {:ok, %{meeting: %{state: "live", launch: second_launch}}} =
             Shuttle.Meeting.start(%{"mode" => "call"}, :record, "test", nil, opts)

    refute second_launch == first_launch

    assert {:ok, %{meeting: %{state: "live", launch: ^second_launch}}} =
             Shuttle.Meeting.show(opts)

    assert {:ok, _} = Shuttle.Meeting.stop(Keyword.put(opts, :launch, second_launch))
    wait_for(fn -> match?({:ok, %{meeting: nil}}, Shuttle.Meeting.show(opts)) end)
  end

  defp start_rex_server(data_dir) do
    rex_root = Path.join(System.tmp_dir!(), "meeting-rex-#{System.unique_integer([:positive])}")
    File.mkdir_p!(rex_root)
    endpoint = "unix://#{rex_root}/rex.sock"
    Shuttle.Test.Env.put_app_env(:rex_server, endpoint)
    Shuttle.Test.Env.put_env("SHUTTLE_REX_SERVER", endpoint)
    Shuttle.Test.Env.put_env("SHUTTLE_DATA_DIR", data_dir)

    port =
      Port.open({:spawn_executable, RexCLI.bin()}, [
        :binary,
        :exit_status,
        :stderr_to_stdout,
        args: ["server", "run", "--listen", endpoint, "--state-dir", Path.join(rex_root, "state")]
      ])

    {:os_pid, pid} = Port.info(port, :os_pid)

    on_exit(fn ->
      System.cmd("kill", ["-TERM", to_string(pid)], stderr_to_stdout: true)
      File.rm_rf!(rex_root)
    end)

    wait_for(fn -> match?({:ok, _}, RexCLI.whoami(Shuttle.Runner.Default)) end)
    pid
  end

  defp live_hark_fixture(root) do
    hark_dir = Path.join(root, "hark")
    File.mkdir_p!(Path.join(hark_dir, "meetings"))
    transcript = Path.join(hark_dir, "meetings/capture.txt")
    File.write!(transcript, "The lensing result is stable.\n")
    script = Path.join(root, "hark-bin")
    launch = "rex-meeting-#{System.unique_integer([:positive])}"

    File.write!(script, """
    #!/usr/bin/env python3
    import json
    import os
    import signal
    import sys
    import time
    from pathlib import Path

    args = sys.argv[1:]
    transcript = args[args.index("-o") + 1]
    launch = next(arg.split("=", 1)[1] for arg in args if arg.startswith("--launch="))
    title = next(arg.split("=", 1)[1] for arg in args if arg.startswith("--title="))
    meeting_file = Path(os.environ["HARK_DIR"]) / "meeting.json"

    def write(phase):
        meeting_file.write_text(json.dumps({
            "launch": launch,
            "phase": phase,
            "pid": os.getpid(),
            "title": title,
            "transcript": transcript,
            "started": "2026-11-04T12:00:00Z",
        }))

    def stop(_signal, _frame):
        write("ended")
        raise SystemExit(0)

    signal.signal(signal.SIGINT, stop)
    write("live")
    while True:
        time.sleep(0.1)
    """)

    File.chmod!(script, 0o755)
    {hark_dir, transcript, script, launch}
  end

  defp meeting_opts(state_dir, hark_dir),
    do: [terminal: Rex, runner: Shuttle.Runner.Default, state_dir: state_dir, hark_dir: hark_dir]

  defp start_retained(script, launch, cwd, hark_dir, opts) do
    RetainedTerminal.start(
      "hark-meeting",
      cwd,
      [
        script,
        "-o",
        Path.join(hark_dir, "meetings/capture.txt"),
        "--launch=" <> launch,
        "--title=Test"
      ],
      %{"launch" => launch, "fiber" => nil},
      Shuttle.Runner.Default,
      Keyword.put(opts, :env, %{"HARK_DIR" => hark_dir})
    )
  end

  defp observe(opts),
    do: RetainedTerminal.observe("hark-meeting", Shuttle.Runner.Default, opts)

  defp wait_for(fun, attempts \\ 100)
  defp wait_for(fun, 0), do: assert(fun.(), "Rex meeting observation did not arrive")

  defp wait_for(fun, attempts) do
    if fun.() do
      :ok
    else
      Process.sleep(50)
      wait_for(fun, attempts - 1)
    end
  end
end

defmodule Shuttle.Test.MeetingCaptureForwardClient do
  use Agent

  def start_link(response),
    do: Agent.start_link(fn -> %{response: response, last: nil} end, name: __MODULE__)

  def last, do: Agent.get(__MODULE__, & &1.last)
  def get(_url, _timeout), do: {:error, :unavailable}

  def post(url, body, _content_type, _timeout_ms) do
    Agent.update(__MODULE__, &Map.put(&1, :last, %{url: url, body: body}))
    Agent.get(__MODULE__, & &1.response)
  end
end

defmodule Shuttle.MeetingTest do
  # group: Shuttle.Meeting.Control is one app-started claim every meeting route reconciles.
  use ExUnit.Case, async: true, group: :meeting

  import Phoenix.ConnTest
  import Shuttle.Test.ApiConn

  alias Shuttle.Meeting
  alias Shuttle.Test.Env

  @endpoint ShuttleWeb.Endpoint
  @moduletag :tmp_dir
  @tmux_format "\#{pane_dead}|\#{pane_dead_status}|\#{session_created}|\#{@hark_launch}|\#{@hark_fiber}"

  setup %{tmp_dir: tmp_dir} do
    hark_dir = Path.join(tmp_dir, "hark")
    hark_path = Path.join(tmp_dir, "hark-bin")
    File.mkdir_p!(hark_dir)
    File.write!(hark_path, "#!/bin/sh\nexit 0\n")
    File.chmod!(hark_path, 0o755)

    start_supervised!(Shuttle.Test.MeetingRunner)
    Env.put_app_env(:meeting_runner, Shuttle.Test.MeetingRunner)
    Env.put_app_env(:hark_dir, hark_dir)
    Env.put_app_env(:hark_path, hark_path)
    Env.put_app_env(:remotes, [])
    Env.put_app_env(:own_host_id, "local-host")
    Env.put_app_env(:meeting_now, ~N[2026-09-25 14:03:12])
    Env.put_app_env(:host_capabilities_os_type, {:unix, :darwin})
    Meeting.Control.reconcile(nil)

    on_exit(fn -> Meeting.Control.reconcile(nil) end)

    %{tmp_dir: tmp_dir, hark_dir: hark_dir, hark_path: hark_path}
  end

  # Mutation control: omit modes from inspect_current/1 or ignore executable permission.
  test "GET reports platform-supported modes only when hark is executable", %{hark_path: path} do
    for {os, modes} <- [{:darwin, ~w(call phone)}, {:linux, ~w(phone)}] do
      Env.put_app_env(:host_capabilities_os_type, {:unix, os})

      body =
        api_conn()
        |> get("/api/v1/meeting?origin=#{Shuttle.Poller.own_host_id()}")
        |> Map.get(:resp_body)
        |> Jason.decode!()

      assert body == %{
               "available" => true,
               "meeting" => nil,
               "modes" => modes,
               "recorder" => Shuttle.Poller.own_host_id()
             }
    end

    for unavailable <- [false, path <> "-missing", path] do
      File.chmod!(path, 0o644)
      Env.put_app_env(:hark_path, unavailable)
      body = api_conn() |> get("/api/v1/meeting") |> Map.get(:resp_body) |> Jason.decode!()

      assert body == %{
               "available" => false,
               "meeting" => nil,
               "modes" => [],
               "recorder" => Shuttle.Poller.own_host_id()
             }
    end
  end

  test "room and unknown modes are rejected before any recording", %{hark_dir: dir} do
    for os <- [:darwin, :linux],
        mode <- ["room", "unknown"],
        route <- ["/api/v1/capture", "/api/v1/meeting/join", "/api/v1/meeting/start"] do
      Env.put_app_env(:host_capabilities_os_type, {:unix, os})

      conn =
        api_conn()
        |> post(
          route,
          Jason.encode!(%{"meeting" => %{"mode" => mode}, "fiber_id" => "proj/fiber"})
        )

      assert conn.status == 422
      assert Jason.decode!(conn.resp_body)["error"] == "meeting.mode must be 'call' or 'phone'"
    end

    assert Shuttle.Test.MeetingRunner.calls() == []
    refute File.exists?(Path.join(dir, "meetings"))
  end

  test "invalid languages are rejected before any recording", %{hark_dir: dir} do
    for language <- ["de", "any", "fr-FR", "", nil, 42, ["fr"], %{}],
        route <- ["/api/v1/capture", "/api/v1/meeting/join", "/api/v1/meeting/start"] do
      conn =
        api_conn()
        |> post(
          route,
          Jason.encode!(%{
            "meeting" => %{"mode" => "call", "language" => language},
            "fiber_id" => "proj/fiber"
          })
        )

      assert conn.status == 422

      assert Jason.decode!(conn.resp_body)["error"] ==
               "meeting.language must be 'auto', 'fr' or 'en'"
    end

    assert Shuttle.Test.MeetingRunner.calls() == []
    refute File.exists?(Path.join(dir, "meetings"))
  end

  for mode <- ["call", "phone"], language <- [nil, "auto", "fr", "en"] do
    test "#{mode} capture passes language #{inspect(language)} to hark", %{hark_dir: dir} do
      set_starting_meeting_handler(dir)
      meeting = %{"mode" => unquote(mode)}
      language = unquote(language)
      meeting = if language, do: Map.put(meeting, "language", language), else: meeting

      assert {:ok, _} = Meeting.start(meeting, :capture, "Shear review", nil)

      {"tmux", ["new-session" | args], _} =
        Enum.find(Shuttle.Test.MeetingRunner.calls(), fn {cmd, args, _} ->
          cmd == "tmux" and match?(["new-session" | _], args)
        end)

      command = List.last(Enum.take_while(args, &(&1 != ";")))

      if language in [nil, "auto"] do
        refute command =~ "--lang"
      else
        assert command =~ "'--lang' '#{language}'"
      end
    end
  end

  # Mutation control: remove validate_supported_mode/2 from do_start/5.
  test "Linux rejects device capture before inspecting or launching hark", %{hark_dir: dir} do
    Env.put_app_env(:host_capabilities_os_type, {:unix, :linux})

    for mode <- ~w(call),
        route <- ["/api/v1/capture", "/api/v1/meeting/join", "/api/v1/meeting/start"] do
      conn =
        api_conn()
        |> post(
          route,
          Jason.encode!(%{"meeting" => %{"mode" => mode}, "fiber_id" => "proj/fiber"})
        )

      assert conn.status == 422

      assert Jason.decode!(conn.resp_body)["error"] ==
               "meeting.mode '#{mode}' is not supported on this host"
    end

    assert Shuttle.Test.MeetingRunner.calls() == []
    refute File.exists?(Path.join(dir, "meetings"))
  end

  # Mutation control: replace route_host/1 with a local read or route/1.
  test "meeting GET forwards the owner's modes and meeting verbatim without a local read" do
    body =
      Jason.encode!(%{
        "available" => true,
        "modes" => ["phone"],
        "meeting" => %{"launch" => "remote-launch"}
      })

    Shuttle.Test.ForwardStub.stub_forward(
      "audio-host",
      "http://audio.example:4000",
      {:ok, 200, "application/json", body}
    )

    Env.put_app_env(:hark_path, false)

    conn = get(api_conn(), "/api/v1/meeting?origin=audio-host&extra=kept")
    assert conn.status == 200

    assert Jason.decode!(conn.resp_body) ==
             Shuttle.MeetingRouter.stamp(Jason.decode!(body), "audio-host")

    assert Plug.Conn.get_resp_header(conn, "content-type") == ["application/json; charset=utf-8"]
    url = Shuttle.Test.StubGetFileClient.last().url |> URI.parse()
    assert url.path == "/api/v1/meeting"
    assert url.host == "audio.example"
    assert url.query == nil
    assert Shuttle.Test.MeetingRunner.calls() == []
  end

  test "meeting GET refuses unknown hosts and surfaces forward failures" do
    conn = get(api_conn(), "/api/v1/meeting?origin=unknown-host")
    assert conn.status == 400
    assert Jason.decode!(conn.resp_body)["error"] =~ "unknown origin"
    assert Shuttle.Test.MeetingRunner.calls() == []

    Shuttle.Test.ForwardStub.stub_forward(
      "audio-host",
      "http://audio.example:4000",
      {:error, :econnrefused}
    )

    conn = get(api_conn(), "/api/v1/meeting?origin=audio-host")
    assert conn.status == 502
    assert Jason.decode!(conn.resp_body)["error"] =~ "cannot inspect recorder"
    assert Shuttle.Test.MeetingRunner.calls() == []
  end

  test "meeting GET preserves remote errors rather than substituting local availability" do
    body = Jason.encode!(%{"error" => "tmux unavailable on owner"})

    Shuttle.Test.ForwardStub.stub_forward(
      "audio-host",
      "http://audio.example:4000",
      {:ok, 503, "application/json", body}
    )

    conn = get(api_conn(), "/api/v1/meeting?origin=audio-host")
    assert conn.status == 503

    assert Jason.decode!(conn.resp_body) == %{
             "error" => "tmux unavailable on owner",
             "recorder" => "audio-host"
           }

    assert Shuttle.Test.MeetingRunner.calls() == []
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

  test "pasted-image lines never name a meeting" do
    now = ~N[2026-09-25 14:03:12]

    assert {"2026-09-25_1403", "Meeting"} =
             Meeting.name_and_title(
               "[Image: /h/.shuttle/attachments/u/a.png]\n[Image: /h/b.jpg]",
               now
             )

    assert {"2026-09-25_1403_shear-residuals", "shear residuals"} =
             Meeting.name_and_title("[Image: /h/a.png]\nshear residuals", now)
  end

  test "meeting message carries the facts and points at the skill's meeting reference" do
    call = Meeting.meeting_message("call", "/tmp/meetings/session.txt")

    assert call =~ "Meeting mode (call)."
    assert call =~ "`/tmp/meetings/session.txt` on this host"
    assert call =~ "references/meeting.md"
    assert call =~ "The user's note about the meeting follows (it may be empty)."
  end

  test "a phone meeting's message says it is in person, through a phone's mic" do
    phone = Meeting.meeting_message("phone", "/tmp/meetings/session.txt")

    assert phone =~ "Meeting mode (phone)."
    assert phone =~ "in-person meeting, recorded through a phone's microphone"
    assert phone =~ "`/tmp/meetings/session.txt` on this host"
    refute Meeting.meeting_message("call", "x") =~ "phone"
  end

  test "phone mode launches hark with --phone and its row says it takes phone audio", %{
    hark_dir: hark_dir
  } do
    Env.put_app_env(:host_capabilities_os_type, {:unix, :linux})

    Shuttle.Test.MeetingRunner.set_handler(fn
      "tmux", ["display-message" | _], _opts, nil ->
        {{"can't find session: hark-meeting", 1}, nil}

      "tmux", ["new-session" | args], _opts, _state ->
        launch = launch_from_tmux_args(args)

        write_meeting(hark_dir, %{
          "launch" => launch,
          "pid" => 321,
          "phase" => "loading",
          "title" => "Lunch",
          "started" => "2026-09-25T14:03:00+02:00",
          "transcript" => Path.join(hark_dir, "meetings/lunch.txt"),
          "phone" => Path.join(hark_dir, "phone.sock")
        })

        {{"$4\n", 0}, launch}

      "tmux", ["display-message" | _], _opts, launch ->
        {{"0|0|1234|#{launch}|\n", 0}, launch}

      "ps", ["-p", "321", "-o", "command="], _opts, launch ->
        {{"python hark --phone", 0}, launch}

      _command, _args, _opts, state ->
        {{"", 0}, state}
    end)

    assert {:ok, %{meeting: row, prompt: prompt}} =
             Meeting.start(%{"mode" => "phone"}, :capture, "Lunch", nil)

    assert %{state: "loading", phone: true} = row
    assert prompt =~ "Meeting mode (phone)."

    {"tmux", ["new-session" | args], _} =
      Enum.find(Shuttle.Test.MeetingRunner.calls(), fn {cmd, args, _} ->
        cmd == "tmux" and match?(["new-session" | _], args)
      end)

    command = List.last(Enum.take_while(args, &(&1 != ";")))
    assert command =~ "'--phone'"
    refute command =~ "--room"

    socket_path = Path.join(hark_dir, "phone.sock")
    assert {:ok, %{path: ^socket_path, launch: launch}} = Meeting.phone_socket()
    assert is_binary(launch)

    assert row.launch == launch

    conn = api_conn() |> get("/api/v1/meeting")
    assert %{"meeting" => %{"phone" => true, "launch" => ^launch}} = Jason.decode!(conn.resp_body)
  end

  test "phone_socket answers for each meeting state", %{hark_dir: hark_dir} do
    # Nothing recording.
    assert {:error, :none} = Meeting.phone_socket()

    base = %{
      "launch" => "launch-current",
      "pid" => 321,
      "title" => "t",
      "started" => "2026-09-25T14:03:12+02:00",
      "transcript" => Path.join(hark_dir, "t.txt")
    }

    set_current_meeting_handler("launch-current", 321)

    # A call meeting is live: there is no phone to feed.
    write_meeting(hark_dir, Map.merge(base, %{"phase" => "live", "phone" => nil}))
    assert {:error, :not_phone} = Meeting.phone_socket()
    assert {:ok, %{meeting: %{phone: false, launch: "launch-current"}}} = Meeting.show()

    write_meeting(hark_dir, Map.merge(base, %{"phase" => "live", "phone" => "/x/phone.sock"}))
    assert {:ok, %{path: "/x/phone.sock", launch: "launch-current"}} = Meeting.phone_socket()

    write_meeting(hark_dir, Map.merge(base, %{"phase" => "stopping", "phone" => "/x/phone.sock"}))
    assert {:error, :ended} = Meeting.phone_socket()

    # The tmux session is up but hark has not written this launch's file yet.
    write_meeting(hark_dir, Map.merge(base, %{"launch" => "older", "phase" => "live"}))
    assert :pending = Meeting.phone_socket()
  end

  test "a joined meeting's message names the constitution it joins" do
    joined = Meeting.meeting_message("call", "~/.hark/meetings/x.txt", {:fiber, "proj/shear"})

    assert joined =~ "Meeting mode (call)."
    assert joined =~ "`~/.hark/meetings/x.txt` on this host"
    assert joined =~ "This meeting joins this constitution (`proj/shear`)"
    assert joined =~ "references/meeting.md"
    refute joined =~ "appropriate filing location"
    refute joined =~ "Do not ask the user for a title"
    refute joined =~ "provisional date-based name"
    refute joined =~ "rename it when the transcript clarifies the subject"
    refute Meeting.meeting_message("call", "x", :capture) =~ "joins this constitution"
  end

  test "joining a constitution records locally, names the fiber, and delivers to its owner", %{
    hark_dir: hark_dir
  } do
    Env.put_app_env(:remotes, [
      %{name: "project-host", ssh: "remote-alias", url: "http://127.0.0.1:4001"}
    ])

    start_supervised!(
      {Shuttle.Test.MeetingCaptureForwardClient,
       {:ok, 200, Jason.encode!(%{"delivered" => true, "delivery" => "message"})}}
    )

    Env.put_app_env(:write_forward_client, Shuttle.Test.MeetingCaptureForwardClient)
    set_joined_meeting_handler(hark_dir)

    {conn, log} =
      ExUnit.CaptureLog.with_log(fn ->
        api_conn()
        |> post(
          "/api/v1/meeting/join",
          Jason.encode!(%{
            "fiber_id" => "cosmo/shear-bmodes",
            "origin" => "project-host",
            "meeting" => %{"mode" => "call"},
            "note" => "",
            "resume_mode" => "fresh"
          })
        )
      end)

    launch = Jason.decode!(conn.resp_body)["meeting"]["launch"]
    assert log =~ "[info] meeting start launch=#{launch} mode=call fiber=\"cosmo/shear-bmodes\""
    assert log =~ "transcript=\"~/.hark/meetings/2026-09-25_1403_shear-bmodes.txt\""
    assert log =~ "[info] meeting delivery launch=#{launch} status=200"
    assert log =~ ~s("delivered":true)
    assert length(Regex.scan(~r/meeting start /, log)) == 1
    assert length(Regex.scan(~r/meeting delivery /, log)) == 1

    assert conn.status == 200

    assert %{
             "delivery" => %{"delivered" => true, "delivery" => "message"},
             "meeting" => %{
               "state" => "live",
               "fiber" => "cosmo/shear-bmodes",
               "mirror_host" => "project-host"
             }
           } = Jason.decode!(conn.resp_body)

    forwarded = Shuttle.Test.MeetingCaptureForwardClient.last()
    assert forwarded.url == "http://127.0.0.1:4001/api/v1/deliver"
    request = Jason.decode!(forwarded.body)
    assert request["fiber_id"] == "cosmo/shear-bmodes"
    assert request["from"] == "shuttle"
    assert request["from_claim"] in [nil, ""]
    assert request["resume_mode"] == "fresh"
    assert request["text"] =~ "Meeting mode (call)."
    assert request["text"] =~ "~/.hark/meetings/2026-09-25_1403_shear-bmodes.txt"
    assert request["text"] =~ "joins this constitution (`cosmo/shear-bmodes`)"

    {"tmux", ["new-session" | args], _} =
      Enum.find(Shuttle.Test.MeetingRunner.calls(), fn {cmd, args, _} ->
        cmd == "tmux" and match?(["new-session" | _], args)
      end)

    assert fiber_from_tmux_args(args) == "cosmo/shear-bmodes"
    command = List.last(Enum.take_while(args, &(&1 != ";")))
    assert command =~ "--mirror"
    assert command =~ "'--title=shear-bmodes'"

    assert %{"meeting" => %{"fiber" => "cosmo/shear-bmodes", "joined" => true}} =
             api_conn() |> get("/api/v1/meeting") |> Map.get(:resp_body) |> Jason.decode!()
  end

  test "a joined meeting whose note is only images is named after the fiber", %{
    hark_dir: hark_dir
  } do
    Env.put_app_env(:remotes, [
      %{name: "project-host", ssh: "remote-alias", url: "http://127.0.0.1:4001"}
    ])

    start_supervised!(
      {Shuttle.Test.MeetingCaptureForwardClient,
       {:ok, 200, Jason.encode!(%{"delivered" => true, "delivery" => "message"})}}
    )

    Env.put_app_env(:write_forward_client, Shuttle.Test.MeetingCaptureForwardClient)
    set_joined_meeting_handler(hark_dir)
    image = "[Image: /remote/.shuttle/attachments/u/0123456789abcdef.png]"

    conn =
      api_conn()
      |> post(
        "/api/v1/meeting/join",
        Jason.encode!(%{
          "fiber_id" => "cosmo/shear-bmodes",
          "origin" => "project-host",
          "meeting" => %{"mode" => "call"},
          "note" => image
        })
      )

    assert conn.status == 200
    request = Jason.decode!(Shuttle.Test.MeetingCaptureForwardClient.last().body)
    assert request["text"] =~ "~/.hark/meetings/2026-09-25_1403_shear-bmodes.txt"
    assert request["text"] =~ image

    {"tmux", ["new-session" | args], _} =
      Enum.find(Shuttle.Test.MeetingRunner.calls(), fn {cmd, args, _} ->
        cmd == "tmux" and match?(["new-session" | _], args)
      end)

    assert List.last(Enum.take_while(args, &(&1 != ";"))) =~ "'--title=shear-bmodes'"
  end

  test "a delivery failure after hark starts keeps the recording row", %{hark_dir: hark_dir} do
    Env.put_app_env(:remotes, [
      %{name: "project-host", ssh: "remote-alias", url: "http://127.0.0.1:4001"}
    ])

    start_supervised!(
      {Shuttle.Test.MeetingCaptureForwardClient,
       {:ok, 409,
        Jason.encode!(%{
          "delivered" => false,
          "error" =>
            "the live worker has no addressable conversation yet; try again once it has started"
        })}}
    )

    Env.put_app_env(:write_forward_client, Shuttle.Test.MeetingCaptureForwardClient)
    set_joined_meeting_handler(hark_dir)

    {conn, log} =
      ExUnit.CaptureLog.with_log(fn ->
        api_conn()
        |> post(
          "/api/v1/meeting/join",
          Jason.encode!(%{
            "fiber_id" => "cosmo/shear-bmodes",
            "origin" => "project-host",
            "meeting" => %{"mode" => "call"},
            "note" => "B-mode telecon"
          })
        )
      end)

    assert conn.status == 409
    launch = Jason.decode!(conn.resp_body)["meeting"]["launch"]
    assert log =~ "[info] meeting delivery launch=#{launch} status=409"
    assert log =~ ~s("delivered":false)
    assert log =~ "the live worker has no addressable conversation yet"
    assert length(Regex.scan(~r/meeting delivery /, log)) == 1

    assert %{
             "recording" => true,
             "error" => "the live worker has no addressable conversation yet" <> _,
             "meeting" => %{"state" => "live", "fiber" => "cosmo/shear-bmodes"}
           } = Jason.decode!(conn.resp_body)
  end

  test "an unconfirmed delivery joins the meeting without claiming a failure", %{
    hark_dir: hark_dir
  } do
    Env.put_app_env(:remotes, [
      %{name: "project-host", ssh: "remote-alias", url: "http://127.0.0.1:4001"}
    ])

    detail =
      "native message queued behind the receiver's current turn; no model response to it observed yet"

    start_supervised!(
      {Shuttle.Test.MeetingCaptureForwardClient,
       {:ok, 202,
        Jason.encode!(%{
          "delivered" => nil,
          "delivery" => "message",
          "fiber_id" => "cosmo/shear-bmodes",
          "receipt" => %{"status" => "unknown", "detail" => detail},
          "detail" => detail
        })}}
    )

    Env.put_app_env(:write_forward_client, Shuttle.Test.MeetingCaptureForwardClient)
    set_joined_meeting_handler(hark_dir)

    conn =
      api_conn()
      |> post(
        "/api/v1/meeting/join",
        Jason.encode!(%{
          "fiber_id" => "cosmo/shear-bmodes",
          "origin" => "project-host",
          "meeting" => %{"mode" => "call"}
        })
      )

    assert conn.status == 202
    body = Jason.decode!(conn.resp_body)
    assert %{"delivery" => %{"delivered" => nil, "detail" => ^detail}} = body
    refute Map.has_key?(body, "error")
    refute Map.has_key?(body, "recording")
  end

  test "joining validates the fiber before recording" do
    conn =
      api_conn()
      |> post(
        "/api/v1/meeting/join",
        Jason.encode!(%{"meeting" => %{"mode" => "call"}, "fiber_id" => " "})
      )

    assert conn.status == 422
    assert Jason.decode!(conn.resp_body)["error"] =~ "fiber_id"
    assert Shuttle.Test.MeetingRunner.calls() == []
  end

  # Mutation control: route start_local/2 through DeliverController.route/4, or
  # answer `transcript` from the row instead of the origin's path.
  test "a record-only start records here, starts no agent, and answers the local transcript", %{
    hark_dir: hark_dir
  } do
    start_supervised!(
      {Shuttle.Test.MeetingCaptureForwardClient, {:ok, 200, Jason.encode!(%{"spawned" => true})}}
    )

    Env.put_app_env(:write_forward_client, Shuttle.Test.MeetingCaptureForwardClient)
    set_starting_meeting_handler(hark_dir)

    own = Shuttle.Poller.own_host_id()

    conn =
      api_conn()
      |> post(
        "/api/v1/meeting/start",
        Jason.encode!(%{"meeting" => %{"mode" => "call"}, "note" => "Weekly standup\nagenda"})
      )

    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)

    assert %{
             "recorder" => ^own,
             "origin" => ^own,
             "transcript" => transcript,
             "meeting" => %{"state" => "live", "recorder" => ^own, "fiber" => nil}
           } = body

    assert transcript == Path.join(hark_dir, "meetings/2026-09-25_1403_weekly-standup.txt")
    refute Map.has_key?(body, "delivery")
    assert Shuttle.Test.MeetingCaptureForwardClient.last() == nil

    sessions =
      Enum.filter(Shuttle.Test.MeetingRunner.calls(), fn {cmd, args, _} ->
        cmd == "tmux" and match?(["new-session" | _], args)
      end)

    assert [{"tmux", ["new-session" | args], _}] = sessions
    assert fiber_from_tmux_args(args) == nil
    command = List.last(Enum.take_while(args, &(&1 != ";")))
    assert command =~ "'--title=Weekly standup'"
    assert command =~ "'-o' '#{transcript}'"
    refute command =~ "--mirror"
  end

  test "a record-only start for a remote origin answers the mirror path on that origin", %{
    hark_dir: hark_dir
  } do
    Env.put_app_env(:remotes, [
      %{name: "project-host", ssh: "remote-alias", url: "http://127.0.0.1:4001"}
    ])

    set_starting_meeting_handler(hark_dir)

    conn =
      api_conn()
      |> post(
        "/api/v1/meeting/start",
        Jason.encode!(%{
          "recorder" => Shuttle.Poller.own_host_id(),
          "recorder_forwarded" => true,
          "origin" => "project-host",
          "meeting" => %{"mode" => "call"}
        })
      )

    assert conn.status == 200

    assert %{
             "origin" => "project-host",
             "transcript" => "~/.hark/meetings/2026-09-25_1403.txt",
             "meeting" => %{"mirror_host" => "project-host"}
           } = Jason.decode!(conn.resp_body)

    {"tmux", ["new-session" | args], _} =
      Enum.find(Shuttle.Test.MeetingRunner.calls(), fn {cmd, args, _} ->
        cmd == "tmux" and match?(["new-session" | _], args)
      end)

    command = List.last(Enum.take_while(args, &(&1 != ";")))
    assert command =~ "'--title=Meeting'"
    assert command =~ "'--mirror' 'remote-alias:~/.hark/meetings/2026-09-25_1403.txt'"
  end

  test "a record-only start refuses without hark and conflicts with a live meeting", %{
    hark_dir: hark_dir,
    hark_path: hark_path
  } do
    Env.put_app_env(:hark_path, false)
    start = fn -> post(api_conn(), "/api/v1/meeting/start", ~s({"meeting":{"mode":"call"}})) end

    conn = start.()
    assert conn.status == 503
    assert Jason.decode!(conn.resp_body)["error"] =~ "hark is not available"
    assert Shuttle.Test.MeetingRunner.calls() == []

    Env.put_app_env(:hark_path, hark_path)

    write_meeting(hark_dir, %{
      "launch" => "launch-current",
      "pid" => 321,
      "phase" => "live",
      "title" => "current meeting",
      "transcript" => "/tmp/current.txt"
    })

    set_current_meeting_handler("launch-current", 321)

    conn = start.()
    assert conn.status == 409

    assert %{
             "meeting" => %{"title" => "current meeting"},
             "error" => "a meeting is already active"
           } =
             Jason.decode!(conn.resp_body)

    refute Enum.any?(Shuttle.Test.MeetingRunner.calls(), fn {cmd, args, _} ->
             cmd == "tmux" and match?(["new-session" | _], args)
           end)
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
    Env.put_app_env(:remotes, remotes)
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
             tail: [],
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

    Env.put_app_env(:remotes, [
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
             Meeting.parse_tmux_result("0|0|1234|launch-a|\n", 0)

    assert {:ok, %{state: {:dead, 17}, session_created: 1234, launch: nil, fiber: nil}} =
             Meeting.parse_tmux_result("1|17|1234||\n", 0)

    assert {:ok, %{state: :alive, launch: "launch-a", fiber: "cosmo/shear"}} =
             Meeting.parse_tmux_result("0|0|1234|launch-a|cosmo/shear\n", 0)

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

    Env.put_app_env(:remotes, [
      %{name: "project-host", ssh: "remote-alias", url: "http://127.0.0.1:4001"}
    ])

    set_current_meeting_handler("launch-current", 321)

    spoken = for n <- 1..40, do: "14:#{10 + div(n, 60)}:#{rem(n, 60)} S1  line #{n}"

    File.write!(
      Path.join(hark_dir, "current.txt"),
      Enum.join(["# hark transcript" | spoken] ++ ["# S1 = Martin", ""], "\n")
    )

    conn = api_conn() |> get("/api/v1/meeting")
    assert conn.status == 200
    tail = Jason.decode!(conn.resp_body)["meeting"]["tail"]
    assert length(tail) == 30
    assert hd(tail) =~ "line 11"
    assert List.last(tail) =~ "line 40"

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

  test "meeting capture accepts a whitespace-only yap and sends transcript-first scribe instructions",
       %{
         hark_dir: hark_dir,
         tmp_dir: tmp_dir
       } do
    Env.put_app_env(:remotes, [
      %{name: "project-host", ssh: "remote-alias", url: "http://127.0.0.1:4001"}
    ])

    start_supervised!(
      {Shuttle.Test.MeetingCaptureForwardClient,
       {:ok, 200, Jason.encode!(%{"spawned" => true, "tmux_session" => "capture-session"})}}
    )

    Env.put_app_env(:write_forward_client, Shuttle.Test.MeetingCaptureForwardClient)
    set_starting_meeting_handler(hark_dir)

    conn =
      api_conn()
      |> post(
        "/api/v1/capture",
        Jason.encode!(%{
          "meeting" => %{"mode" => "phone"},
          "prompt" => " \n\t ",
          "project_dir" => Path.join(tmp_dir, "remote-project"),
          "origin" => "project-host"
        })
      )

    assert conn.status == 200
    assert %{"meeting" => %{"state" => "live"}} = Jason.decode!(conn.resp_body)

    forwarded = Shuttle.Test.MeetingCaptureForwardClient.last()
    assert forwarded.url == "http://127.0.0.1:4001/api/v1/capture"
    request = Jason.decode!(forwarded.body)
    assert request["prompt"] =~ "Meeting mode (phone)."
    assert request["prompt"] =~ "infer the meeting's identity, topic, participants"
    assert request["prompt"] =~ "appropriate filing location"
    assert request["prompt"] =~ "Do not ask the user for a title"
    assert request["prompt"] =~ "provisional date-based name"
    assert request["prompt"] =~ "The user's note about the meeting follows (it may be empty)."
    assert request["prompt"] =~ "~/.hark/meetings/2026-09-25_1403.txt"
  end

  test "meeting mode starts locally, forwards a normal capture, and resolves the mirror name", %{
    hark_dir: hark_dir,
    tmp_dir: tmp_dir
  } do
    Env.put_app_env(:remotes, [
      %{name: "project-host", ssh: "remote-alias", url: "http://127.0.0.1:4001"}
    ])

    start_supervised!(
      {Shuttle.Test.MeetingCaptureForwardClient,
       {:ok, 200,
        Jason.encode!(%{
          "spawned" => true,
          "tmux_session" => "capture-session",
          "session_uuid" => "scribe-uuid"
        })}}
    )

    Env.put_app_env(:write_forward_client, Shuttle.Test.MeetingCaptureForwardClient)
    set_starting_meeting_handler(hark_dir)

    conn =
      api_conn()
      |> post(
        "/api/v1/capture",
        Jason.encode!(%{
          "meeting" => %{"mode" => "call"},
          "prompt" => "Shear review\nDiscuss the residuals",
          "project_dir" => Path.join(tmp_dir, "remote-project"),
          "origin" => "project-host",
          "surface" => "app"
        })
      )

    assert conn.status == 200

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
    refute Map.has_key?(request, "surface")
    assert request["prompt"] =~ "Meeting mode (call)."
    assert request["prompt"] =~ "Discuss the residuals"

    new_session =
      Enum.find(Shuttle.Test.MeetingRunner.calls(), fn {cmd, args, _} ->
        cmd == "tmux" and match?(["new-session" | _], args)
      end)

    assert {"tmux", ["new-session" | args], _} = new_session
    command = List.last(Enum.take_while(args, &(&1 != ";")))
    assert command =~ "--mirror"
    assert command =~ "remote-alias:~/.hark/meetings/2026-09-25_1403_shear-review.txt"
    assert command =~ ~r/'--launch=[A-Za-z0-9_-]+'/

    # The owner hands the launch to its scribe's claim; the recording's daemon
    # learns nothing more from the capture response.
    launch = launch_from_tmux_args(args)
    assert is_binary(launch)
    assert request["meeting_launch"] == launch
  end

  test "a capture meeting finds its scribe's fiber by the launch stamp, on any host", %{
    hark_dir: hark_dir
  } do
    set_starting_meeting_handler(hark_dir)
    Env.put_app_env(:meeting_fibers, fn -> [] end)

    {:ok, %{launch: launch}} =
      Meeting.start(%{"mode" => "call"}, :capture, "Shear review", nil)

    assert {:ok, %{meeting: %{fiber: nil, joined: false}}} = Meeting.show()

    Env.put_app_env(:meeting_fibers, fn ->
      [
        %{
          "id" => "01OTHER",
          "slug" => "proj/older",
          "shuttle" => %{"runtime" => %{"meeting" => "earlier-launch"}}
        },
        %{"id" => "01NOSHUTTLE", "slug" => "proj/plain"},
        %{
          "id" => "01SCRIBE",
          "slug" => "tools/hark/meetings/2026-09-25-1403-shear-review",
          "shuttle" => %{"host" => "candide", "runtime" => %{"meeting" => launch}}
        }
      ]
    end)

    assert {:ok,
            %{
              meeting: %{
                fiber: "tools/hark/meetings/2026-09-25-1403-shear-review",
                joined: false
              }
            }} = Meeting.show()

    conn = api_conn() |> get("/api/v1/meeting")

    assert %{
             "meeting" => %{
               "fiber" => "tools/hark/meetings/2026-09-25-1403-shear-review",
               "joined" => false
             }
           } = Jason.decode!(conn.resp_body)
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
    Env.put_app_env(:hark_path, false)

    conn =
      api_conn()
      |> post("/api/v1/capture", Jason.encode!(%{"meeting" => %{"mode" => "call"}}))

    assert conn.status == 503
    assert Jason.decode!(conn.resp_body)["error"] =~ "hark is not available"
    assert Shuttle.Test.MeetingRunner.calls() == []

    Env.put_app_env(:hark_path, hark_path)
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
        fn _ -> Meeting.start(request, :capture, "", "local") end,
        timeout: 60_000
      )
      |> Enum.to_list()

    assert Enum.count(results, &match?({:ok, {:ok, _}}, &1)) == 1
    assert Enum.count(results, &match?({:ok, {:error, {:conflict, _}}}, &1)) == 1

    assert Enum.count(Shuttle.Test.MeetingRunner.calls(), fn {cmd, args, _} ->
             cmd == "tmux" and match?(["new-session" | _], args)
           end) == 1
  end

  test "receiving recorder refuses a missing agent owner before any recording for every start",
       %{hark_dir: hark_dir} do
    for path <- ["/api/v1/capture", "/api/v1/meeting/join", "/api/v1/meeting/start"] do
      conn =
        post(
          api_conn(),
          path,
          Jason.encode!(%{
            recorder: Shuttle.Poller.own_host_id(),
            recorder_forwarded: true,
            origin: "absent-owner",
            meeting: %{mode: "phone"},
            prompt: "meeting",
            note: "meeting",
            fiber_id: "p/f",
            project_dir: hark_dir
          })
        )

      assert conn.status == 422
      assert Jason.decode!(conn.resp_body)["error"] =~ "unknown origin \"absent-owner\""
      assert Shuttle.Test.MeetingRunner.calls() == []
      refute File.exists?(Path.join(hark_dir, "meetings"))
    end

    assert {:error, {:validation, message}} =
             Meeting.meeting_paths("missing-owner", "absent-owner")

    assert message =~ "unknown origin"
  end

  test "system audio rejects invalid startup settings and phone controls", %{hark_dir: dir} do
    for value <- [nil, "false", 0] do
      assert {:error, {:validation, "meeting.system_audio must be a boolean"}} =
               Meeting.start(
                 %{"mode" => "call", "system_audio" => value},
                 :record,
                 "Audio",
                 "local"
               )
    end

    for {phase, phone} <- [{"live", "/tmp/phone.sock"}, {"loading", nil}, {"stopping", nil}] do
      write_meeting(dir, %{
        "launch" => "current",
        "pid" => 321,
        "phase" => phase,
        "phone" => phone
      })

      set_current_meeting_handler("current", 321)
      assert {:error, {:validation, _}} = Meeting.system_audio(false, launch: "current")
      refute Enum.any?(Shuttle.Test.MeetingRunner.calls(), fn {cmd, _, _} -> cmd == "env" end)
    end
  end

  test "system audio control is launch-bound and preserves the mic", %{hark_dir: dir} do
    write_meeting(dir, %{
      "launch" => "current",
      "pid" => 321,
      "phase" => "live",
      "system_audio" => true
    })

    set_current_meeting_handler("current", 321)

    for enabled <- [false, true] do
      conn =
        post(
          api_conn(),
          "/api/v1/meeting/system-audio",
          Jason.encode!(%{launch: "current", enabled: enabled})
        )

      assert conn.status == 200
      assert Jason.decode!(conn.resp_body)["meeting"]["system_audio"] == enabled
    end

    commands = for {"env", args, _} <- Shuttle.Test.MeetingRunner.calls(), do: args

    assert Enum.map(commands, &Enum.take(&1, -2)) == [
             ["pause", "--system"],
             ["resume", "--system"]
           ]

    assert Enum.all?(commands, &(hd(&1) == "HARK_DIR=" <> dir))

    conn =
      post(
        api_conn(),
        "/api/v1/meeting/system-audio",
        Jason.encode!(%{launch: "old", enabled: false})
      )

    assert conn.status == 409
    assert length(for {"env", _, _} <- Shuttle.Test.MeetingRunner.calls(), do: :command) == 2
  end

  test "mic-only start is explicit and the desktop default keeps system audio", %{hark_dir: dir} do
    for enabled <- [true, false] do
      File.rm(Path.join(dir, "meeting.json"))
      set_starting_meeting_handler(dir)

      assert {:ok, _} =
               Meeting.start(
                 %{"mode" => "call", "system_audio" => enabled},
                 :record,
                 "Audio",
                 "local"
               )

      {"tmux", ["new-session" | args], _} =
        Enum.find(Shuttle.Test.MeetingRunner.calls(), fn {cmd, args, _} ->
          cmd == "tmux" and match?(["new-session" | _], args)
        end)

      command = List.last(Enum.take_while(args, &(&1 != ";")))
      assert String.contains?(command, "--mic-only") == not enabled
    end
  end

  test "addressed stale stop cannot signal or dismiss a newer launch", %{hark_dir: hark_dir} do
    write_meeting(hark_dir, %{
      "launch" => "new",
      "pid" => 321,
      "phase" => "live",
      "transcript" => nil
    })

    set_current_meeting_handler("new", 321)

    conn =
      post(
        api_conn(),
        "/api/v1/meeting/stop",
        Jason.encode!(%{recorder: Shuttle.Poller.own_host_id(), launch: "old"})
      )

    assert conn.status == 409
    assert %{"meeting" => %{"launch" => "new"}, "recorder" => own} = Jason.decode!(conn.resp_body)
    assert own == Shuttle.Poller.own_host_id()

    refute Enum.any?(Shuttle.Test.MeetingRunner.calls(), fn {command, args, _} ->
             command == "kill" or (command == "tmux" and hd(args) == "kill-session")
           end)

    assert {:ok, _} = Meeting.stop(launch: "new")

    assert Enum.any?(Shuttle.Test.MeetingRunner.calls(), fn {command, _, _} ->
             command == "kill"
           end)
  end

  test "a timed out signal remains unconfirmed on retry", %{hark_dir: hark_dir} do
    write_meeting(hark_dir, %{"launch" => "timeout", "pid" => 321, "phase" => "live"})

    Shuttle.Test.MeetingRunner.set_handler(fn
      "tmux", ["display-message" | _], _, state -> {{"0|0|1234|timeout|\n", 0}, state}
      "ps", _, _, state -> {{"hark capture", 0}, state}
      "kill", _, _, state -> {{"timed out", :timeout}, state}
      _, _, _, state -> {{"", 0}, state}
    end)

    assert {:error, {:operation, _}} = Meeting.stop()
    assert {:error, {:operation, message}} = Meeting.stop()
    assert message =~ "unconfirmed"

    assert Enum.count(Shuttle.Test.MeetingRunner.calls(), fn {cmd, _, _} -> cmd == "kill" end) ==
             1
  end

  test "a failed signal releases the stop claim for retry", %{hark_dir: hark_dir} do
    write_meeting(hark_dir, %{"launch" => "retry", "pid" => 321, "phase" => "live"})

    Shuttle.Test.MeetingRunner.set_handler(fn
      "tmux", ["display-message" | _], _, state -> {{"0|0|1234|retry|\n", 0}, state}
      "ps", _, _, state -> {{"hark capture", 0}, state}
      "kill", _, _, nil -> {{"signal failed", 1}, :retried}
      _, _, _, state -> {{"", 0}, state}
    end)

    assert {:error, {:operation, _}} = Meeting.stop()
    assert {:ok, _} = Meeting.stop()

    assert Enum.count(Shuttle.Test.MeetingRunner.calls(), fn
             {"kill", ["-INT", "321"], _} -> true
             _ -> false
           end) == 2
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
      |> Task.async_stream(fn _ -> Meeting.stop() end, timeout: 60_000)
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

  for phase <- ["loading", "live"], missing <- [:tmux_launch, :json_launch, :dead_pane] do
    test "#{phase} hark with #{missing} supplies the card state and can be stopped", %{
      hark_dir: hark_dir
    } do
      data = %{"launch" => "current", "pid" => 321, "phase" => unquote(phase)}
      data = if unquote(missing) == :json_launch, do: Map.delete(data, "launch"), else: data
      write_meeting(hark_dir, data)
      stamp = if unquote(missing) == :tmux_launch, do: "", else: "current"
      pane = if unquote(missing) == :dead_pane, do: "1|1", else: "0|0"

      Shuttle.Test.MeetingRunner.set_handler(fn
        "tmux", ["display-message" | _], _opts, state ->
          {{"#{pane}|1234|#{stamp}|\n", 0}, state}

        "ps", ["-p", "321", "-o", "command="], _opts, state ->
          {{"python hark capture", 0}, state}

        _command, _args, _opts, state ->
          {{"", 0}, state}
      end)

      assert {:ok, %{meeting: %{state: unquote(phase)}}} = Meeting.show()
      assert {:ok, _} = Meeting.stop(launch: "current")
      assert {:ok, _} = Meeting.stop(launch: "current")

      assert Enum.count(Shuttle.Test.MeetingRunner.calls(), fn
               {"kill", ["-INT", "321"], _} -> true
               _ -> false
             end) == 1

      refute Enum.any?(Shuttle.Test.MeetingRunner.calls(), fn
               {"tmux", ["kill-session" | _], _} -> true
               _ -> false
             end)
    end
  end

  for phase <- ["live", "failed"] do
    test "a starting or failed row signals a recovered #{phase} hark pid", %{hark_dir: hark_dir} do
      write_meeting(hark_dir, %{"launch" => "current", "pid" => 321, "phase" => unquote(phase)})
      pane = if unquote(phase) == "failed", do: "1|1", else: "0|0"

      Shuttle.Test.MeetingRunner.set_handler(fn
        "tmux", ["display-message" | _], _opts, state ->
          {{"#{pane}|1234|current|\n", 0}, state}

        "ps", ["-p", "321", "-o", "command="], _opts, nil ->
          {{"", 1}, :recovered}

        "ps", ["-p", "321", "-o", "command="], _opts, state ->
          {{"python hark capture", 0}, state}

        _command, _args, _opts, state ->
          {{"", 0}, state}
      end)

      assert {:ok, _} = Meeting.stop(launch: "current")
      assert {:ok, _} = Meeting.stop(launch: "current")

      assert Enum.count(Shuttle.Test.MeetingRunner.calls(), fn
               {"kill", ["-INT", "321"], _} -> true
               _ -> false
             end) == 1

      refute Enum.any?(Shuttle.Test.MeetingRunner.calls(), fn
               {"tmux", ["kill-session" | _], _} -> true
               _ -> false
             end)
    end
  end

  test "stop dismisses a failed pane when real ps confirms its pid is absent", %{
    hark_dir: hark_dir
  } do
    pid = "99998"
    assert {"", 1} = System.cmd("ps", ["-p", pid, "-o", "command="])
    write_meeting(hark_dir, %{"launch" => "absent", "pid" => pid, "phase" => "failed"})

    Shuttle.Test.MeetingRunner.set_handler(
      fn
        "tmux", ["display-message" | _], _, :present ->
          {{"1|1|1234|absent|\n", 0}, :present}

        "tmux", ["kill-session" | _], _, :present ->
          {{"", 0}, :absent}

        "tmux", ["has-session" | _], _, :absent ->
          {{"can't find session: hark-meeting", 1}, :absent}

        "ps", args, _, state ->
          {System.cmd("ps", args, stderr_to_stdout: true), state}

        _, _, _, state ->
          {{"", 0}, state}
      end,
      :present
    )

    assert {:ok, %{meeting: nil}} = Meeting.stop(launch: "absent")
  end

  test "stop preserves the recording when process observation times out", %{hark_dir: hark_dir} do
    write_meeting(hark_dir, %{"launch" => "unknown", "pid" => 321, "phase" => "live"})

    Shuttle.Test.MeetingRunner.set_handler(fn
      "tmux", ["display-message" | _], _, state -> {{"0|0|1234|unknown|\n", 0}, state}
      "ps", _, _, state -> {{"timed out", :timeout}, state}
      _, _, _, state -> {{"", 0}, state}
    end)

    assert {:error, {:operation, _}} = Meeting.stop(launch: "unknown")

    refute Enum.any?(Shuttle.Test.MeetingRunner.calls(), fn
             {"tmux", ["kill-session" | _], _} -> true
             _ -> false
           end)
  end

  test "stop clears a starting row when its tmux launch disappears and no hark pid lives", %{
    hark_dir: hark_dir
  } do
    write_meeting(hark_dir, %{"launch" => "current", "pid" => 321, "phase" => "live"})

    Shuttle.Test.MeetingRunner.set_handler(fn
      "tmux", ["display-message" | _], _opts, nil ->
        {{"0|0|1234|current|\n", 0}, :gone}

      "tmux", ["has-session" | _], _opts, :gone ->
        {{"can't find session: hark-meeting", 1}, :gone}

      "ps", ["-p", "321", "-o", "command="], _opts, state ->
        {{"other process", 0}, state}

      _command, _args, _opts, state ->
        {{"", 0}, state}
    end)

    assert {:ok, %{meeting: nil}} = Meeting.stop(launch: "current")
    assert {:ok, %{meeting: nil}} = Meeting.show()
    assert {:ok, %{meeting: nil}} = Meeting.stop(launch: "current")

    refute Enum.any?(Shuttle.Test.MeetingRunner.calls(), fn
             {"kill", _, _} -> true
             {"tmux", ["kill-session" | _], _} -> true
             _ -> false
           end)
  end

  test "a different explicit launch never adopts or signals the metadata's hark pid", %{
    hark_dir: hark_dir
  } do
    write_meeting(hark_dir, %{"launch" => "old", "pid" => 321, "phase" => "live"})
    set_current_meeting_handler("new", 321)
    assert {:ok, %{meeting: %{state: "starting", launch: "new"}}} = Meeting.show()
    assert {:error, {:stale_launch, %{launch: "new"}}} = Meeting.stop(launch: "old")

    refute Enum.any?(Shuttle.Test.MeetingRunner.calls(), fn {command, _, _} ->
             command in ["ps", "kill"]
           end)
  end

  test "stop dismisses starting and failed tmux sessions without signalling" do
    Shuttle.Test.MeetingRunner.set_handler(
      fn
        "tmux", ["display-message" | _], _opts, :starting ->
          {{"0|0|1234||", 0}, :starting}

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
    hark_dir = Shuttle.Env.app(:hark_dir)

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
          {{"1|2|1234|launch-failed|\n", 0}, :present}

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

  test "an interrupted capture retains the destination and prompt for manual recovery", %{
    hark_dir: dir
  } do
    set_starting_meeting_handler(dir)

    caller = self()

    task =
      Task.async(fn ->
        result =
          Meeting.start(%{"mode" => "call"}, :capture, "Review the shear cuts", nil,
            capture_destination: "/work/project"
          )

        send(caller, {:recorder_started, result})
        receive do: (:continue_delivery -> :ok)
      end)

    assert_receive {:recorder_started, {:ok, %{launch: launch, prompt: prompt}}}, 30_000
    # Kill the request before it invokes capture dispatch or reports delivery.
    assert nil == Task.shutdown(task, :brutal_kill)
    assert {:ok, %{meeting: %{handoff: receipt}}} = Meeting.show()

    assert %{
             "status" => "unconfirmed",
             "kind" => "capture",
             "target" => "/work/project",
             "prompt" => ^prompt
           } = receipt

    assert %{"status" => "pending"} =
             dir |> Path.join("handoffs/#{launch}.json") |> File.read!() |> Jason.decode!()
  end

  test "record-only intent is explicit on later reads", %{hark_dir: dir} do
    set_starting_meeting_handler(dir)
    assert {:ok, _} = Meeting.start(%{"mode" => "call"}, :record, nil, nil)

    assert {:ok, %{meeting: %{handoff: %{"kind" => "record", "status" => "record-only"}}}} =
             Meeting.show()
  end

  test "a recording exposes an interrupted agent handoff on later reads", %{hark_dir: dir} do
    set_starting_meeting_handler(dir)

    assert {:ok, %{launch: launch}} =
             Meeting.start(%{"mode" => "call"}, {:fiber, "project/fiber"}, "review", nil)

    assert {:ok,
            %{
              meeting: %{
                launch: ^launch,
                handoff: %{"status" => "unconfirmed", "target" => "project/fiber"}
              }
            }} =
             Meeting.show()

    assert %{handoff: %{"status" => "reported-success"}} =
             Meeting.log_delivery(%{launch: launch}, 202, %{delivered: nil})

    assert {:ok, %{meeting: %{handoff: %{"status" => "reported-success"}}}} = Meeting.show()
    Meeting.log_delivery(%{launch: launch}, 502, %{error: "unreachable"})
    assert {:ok, %{meeting: %{handoff: %{"status" => "reported-failure"}}}} = Meeting.show()
  end

  test "a second meeting in the same minute gets its own transcript and HARK_DIR is explicit", %{
    hark_dir: hark_dir
  } do
    existing = Path.join(hark_dir, "meetings/2026-09-25_1403_shear-review.txt")
    File.mkdir_p!(Path.dirname(existing))
    File.write!(existing, "# hark\n# ended 14:04:00\n")
    set_starting_meeting_handler(hark_dir)

    assert {:ok, %{prompt: prompt}} =
             Meeting.start(%{"mode" => "call"}, :capture, "Shear review", "local")

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
    Env.put_app_env(:remotes, [
      %{name: "project-host", ssh: "remote-alias", url: "http://127.0.0.1:4001"}
    ])

    start_supervised!({Shuttle.Test.MeetingCaptureForwardClient, {:ok, 200, "{}"}})
    Env.put_app_env(:write_forward_client, Shuttle.Test.MeetingCaptureForwardClient)

    Shuttle.Test.MeetingRunner.set_handler(fn
      "tmux", ["has-session" | _], _opts, nil ->
        {{"can't find session: hark-meeting", 1}, nil}

      "tmux", ["display-message" | _], _opts, nil ->
        {{"can't find session: hark-meeting", 1}, nil}

      "tmux", ["new-session" | args], _opts, _state ->
        {{"$4\n", 0}, launch_from_tmux_args(args)}

      "tmux", ["display-message" | _], _opts, launch ->
        {{"1|2|1234|#{launch}|\n", 0}, launch}

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

  test "launch wait recognizes live hark even when tmux has no launch stamp", %{hark_dir: dir} do
    Env.put_app_env(:meeting_launch_wait_ms, 0)
    set_starting_meeting_handler(dir, false)

    assert {:ok, %{meeting: %{state: "live", launch: launch}}} =
             Meeting.start(%{"mode" => "call"}, :capture, "Shear review", nil)

    assert {:ok, %{meeting: %{state: "live", launch: ^launch}}} = Meeting.show()
  end

  test "an unreadable tmux after creation still reports recording as starting" do
    Env.put_app_env(:meeting_launch_wait_ms, 300)

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
             Meeting.start(%{"mode" => "call"}, :capture, "Shear review", "local")
  end

  test "an unmatched observation after creation is uncertain, not a failed launch", %{
    hark_dir: hark_dir
  } do
    Env.put_app_env(:meeting_launch_wait_ms, 300)

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
             Meeting.start(%{"mode" => "call"}, :capture, "Shear review", "local")
  end

  test "a reap never kills a newer launch that replaced the inspected one", %{
    hark_dir: hark_dir
  } do
    write_meeting(hark_dir, %{"launch" => "L1", "phase" => "ended", "pid" => 1, "title" => "old"})

    Shuttle.Test.MeetingRunner.set_handler(
      fn
        "tmux", ["display-message" | _], _opts, 0 ->
          {{"1|0|1234|L1|\n", 0}, 1}

        "tmux", ["display-message" | _], _opts, n ->
          {{"0|0|1235|L2|\n", 0}, n + 1}

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
        {{"0|0|1234|#{launch}|\n", 0}, state}

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

  defp set_starting_meeting_handler(hark_dir, stamp_launch? \\ true) do
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
        stamp = if stamp_launch?, do: launch, else: ""
        {{"0|0|1234|#{stamp}|\n", 0}, launch}

      "ps", ["-p", "321", "-o", "command="], _opts, launch ->
        {{"python hark capture", 0}, launch}

      _command, _args, _opts, state ->
        {{"", 0}, state}
    end)
  end

  defp set_joined_meeting_handler(hark_dir) do
    Shuttle.Test.MeetingRunner.set_handler(fn
      "tmux", ["display-message" | _], _opts, nil ->
        {{"can't find session: hark-meeting", 1}, nil}

      "tmux", ["new-session" | args], _opts, _state ->
        launch = launch_from_tmux_args(args)

        write_meeting(hark_dir, %{
          "launch" => launch,
          "pid" => 321,
          "phase" => "live",
          "title" => "shear-bmodes",
          "started" => "2026-09-25T14:03:00+02:00",
          "transcript" => Path.join(hark_dir, "meetings/2026-09-25_1403_shear-bmodes.txt"),
          "mirror" => "remote-alias:~/.hark/meetings/2026-09-25_1403_shear-bmodes.txt"
        })

        {{"$4\n", 0}, {launch, fiber_from_tmux_args(args)}}

      "tmux", ["display-message" | _], _opts, {launch, fiber} ->
        {{"0|0|1234|#{launch}|#{fiber}\n", 0}, {launch, fiber}}

      "ps", ["-p", "321", "-o", "command="], _opts, state ->
        {{"python hark capture", 0}, state}

      _command, _args, _opts, state ->
        {{"", 0}, state}
    end)
  end

  defp fiber_from_tmux_args(args) do
    args
    |> Enum.chunk_every(2, 1, :discard)
    |> Enum.find_value(fn
      ["@hark_fiber", fiber] -> fiber
      _ -> nil
    end)
  end

  defp wait_for_dead_pane(tmux_cmd, session, format, attempts) do
    {output, status} =
      tmux_cmd.(["display-message", "-p", "-t", "=" <> session <> ":", format])

    # A closed PTY can precede SIGCHLD delivery; libutempter can lose that
    # signal entirely. Wake only this isolated server's reaper while the
    # retained pane has incomplete exit evidence (tmux/tmux#4559).
    if status == 0 and String.starts_with?(output, "1||") do
      {server, 0} = tmux_cmd.(["display-message", "-p", "\#{pid}"])
      {pid, ""} = Integer.parse(String.trim(server))
      assert pid > 1
      assert {_, 0} = Shuttle.Env.cmd("kill", ["-s", "CHLD", to_string(pid)])
    end

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
