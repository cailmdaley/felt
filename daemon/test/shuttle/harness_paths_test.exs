defmodule Shuttle.HarnessPathsTest do
  use ExUnit.Case, async: false

  alias Shuttle.HarnessPaths

  @env_keys ~w(
    SHUTTLE_CLAUDE_PROJECTS_DIR
    SHUTTLE_PI_SESSIONS_DIR
    SHUTTLE_CODEX_SESSIONS_DIR
  )

  setup do
    previous = Map.new(@env_keys, &{&1, System.get_env(&1)})
    Enum.each(@env_keys, &System.delete_env/1)

    on_exit(fn ->
      Enum.each(previous, fn {key, value} ->
        if value, do: System.put_env(key, value), else: System.delete_env(key)
      end)
    end)

    :ok
  end

  test "empty environment values do not erase the harness defaults" do
    System.put_env("SHUTTLE_CLAUDE_PROJECTS_DIR", "")
    System.put_env("SHUTTLE_PI_SESSIONS_DIR", "")
    System.put_env("SHUTTLE_CODEX_SESSIONS_DIR", "")

    assert HarnessPaths.claude_projects_root() ==
             Path.join([System.user_home!(), ".claude", "projects"])

    assert HarnessPaths.pi_sessions_root() ==
             Path.join([System.user_home!(), ".pi", "agent", "sessions"])

    assert HarnessPaths.codex_sessions_root() ==
             Path.join([System.user_home!(), ".codex", "sessions"])
  end

  test "non-empty environment and options override the defaults" do
    System.put_env("SHUTTLE_CLAUDE_PROJECTS_DIR", "/env/claude")
    System.put_env("SHUTTLE_PI_SESSIONS_DIR", "/env/pi")
    System.put_env("SHUTTLE_CODEX_SESSIONS_DIR", "/env/codex")

    assert HarnessPaths.claude_projects_root() == "/env/claude"
    assert HarnessPaths.pi_sessions_root() == "/env/pi"
    assert HarnessPaths.codex_sessions_root() == "/env/codex"

    assert HarnessPaths.claude_projects_root(root: "/option/claude") == "/option/claude"
    assert HarnessPaths.pi_sessions_root(pi_root: "/option/pi") == "/option/pi"
    assert HarnessPaths.codex_sessions_root(codex_root: "/option/codex") == "/option/codex"
  end

  test "an explicitly empty option falls through to the environment" do
    System.put_env("SHUTTLE_CLAUDE_PROJECTS_DIR", "/env/claude")
    System.put_env("SHUTTLE_PI_SESSIONS_DIR", "/env/pi")
    System.put_env("SHUTTLE_CODEX_SESSIONS_DIR", "/env/codex")

    assert HarnessPaths.claude_projects_root(root: "") == "/env/claude"
    assert HarnessPaths.pi_sessions_root(pi_root: "") == "/env/pi"
    assert HarnessPaths.codex_sessions_root(codex_root: "") == "/env/codex"
  end
end
