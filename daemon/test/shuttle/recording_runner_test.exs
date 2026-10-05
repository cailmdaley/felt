defmodule Shuttle.RecordingRunnerTest do
  use ExUnit.Case, async: false

  alias Shuttle.Test.RecordingRunner

  test "test supervision shuts down the recorder before the next recording starts" do
    assert {:ok, pid} = RecordingRunner.start()
    assert {"", 0} = RecordingRunner.cmd("shuttle", ["mark-runtime"], [])
    assert [{"shuttle", ["mark-runtime"], []}] = RecordingRunner.calls()

    monitor = Process.monitor(pid)
    assert :ok = stop_supervised(RecordingRunner)
    assert_receive {:DOWN, ^monitor, :process, ^pid, :shutdown}
    assert Process.whereis(RecordingRunner) == nil

    assert {:ok, next_pid} = RecordingRunner.start()
    refute next_pid == pid
    assert RecordingRunner.calls() == []
  end
end
