defmodule Shuttle.Test.HarkPauseRunner do
  def cmd("tmux", ["display-message" | _], _opts),
    do: {"0|0|1234|pause-probe|\n", 0}

  # Python import latency isn't the behavior under test.
  def cmd(command, args, opts),
    do: Shuttle.Runner.Default.cmd(command, args, Keyword.put(opts, :timeout_ms, 60_000))
end

defmodule Shuttle.MeetingPauseRealTest do
  use ExUnit.Case, async: true, group: :meeting
  alias Shuttle.Meeting

  @moduletag :integration
  @moduletag :tmp_dir
  @python System.get_env("SHUTTLE_TEST_HARK_PYTHON")
  @moduletag skip: is_nil(@python)

  test "real hark CLI pauses both PCM gates and resumes the prior system choice", %{tmp_dir: root} do
    for {mode, system_silent} <- [{"mic-only", true}, {"system", false}] do
      dir = Path.join(root, mode)

      port =
        Port.open({:spawn_executable, @python}, [
          :binary,
          :exit_status,
          {:line, 16_384},
          args: [Path.expand("../fixtures/hark/pause_probe.py", __DIR__), mode],
          env: [{~c"HARK_DIR", String.to_charlist(dir)}]
        ])

      assert line(port) == "ready"

      opts = [
        runner: Shuttle.Test.HarkPauseRunner,
        hark_dir: dir,
        hark_path: Path.join(Path.dirname(@python), "hark"),
        launch: "pause-probe"
      ]

      assert probe(port) == %{"mic_silent" => false, "system_silent" => system_silent}
      assert {:ok, %{meeting: %{state: "live", paused: false}}} = Meeting.show(opts)

      assert {:ok, %{meeting: %{state: "live", paused: true}}} = Meeting.pause(true, opts)
      assert probe(port) == %{"mic_silent" => true, "system_silent" => true}
      assert {:ok, %{meeting: %{paused: true}}} = Meeting.pause(true, opts)

      assert {:ok, %{meeting: %{state: "live", paused: false}}} = Meeting.pause(false, opts)
      assert probe(port) == %{"mic_silent" => false, "system_silent" => system_silent}
      assert {:ok, %{meeting: %{paused: false}}} = Meeting.pause(false, opts)
      assert probe(port) == %{"mic_silent" => false, "system_silent" => system_silent}

      Port.command(port, "quit\n")
      assert_receive {^port, {:exit_status, 0}}, 30_000
      transcript = File.read!(Path.join(dir, "probe.txt"))
      assert transcript =~ "# paused\n"
      assert transcript =~ "# resumed at"
      assert transcript =~ "# system audio paused\n"
      assert String.contains?(transcript, "# system audio resumed at") == not system_silent
      assert String.ends_with?(transcript, "# ended\n")
    end
  end

  defp probe(port) do
    Port.command(port, "probe\n")
    port |> line() |> Jason.decode!()
  end

  defp line(port) do
    assert_receive {^port, {:data, {:eol, line}}}, 30_000
    line
  end
end
