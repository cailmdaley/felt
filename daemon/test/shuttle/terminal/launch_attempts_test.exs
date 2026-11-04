defmodule Shuttle.Terminal.LaunchAttemptsTest do
  use ExUnit.Case, async: true
  alias Shuttle.Terminal.LaunchAttempts
  alias Shuttle.Test.Env
  @moduletag :tmp_dir

  setup %{tmp_dir: dir} do
    Env.put_env("SHUTTLE_DATA_DIR", dir)
    script = Path.join(dir, "shuttle-run-worker.42.sh")
    File.write!(script, "trap 'rm -f \"$0\"' EXIT\nexit 0\n")
    {:ok, script: script}
  end

  @tag :reservation_exit
  test "the run script's exit trap retires its reservation even without liveness probes", %{
    script: script,
    tmp_dir: dir
  } do
    assert :ok = LaunchAttempts.record("worker", script)
    assert LaunchAttempts.pending?("worker")
    assert {"", 0} = System.cmd("bash", [script])
    refute LaunchAttempts.pending?("worker")
    assert File.ls!(Path.join(dir, "terminals/launch-attempts")) == []
  end

  @tag :reservation_exit
  test "SIGKILL leaves the script and its reservation intact", %{script: script} do
    File.write!(script, "trap 'rm -f \"$0\"' EXIT\nprintf 'ready\\n'\nread -r _\n")
    assert :ok = LaunchAttempts.record("worker", script)

    port =
      Port.open({:spawn_executable, System.find_executable("bash")}, [
        :binary,
        :exit_status,
        args: [script]
      ])

    assert_receive {^port, {:data, "ready\n"}}, 2_000
    {:os_pid, pid} = Port.info(port, :os_pid)
    assert {"", 0} = System.cmd("/bin/kill", ["-KILL", Integer.to_string(pid)])
    assert_receive {^port, {:exit_status, 137}}, 2_000
    assert File.exists?(script)
    assert LaunchAttempts.pending?("worker")
  end
end
