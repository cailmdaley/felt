defmodule Shuttle.HarnessPathsTest do
  use ExUnit.Case, async: true

  alias Shuttle.HarnessPaths

  @env_keys ~w(
    SHUTTLE_CLAUDE_PROJECTS_DIR
    SHUTTLE_PI_SESSIONS_DIR
    SHUTTLE_CODEX_SESSIONS_DIR
  )

  setup do
    Enum.each(@env_keys, &Shuttle.Test.Env.delete_env/1)

    :ok
  end

  test "empty environment values do not erase the harness defaults" do
    Shuttle.Test.Env.put_env("SHUTTLE_CLAUDE_PROJECTS_DIR", "")
    Shuttle.Test.Env.put_env("SHUTTLE_PI_SESSIONS_DIR", "")
    Shuttle.Test.Env.put_env("SHUTTLE_CODEX_SESSIONS_DIR", "")

    assert HarnessPaths.claude_projects_root() ==
             Path.join([System.user_home!(), ".claude", "projects"])

    assert HarnessPaths.pi_sessions_root() ==
             Path.join([System.user_home!(), ".pi", "agent", "sessions"])

    assert HarnessPaths.codex_sessions_root() ==
             Path.join([System.user_home!(), ".codex", "sessions"])
  end

  test "non-empty environment and options override the defaults" do
    Shuttle.Test.Env.put_env("SHUTTLE_CLAUDE_PROJECTS_DIR", "/env/claude")
    Shuttle.Test.Env.put_env("SHUTTLE_PI_SESSIONS_DIR", "/env/pi")
    Shuttle.Test.Env.put_env("SHUTTLE_CODEX_SESSIONS_DIR", "/env/codex")

    assert HarnessPaths.claude_projects_root() == "/env/claude"
    assert HarnessPaths.pi_sessions_root() == "/env/pi"
    assert HarnessPaths.codex_sessions_root() == "/env/codex"

    assert HarnessPaths.claude_projects_root(root: "/option/claude") == "/option/claude"
    assert HarnessPaths.pi_sessions_root(pi_root: "/option/pi") == "/option/pi"
    assert HarnessPaths.codex_sessions_root(codex_root: "/option/codex") == "/option/codex"
  end

  test "an explicitly empty option falls through to the environment" do
    Shuttle.Test.Env.put_env("SHUTTLE_CLAUDE_PROJECTS_DIR", "/env/claude")
    Shuttle.Test.Env.put_env("SHUTTLE_PI_SESSIONS_DIR", "/env/pi")
    Shuttle.Test.Env.put_env("SHUTTLE_CODEX_SESSIONS_DIR", "/env/codex")

    assert HarnessPaths.claude_projects_root(root: "") == "/env/claude"
    assert HarnessPaths.pi_sessions_root(pi_root: "") == "/env/pi"
    assert HarnessPaths.codex_sessions_root(codex_root: "") == "/env/codex"
  end
end
