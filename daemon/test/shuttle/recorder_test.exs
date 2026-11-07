defmodule Shuttle.Test.RecorderRunner do
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
    do: {{"can't find session: hark-voice", 1}, custom}

  defp default(_command, _args, _opts, custom), do: {{"", 0}, custom}
end

defmodule Shuttle.RecorderRexTest do
  use ExUnit.Case, async: false
  alias Shuttle.RetainedTerminal
  alias Shuttle.Rex, as: RexCLI
  alias Shuttle.Terminal.Rex
  @moduletag :tmp_dir
  @moduletag skip: is_nil(Shuttle.Rex.bin())

  test "a Hark block exit is shown as failed with its transcript intact", %{tmp_dir: root} do
    start_rex_server(root)
    hark_dir = Path.join(root, "hark")
    File.mkdir_p!(Path.join(hark_dir, "voice"))
    transcript = Path.join(hark_dir, "voice/capture.txt")
    File.write!(transcript, "The lensing result is stable.\n")
    launch = "rex-voice-#{System.unique_integer([:positive])}"
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
               "hark-voice",
               root,
               [script],
               %{"launch" => launch, "fiber" => "project/voice"},
               Shuttle.Runner.Default,
               Keyword.put(opts, :env, %{"HARK_DIR" => hark_dir})
             )

    wait_for(fn -> File.exists?(Path.join(state_dir, "hark-voice.json")) end)

    wait_for(fn ->
      match?(
        {:ok, %{dead: true}},
        RetainedTerminal.observe("hark-voice", Shuttle.Runner.Default, opts)
      )
    end)

    assert {:ok, %{capture: meeting}} = Shuttle.Recorder.show(opts)

    assert %{
             state: "failed",
             title: "Test",
             launch: ^launch,
             transcript: ^transcript
           } = meeting

    assert File.read!(meeting.transcript) == "The lensing result is stable.\n"
  end

  @tag :rex_recorder
  test "a Rex server loss turns the live capture into a failed row with its transcript", %{
    tmp_dir: root
  } do
    server_pid = start_rex_server(root)
    {hark_dir, transcript, script, launch} = live_hark_fixture(root)
    state_dir = Path.join(root, "retained")
    opts = recorder_opts(state_dir, hark_dir)

    assert :ok = start_retained(script, launch, root, hark_dir, opts)
    wait_for(fn -> File.exists?(Path.join(hark_dir, "meeting.json")) end)

    wait_for(fn ->
      match?({:ok, %{dead: false, pid: pid}} when is_integer(pid), observe(opts))
    end)

    assert {:ok, %{capture: %{state: "live", launch: ^launch}}} = Shuttle.Recorder.show(opts)

    assert {_, 0} = System.cmd("kill", ["-9", to_string(server_pid)])

    wait_for(fn ->
      match?({:ok, %{capture: %{state: "failed", launch: ^launch}}}, Shuttle.Recorder.show(opts))
    end)

    assert {:ok, %{capture: meeting}} = Shuttle.Recorder.show(opts)
    assert meeting.transcript == transcript
    assert File.read!(meeting.transcript) == "The lensing result is stable.\n"
  end

  @tag :rex_recorder
  defp start_rex_server(data_dir) do
    rex_root = Path.join(System.tmp_dir!(), "voice-rex-#{System.unique_integer([:positive])}")
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
    File.mkdir_p!(Path.join(hark_dir, "voice"))
    transcript = Path.join(hark_dir, "voice/capture.txt")
    File.write!(transcript, "The lensing result is stable.\n")
    script = Path.join(root, "hark-bin")
    launch = "rex-voice-#{System.unique_integer([:positive])}"

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

  defp recorder_opts(state_dir, hark_dir),
    do: [terminal: Rex, runner: Shuttle.Runner.Default, state_dir: state_dir, hark_dir: hark_dir]

  defp start_retained(script, launch, cwd, hark_dir, opts) do
    RetainedTerminal.start(
      "hark-voice",
      cwd,
      [
        script,
        "-o",
        Path.join(hark_dir, "voice/capture.txt"),
        "--launch=" <> launch,
        "--title=Test"
      ],
      %{"launch" => launch, "fiber" => nil},
      Shuttle.Runner.Default,
      Keyword.put(opts, :env, %{"HARK_DIR" => hark_dir})
    )
  end

  defp observe(opts),
    do: RetainedTerminal.observe("hark-voice", Shuttle.Runner.Default, opts)

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

