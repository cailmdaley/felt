defmodule Shuttle.HarnessPaths do
  @moduledoc """
  Filesystem locations shared by the harness readers and dispatcher.

  Harnesses own these trees, so Shuttle only reads them. Keeping the layouts in
  one module matters because a session can be captured successfully by the
  dispatcher and still be invisible to the temporal views if the two paths
  drift.
  """

  @codex_session_day_offsets [1, 0, -1]

  @doc "The Claude Code projects root, with test and operator overrides."
  @spec claude_projects_root(keyword()) :: String.t()
  def claude_projects_root(opts \\ []) do
    Keyword.get(opts, :claude_root) || Keyword.get(opts, :root) ||
      System.get_env("SHUTTLE_CLAUDE_PROJECTS_DIR") ||
      Path.join([System.user_home!() || "/root", ".claude", "projects"])
  end

  @doc "The pi sessions root, with test and operator overrides."
  @spec pi_sessions_root(keyword()) :: String.t()
  def pi_sessions_root(opts \\ []) do
    Keyword.get(opts, :pi_root) ||
      System.get_env("SHUTTLE_PI_SESSIONS_DIR") ||
      Path.join([System.user_home!() || "/root", ".pi", "agent", "sessions"])
  end

  @doc "The Codex sessions root, with test and operator overrides."
  @spec codex_sessions_root(keyword()) :: String.t()
  def codex_sessions_root(opts \\ []) do
    Keyword.get(opts, :codex_root) ||
      System.get_env("SHUTTLE_CODEX_SESSIONS_DIR") ||
      Path.join([System.user_home!(), ".codex", "sessions"])
  end

  @doc "The three local-civil-day directories in which Codex may file a rollout."
  @spec codex_session_dirs(keyword()) :: [String.t()]
  def codex_session_dirs(opts \\ []) do
    root = codex_sessions_root(opts)
    today = local_today()

    Enum.map(@codex_session_day_offsets, fn offset ->
      date = Date.add(today, offset)
      Path.join([root, "#{date.year}", pad2(date.month), pad2(date.day)])
    end)
  end

  @doc "The pi directory for a working directory's encoded session files."
  @spec pi_sessions_dir(String.t(), keyword()) :: String.t()
  def pi_sessions_dir(work_dir, opts \\ []) when is_binary(work_dir) do
    encoded = "--" <> (work_dir |> String.trim_leading("/") |> String.replace("/", "-")) <> "--"
    Path.join(pi_sessions_root(opts), encoded)
  end

  @doc "The local civil date used by Codex's YYYY/MM/DD fan-out."
  @spec local_today() :: Date.t()
  def local_today do
    {{year, month, day}, _time} = :calendar.local_time()
    Date.new!(year, month, day)
  end

  defp pad2(n) when n < 10, do: "0#{n}"
  defp pad2(n), do: "#{n}"
end
