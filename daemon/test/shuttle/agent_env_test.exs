defmodule Shuttle.AgentEnvTest do
  use ExUnit.Case, async: true

  alias Shuttle.Agents
  import ExUnit.CaptureLog

  test "fresh and resume commands pass literal environment to shell-function workers" do
    value = "spaces ' quotes \" $HOME $(printf injected);\nnext line"

    for cli <- ["claude", "codex", "pi"] do
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
