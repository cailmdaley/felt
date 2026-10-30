defmodule Shuttle.OperatorFilesGuardTest do
  @moduledoc """
  The suite's defaults keep every operator file off the developer's real home:
  a test that sets nothing of its own must never read (or write)
  `~/.config/shuttle/*` or walk the stores registered there.
  """
  use ExUnit.Case, async: true

  @repo Path.expand("../../..", __DIR__)

  test "every operator file and the data dir resolve outside the real home by default" do
    home = System.user_home!()

    # Read from a process outside every test scope: the suite-wide pins alone.
    task = fn ->
      [
        {:data_dir, Shuttle.data_dir()},
        {:claude_tasks, Shuttle.HarnessPaths.claude_tasks_root()}
        | for(id <- Shuttle.ConfigFiles.ids(), do: {id, Shuttle.ConfigFiles.path(id)})
      ]
    end

    parent = self()
    spawn(fn -> send(parent, {:paths, task.()}) end)
    assert_receive {:paths, paths}

    # Fixtures in this checkout are fine wherever the checkout lives.
    under_home =
      for {id, path} <- paths,
          path = Path.expand(path),
          String.starts_with?(path, home <> "/"),
          not String.starts_with?(path, @repo <> "/"),
          do: {id, path}

    assert under_home == [], "operator files under the real home: #{inspect(under_home)}"
  end
  @tag skip: is_nil(System.find_executable("tmux"))
  test "a real named tmux server lives in the suite namespace" do
    server = "namespace-#{System.unique_integer([:positive])}"
    command = fn args -> Shuttle.Env.cmd("tmux", ["-f", "/dev/null", "-L", server | args], stderr_to_stdout: true) end
    on_exit(fn -> command.(["kill-server"]) end)
    assert {_, 0} = command.(["new-session", "-d", "-s", "sentinel", "sleep", "300"])
    assert {socket, 0} = command.(["display-message", "-p", "\#{socket_path}"])
    namespace = socket |> String.trim() |> Path.dirname() |> Path.dirname() |> File.stat!()
    suite = File.stat!(System.tmp_dir!())
    assert {namespace.inode, namespace.major_device} == {suite.inode, suite.major_device}
    assert System.get_env("TMUX") == nil
  end

end
