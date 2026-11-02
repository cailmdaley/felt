defmodule Shuttle.AgentEnvTest do
  use ExUnit.Case, async: true

  alias Shuttle.Agents
  import ExUnit.CaptureLog

  @tag :tmp_dir
  test "Codex bypasses a sourced function and drops tmux variables on fresh and resumed starts",
       %{tmp_dir: dir} do
    bin = Path.join(dir, "bin")
    File.mkdir_p!(bin)

    codex = Path.join(bin, "codex")
    args_file = Path.join(dir, "args")
    env_file = Path.join(dir, "env")
    function_marker = Path.join(dir, "function-ran")
    profile = Path.join(dir, "login-functions.sh")

    File.write!(
      codex,
      "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$CODEX_ARGS_FILE\"\n" <>
        "printf '%s\\n' \"${TMUX-unset}\" \"${TMUX_PANE-unset}\" > \"$CODEX_ENV_FILE\"\n"
    )

    File.chmod!(codex, 0o755)
    File.write!(profile, "codex() { printf function > \"$CODEX_FUNCTION_MARKER\"; }\n")

    agent =
      Agents.from_resolved(%{
        "id" => "codex-test",
        "cli" => "codex",
        "wrapper" => "codex",
        "model" => "gpt-6.1-sol",
        "developer_instructions" => "Use only the requested checkout."
      })

    commands = [
      {Agents.build_command(agent, "fresh prompt"), ["fresh prompt"]},
      {Agents.build_resume_command(agent, "exact-session", "resume prompt"),
       ["resume", "exact-session", "resume prompt"]}
    ]

    for {command, expected_args} <- commands do
      assert String.starts_with?(command, "env -u TMUX -u TMUX_PANE codex ")

      script = "source #{profile}\n" <> command

      assert {_, 0} =
               System.cmd("bash", ["-c", script],
                 env: [
                   {"PATH", bin <> ":" <> System.get_env("PATH")},
                   {"TMUX", "/tmp/stale-tmux,123,0"},
                   {"TMUX_PANE", "%42"},
                   {"CODEX_ARGS_FILE", args_file},
                   {"CODEX_ENV_FILE", env_file},
                   {"CODEX_FUNCTION_MARKER", function_marker}
                 ]
               )

      args = File.read!(args_file) |> String.split("\n", trim: true)
      assert "--model" in args
      assert "gpt-6.1-sol" in args
      assert "-c" in args
      assert ~s(developer_instructions="Use only the requested checkout.") in args
      assert Enum.all?(expected_args, &(&1 in args))
      assert File.read!(env_file) == "unset\nunset\n"
      refute File.exists?(function_marker)
    end
  end

  test "fresh and resume commands pass literal environment to Claude and Pi shell functions" do
    value = "spaces ' quotes \" $HOME $(printf injected);\nnext line"

    for cli <- ["claude", "pi"] do
      agent =
        Agents.from_resolved(%{
          "id" => "custom",
          "cli" => cli,
          "wrapper" => "worker",
          "env" => %{
            "WORKER_VALUE" => value,
            "WORKER_EMPTY" => "",
            "CLAUDE_CODE_PROMPT_CACHE_TTL" => "5m"
          }
        })

      for command <- [
            Agents.build_command(agent, "hello"),
            Agents.build_resume_command(agent, "session-id", "hello")
          ] do
        # A shell function models the login-profile wrappers used by tmux workers.
        script =
          "worker() { bash -c 'printf \"%s\\n%s\\n%s\" \"$CLAUDE_CODE_PROMPT_CACHE_TTL\" \"$WORKER_EMPTY\" \"$WORKER_VALUE\"'; }; " <>
            command

        assert {"5m\n\n" <> ^value, 0} = System.cmd("bash", ["-c", script])
      end
    end
  end

  test "invalid env entries are skipped with warnings on fresh and resumed launches" do
    agent =
      Agents.from_resolved(%{
        "id" => "custom",
        "cli" => "pi",
        "wrapper" => "worker",
        "env" => %{
          "GOOD_1" => "literal value",
          "BAD; printf injected" => "value",
          "TRAILING_NEWLINE\n" => "value",
          "NUMBER" => 42,
          "NULL" => nil,
          "NUL" => <<0>>,
          :atom_key => "value"
        }
      })

    log =
      capture_log(fn ->
        for command <- [
              Agents.build_command(agent, "hello"),
              Agents.build_resume_command(agent, "session-id", "hello")
            ] do
          assert String.starts_with?(command, "GOOD_1='literal value' worker ")
          refute command =~ "injected"
          refute command =~ "NUMBER="
          refute command =~ "NULL="
          refute command =~ "NUL="
          refute command =~ "atom_key="
          refute command =~ "TRAILING_NEWLINE"
        end
      end)

    for key <- [
          "BAD; printf injected",
          "TRAILING_NEWLINE\\n",
          "NUMBER",
          "NULL",
          "NUL",
          "atom_key"
        ] do
      assert log =~ key
    end

    assert log =~ "Skipping invalid agent env entry"
  end

  test "an omitted env leaves the command unchanged" do
    agent = Agents.from_resolved(%{"id" => "pi", "cli" => "pi", "wrapper" => "pi"})
    assert agent.env == %{}
    assert Agents.build_command(agent, "hello") == "pi  'hello'"
  end
end
