defmodule Shuttle.RunnerTest do
  use ExUnit.Case, async: false

  test "default runner clears inherited TMUX for tmux commands" do
    tmp_dir =
      Path.join(System.tmp_dir!(), "shuttle-runner-test-#{System.unique_integer([:positive])}")

    File.mkdir_p!(tmp_dir)
    env_path = Path.join(tmp_dir, "tmux-env")
    fake_tmux = Path.join(tmp_dir, "tmux")

    File.write!(fake_tmux, """
    #!/usr/bin/env bash
    printf '%s' "$TMUX" > #{env_path}
    """)

    File.chmod!(fake_tmux, 0o755)

    previous_path = System.get_env("PATH")
    previous_tmux = System.get_env("TMUX")

    System.put_env("PATH", "#{tmp_dir}:#{previous_path}")
    System.put_env("TMUX", "/private/tmp/tmux-test/private,1,0")

    on_exit(fn ->
      if previous_path, do: System.put_env("PATH", previous_path), else: System.delete_env("PATH")
      if previous_tmux, do: System.put_env("TMUX", previous_tmux), else: System.delete_env("TMUX")
      File.rm_rf!(tmp_dir)
    end)

    assert {"", 0} = Shuttle.Runner.Default.cmd("tmux", ["ls"], stderr_to_stdout: true)
    assert File.read!(env_path) == ""
  end
end