defmodule Shuttle.RecorderTest do
  # group: Shuttle.Recorder.Control is one app-started claim every meeting route reconciles.
  use ExUnit.Case, async: true, group: :recorder

  alias Shuttle.Recorder
  alias Shuttle.Test.Env

  @moduletag :tmp_dir

  setup %{tmp_dir: tmp_dir} do
    hark_dir = Path.join(tmp_dir, "hark")
    hark_path = Path.join(tmp_dir, "hark-bin")
    File.mkdir_p!(hark_dir)
    File.write!(hark_path, "#!/bin/sh\nexit 0\n")
    File.chmod!(hark_path, 0o755)

    start_supervised!(Shuttle.Test.RecorderRunner)
    Env.put_app_env(:recorder_runner, Shuttle.Test.RecorderRunner)
    Env.put_app_env(:hark_dir, hark_dir)
    Env.put_app_env(:hark_path, hark_path)
    Env.put_app_env(:remotes, [])
    Env.put_app_env(:own_host_id, "local-host")
    Env.put_env("SHUTTLE_VOICE_FILE", Path.join(tmp_dir, "voice.json"))
    Env.put_env("SHUTTLE_DATA_DIR", tmp_dir)
    Recorder.Control.reconcile(nil)

    on_exit(fn -> Recorder.Control.reconcile(nil) end)

    %{tmp_dir: tmp_dir, hark_dir: hark_dir, hark_path: hark_path}
  end

  test "voice argv selects desktop system audio and live toggles use the system gate", %{
    hark_dir: dir,
    hark_path: hark
  } do
    set_voice_handler(dir)

    assert {:ok, %{capture: %{launch: launch}}} =
             Recorder.reconcile_voice(true, system_audio: true)

    assert Enum.any?(Shuttle.Test.RecorderRunner.calls(), fn
             {"tmux", ["new-session" | args], _} ->
               Enum.any?(
                 args,
                 &(String.contains?(&1, "'--voice'") and String.contains?(&1, "'--system-audio'"))
               )

             _ ->
               false
           end)

    assert :ok = Recorder.system_audio(false)
    assert :ok = Recorder.system_audio(true)
    calls = Shuttle.Test.RecorderRunner.calls()

    assert {"env", ["HARK_DIR=" <> dir, hark, "pause", "--system"],
            [stderr_to_stdout: true, timeout_ms: 5000]} in calls

    assert {"env", ["HARK_DIR=" <> dir, hark, "resume", "--system"],
            [stderr_to_stdout: true, timeout_ms: 5000]} in calls

    assert {:ok, %{capture: %{launch: ^launch}}} = Recorder.reconcile_voice(true)
    assert {:ok, %{capture: nil}} = Recorder.reconcile_voice(false)
  end

  test "source switches stop the old recorder before starting its replacement", %{hark_dir: dir} do
    for behavior <- [:graceful, :ignore_interrupt, :unkillable] do
      File.rm(Path.join(dir, "meeting.json"))
      set_voice_handler(dir, behavior)
      assert {:ok, %{capture: %{launch: first}}} = Recorder.reconcile_voice(true)
      result = Recorder.reconcile_voice(true, source: "phone", voice_stop_wait_ms: 0)
      calls = Shuttle.Test.RecorderRunner.calls()
      launches = for {"tmux", ["new-session" | _], _} <- calls, do: :launch

      if behavior == :unkillable do
        assert {:error, {:operation, "live voice process did not exit"}} = result
        assert launches == [:launch]
      else
        assert {:ok, %{capture: %{launch: next, phone: true}}} = result
        refute first == next
        assert launches == [:launch, :launch]
        signal = Enum.find_index(calls, fn {command, _, _} -> command == "kill" end)

        assert Enum.any?(Enum.drop(calls, signal + 1), fn
                 {"tmux", ["new-session" | _], _} -> true
                 _ -> false
               end)
      end
    end
  end

  test "enabling voice from a phone uses the same launch and publishes its source", %{
    hark_dir: dir
  } do
    set_voice_handler(dir)

    Env.start_scoped!(
      {Shuttle.Voice,
       [
         name: nil,
         poll_ms: 60_000,
         relay: fn _, _ -> :ok end,
         monitor: fn _ -> %{pending: nil, last: nil} end
       ]}
    )

    assert {:ok, %{enabled: true, source: "phone", launch: "voice-" <> _}} =
             Shuttle.Voice.update(%{"enabled" => true, "source" => "phone"})

    assert Enum.any?(Shuttle.Test.RecorderRunner.calls(), fn
             {"tmux", ["new-session" | args], _} ->
               Enum.any?(
                 args,
                 &(String.contains?(&1, "'--voice'") and String.contains?(&1, "'--phone'") and
                     not String.contains?(&1, "'--system-audio'"))
               )

             _ ->
               false
           end)

    stop_supervised!(Shuttle.Voice)

    Env.start_scoped!(
      {Shuttle.Voice,
       [
         name: nil,
         poll_ms: 60_000,
         relay: fn _, _ -> :ok end,
         monitor: fn _ -> %{pending: nil, last: nil} end
       ]}
    )

    assert {:ok, %{source: "phone"}} = Shuttle.Voice.update(%{})

    assert Enum.count(Shuttle.Test.RecorderRunner.calls(), fn
             {"tmux", ["new-session" | _], _} -> true
             _ -> false
           end) == 1
  end

  test "system audio is persisted by the voice API and applied without restarting", %{
    hark_dir: dir
  } do
    set_voice_handler(dir)

    Env.start_scoped!(
      {Shuttle.Voice,
       [
         name: nil,
         poll_ms: 60_000,
         relay: fn _, _ -> :ok end,
         monitor: fn _ -> %{pending: nil, last: nil} end
       ]}
    )

    assert {:ok, %{launch: launch}} = Shuttle.Voice.update(%{"enabled" => true})

    assert {:ok, %{system_audio: true, launch: ^launch}} =
             Shuttle.Voice.update(%{"system_audio" => true})

    assert {:ok, %{"system_audio" => true}} = Shuttle.Voice.Config.read()

    assert Enum.any?(Shuttle.Test.RecorderRunner.calls(), fn
             {"env", [_, _, "resume", "--system"], _} -> true
             _ -> false
           end)
  end

  test "a failed live system gate reports persisted intent and retries on reconciliation", %{
    hark_dir: dir
  } do
    set_voice_handler(dir, :system_failure)

    Env.start_scoped!(
      {Shuttle.Voice,
       [
         name: nil,
         poll_ms: 60_000,
         relay: fn _, _ -> :ok end,
         monitor: fn _ -> %{pending: nil, last: nil} end
       ]}
    )

    assert {:ok, _} = Shuttle.Voice.update(%{"enabled" => true})
    File.write!(Path.join(dir, "system-paused"), "")
    assert {:error, error} = Shuttle.Voice.update(%{"system_audio" => true})
    assert error =~ "system gate failed"
    assert %{enabled: true, system_audio: true, state: "failed"} = Shuttle.Voice.show()
    assert {:ok, %{"system_audio" => true}} = Shuttle.Voice.Config.read()
    assert {:ok, %{system_audio: true, state: "failed"}} = Shuttle.Voice.update(%{})

    assert Enum.count(Shuttle.Test.RecorderRunner.calls(), fn
             {"env", [_, _, "resume", "--system"], _} -> true
             _ -> false
           end) == 2
  end

  test "pure state derivation rejects stale metadata and trusts terminal captures only while alive" do
    alive = %{state: :alive, session_created: 1_790_328_192, launch: "launch-new"}
    dead = %{state: {:dead, 7}, session_created: 1_790_328_192, launch: "launch-new"}

    stale = %{
      "launch" => "launch-old",
      "phase" => "ended",
      "title" => "stale title",
      "transcript" => "/tmp/stale.txt",
      "mirror" => "old-alias:~/.hark/voice/stale.txt",
      "error" => "stale error"
    }

    {starting, false} = Recorder.derive(alive, stale, false)

    assert %{
             state: "starting",
             title: nil,
             started_at: nil,
             transcript: nil,
             tail: [],
             error: nil
           } = starting

    {failed, false} = Recorder.derive(%{dead | state: {:dead, 0}}, stale, false, "pane tail")
    assert %{state: "failed", title: nil, transcript: nil, error: "pane tail"} = failed

    fresh_ended = %{"launch" => "launch-new", "phase" => "ended", "title" => "complete"}
    {nil, true} = Recorder.derive(%{dead | state: {:dead, 0}}, fresh_ended, false)

    active = %{
      "launch" => "launch-new",
      "phase" => "live",
      "pid" => 321,
      "title" => "current meeting",
      "started" => "2026-09-25T14:03:12+02:00",
      "transcript" => "/tmp/current.txt",
      "mirror" => "remote-alias:~/.hark/voice/current.txt"
    }

    Env.put_app_env(:remotes, [
      %{name: "project-host", ssh: "remote-alias", url: "http://127.0.0.1:4001"}
    ])

    {live, false} = Recorder.derive(alive, active, true)

    assert %{state: "live", title: "current meeting"} = live

    {starting_with_fresh_data, false} = Recorder.derive(alive, active, false)

    assert %{state: "starting", title: "current meeting", transcript: "/tmp/current.txt"} =
             starting_with_fresh_data

    {unmapped, false} =
      Recorder.derive(alive, Map.put(active, "mirror", "unknown-alias:path"), true)

    refute Map.has_key?(unmapped, :mirror_host)

    {terminal, false} = Recorder.derive(:absent, Map.delete(active, "launch"), true)
    assert %{state: "live", tmux_session: nil} = terminal
    {nil, false} = Recorder.derive(:absent, Map.put(active, "phase", "ended"), false)
  end

  test "tmux output parser distinguishes alive, dead exit status, and absent sessions" do
    assert {:ok, %{state: :alive, session_created: 1234, launch: "launch-a"}} =
             Recorder.parse_tmux_result("0|0|1234|launch-a\n", 0)

    assert {:ok, %{state: {:dead, 17}, session_created: 1234, launch: nil}} =
             Recorder.parse_tmux_result("1|17|1234|\n", 0)

    assert {:ok, :absent} = Recorder.parse_tmux_result("can't find session: throwaway", 1)
    assert {:error, {:tmux, _}} = Recorder.parse_tmux_result("garbled", 0)
  end

  @tag :tmux
  @tag skip: is_nil(System.find_executable("tmux"))
  test "a missing voice terminal preserves its failed row for explicit retry", %{hark_dir: dir} do
    set_voice_handler(dir, :orphan_terminal)
    assert {:ok, %{capture: %{launch: launch}}} = Recorder.reconcile_voice(true)
    Shuttle.Test.RecorderRunner.set_custom({launch, :crashed})

    for _ <- 1..3 do
      assert {:ok, %{capture: %{launch: ^launch, kind: "voice", state: "failed"}}} =
               Recorder.reconcile_voice(true)
    end

    assert Enum.count(Shuttle.Test.RecorderRunner.calls(), fn {cmd, args, _} ->
             cmd == "tmux" and match?(["new-session" | _], args)
           end) == 1
  end

  test "Rex without a retained pointer stops a live voice orphan", %{hark_dir: dir} do
    set_voice_handler(dir)
    assert {:ok, %{capture: %{launch: launch}}} = Recorder.reconcile_voice(true)
    opts = [terminal: Shuttle.Terminal.Rex, state_dir: Path.join(dir, "retained")]
    assert {:ok, %{capture: %{launch: ^launch, state: "live"}}} = Recorder.show(opts)
    assert {:ok, %{capture: nil}} = Recorder.reconcile_voice(false, opts)
    assert {^launch, :ended} = Shuttle.Test.RecorderRunner.custom()
    assert File.read!(Path.join([dir, "voice", launch <> ".txt"])) =~ "# ended"
  end

  test "Rex without a retained pointer cannot replace an unverified voice PID", %{hark_dir: dir} do
    write_capture(dir, %{
      "launch" => "voice-orphan",
      "kind" => "voice",
      "phase" => "live",
      "pid" => 321
    })

    Shuttle.Test.RecorderRunner.set_handler(fn
      "ps", _args, _opts, state -> {{"permission denied", 2}, state}
      _cmd, _args, _opts, state -> {{"", 0}, state}
    end)

    opts = [
      terminal: Shuttle.Terminal.Rex,
      state_dir: Path.join(dir, "retained"),
      voice_stop_wait_ms: 0
    ]

    for enabled <- [false, true] do
      assert {:error, {:operation, message}} =
               Recorder.reconcile_voice(enabled, Keyword.put(opts, :restart_voice, true))

      assert message =~ "could not verify"
    end

    refute Enum.any?(Shuttle.Test.RecorderRunner.calls(), fn {cmd, _, _} -> cmd == "rex" end)
  end

  test "ended lifecycle evidence cannot replace a recorder whose PID is unverified", %{
    hark_dir: dir
  } do
    write_capture(dir, %{"launch" => "old-meeting", "phase" => "ended", "pid" => 321})

    Shuttle.Test.RecorderRunner.set_handler(fn
      "tmux", _args, _opts, state -> {{"can't find session: hark-voice", 1}, state}
      "ps", _args, _opts, state -> {{"permission denied", 2}, state}
      _cmd, _args, _opts, state -> {{"", 0}, state}
    end)

    assert {:error, {:operation, message}} = Recorder.reconcile_voice(true, voice_stop_wait_ms: 0)
    assert message =~ "could not verify"

    refute Enum.any?(Shuttle.Test.RecorderRunner.calls(), fn {cmd, args, _} ->
             cmd == "tmux" and match?(["new-session" | _], args)
           end)
  end

  defp set_voice_handler(dir, behavior \\ :graceful) do
    Shuttle.Test.RecorderRunner.set_handler(fn
      "tmux", ["has-session" | _], _opts, nil ->
        {{"can't find session: hark-voice", 1}, nil}

      "tmux", ["display-message" | _], _opts, nil ->
        {{"can't find session: hark-voice", 1}, nil}

      "tmux", ["has-session" | _], _opts, state when behavior == :orphan_terminal ->
        {{"can't find session: hark-voice", 1}, state}

      "tmux", ["display-message" | _], _opts, {launch, :live} = state ->
        {{"0|0|1234|#{launch}\n", 0}, state}

      "tmux", ["display-message" | _], _opts, {launch, :ended} = state ->
        {{"1|0|1234|#{launch}\n", 0}, state}

      "tmux", ["display-message" | _], _opts, {launch, :crashed} = state ->
        {{"1|9|1234|#{launch}\n", 0}, state}

      "tmux", ["new-session" | args], _opts, _state ->
        launch = launch_from_tmux_args(args)
        path = Path.join([dir, "voice", launch <> ".txt"])
        File.mkdir_p!(Path.dirname(path))
        File.write!(path, "")

        write_capture(dir, %{
          "launch" => launch,
          "kind" => "voice",
          "pid" => 321,
          "phase" => "live",
          "transcript" => path,
          "started" => DateTime.to_iso8601(DateTime.utc_now()),
          "phone" =>
            if(Enum.any?(args, &String.contains?(&1, "'--phone'")),
              do: Path.join(dir, "phone.sock")
            )
        })

        {{"$4\n", 0}, {launch, :live}}

      "tmux", ["kill-session" | _], _opts, _state ->
        {{"", 0}, nil}

      "ps", ["-p", "321", "-o", "command="], _opts, {_, :live} = state ->
        {{"python hark capture", 0}, state}

      "ps", ["-p", "321", "-o", "command="], _opts, state ->
        {{"", 1}, state}

      "kill", ["-INT", "321"], _opts, {launch, _} = state ->
        if behavior in [:graceful, :orphan_terminal] do
          row = File.read!(Path.join(dir, "meeting.json")) |> Jason.decode!()
          File.write!(row["transcript"], "# ended\n", [:append])
          write_capture(dir, Map.put(row, "phase", "ended"))
          {{"", 0}, {launch, :ended}}
        else
          {{"", if(behavior == :interrupt_error, do: 1, else: 0)}, state}
        end

      "kill", ["-KILL", "321"], _opts, {launch, _} = state ->
        if behavior == :unkillable,
          do: {{"not permitted", 1}, state},
          else: {{"", 0}, {launch, :crashed}}

      "env", [_, _, _, "--system"], _opts, state when behavior == :system_failure ->
        {{"system gate failed", 1}, state}

      "env", [_hark_dir, _executable, command, "--system"], _opts, state ->
        if command == "pause",
          do: File.write!(Path.join(dir, "system-paused"), ""),
          else: File.rm(Path.join(dir, "system-paused"))

        {{"", 0}, state}

      "env", [_hark_dir, _executable, command], _opts, state
      when command in ["pause", "resume"] ->
        if command == "pause",
          do: File.write!(Path.join(dir, "paused"), ""),
          else: File.rm(Path.join(dir, "paused"))

        {{"", 0}, state}

      _command, _args, _opts, state ->
        {{"", 0}, state}
    end)
  end

  defp launch_from_tmux_args(args) do
    args
    |> Enum.chunk_every(2, 1, :discard)
    |> Enum.find_value(fn
      ["@hark_launch", launch] -> launch
      _ -> nil
    end)
  end

  defp write_capture(hark_dir, data),
    do: File.write!(Path.join(hark_dir, "meeting.json"), Jason.encode!(data))
end
