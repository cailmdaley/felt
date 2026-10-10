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

  test "Codex recovery bounds the date tree by dispatch with civil-day padding" do
    since = ~U[2025-12-30 00:00:00Z]

    assert HarnessPaths.codex_session_dirs(
             codex_root: "/codex",
             since: since,
             today: ~D[2026-01-03]
           ) == [
             "/codex/2026/01/04",
             "/codex/2026/01/03",
             "/codex/2026/01/02",
             "/codex/2026/01/01",
             "/codex/2025/12/31",
             "/codex/2025/12/30",
             "/codex/2025/12/29"
           ]
  end

  test "Codex recovery preserves near-date searches for recent or future dispatches" do
    for since <- [~U[2026-01-03 23:59:59Z], ~U[2026-01-05 00:00:00Z]] do
      assert HarnessPaths.codex_session_dirs(
               codex_root: "/codex",
               since: since,
               today: ~D[2026-01-03]
             ) == [
               "/codex/2026/01/04",
               "/codex/2026/01/03",
               "/codex/2026/01/02"
             ]
    end
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
