defmodule Shuttle.HarnessPaths do
  @moduledoc """
  Filesystem locations shared by the harness readers and dispatcher.

  Harnesses own these trees, so Shuttle only reads them. Keeping the layouts in
  one module matters because a session can be captured successfully by the
  dispatcher and still be invisible to the temporal views if the two paths
  drift.
  """

  @doc "The Claude Code projects root, with test and operator overrides."
  @spec claude_projects_root(keyword()) :: String.t()
  def claude_projects_root(opts \\ []) do
    configured_path(opts, [:claude_root, :root], "SHUTTLE_CLAUDE_PROJECTS_DIR", fn ->
      Path.join([System.user_home!(), ".claude", "projects"])
    end)
  end

  @doc "The pi sessions root, with test and operator overrides."
  @spec pi_sessions_root(keyword()) :: String.t()
  def pi_sessions_root(opts \\ []) do
    configured_path(opts, [:pi_root], "SHUTTLE_PI_SESSIONS_DIR", fn ->
      Path.join([System.user_home!(), ".pi", "agent", "sessions"])
    end)
  end

  @doc "The Codex sessions root, with test and operator overrides."
  @spec codex_sessions_root(keyword()) :: String.t()
  def codex_sessions_root(opts \\ []) do
    configured_path(opts, [:codex_root], "SHUTTLE_CODEX_SESSIONS_DIR", fn ->
      Path.join([System.user_home!(), ".codex", "sessions"])
    end)
  end

  # Codex files a rollout under the LOCAL civil day, not the UTC one. Verified
  # on disk: ~/.codex/sessions/2026/07/22/rollout-2026-07-22T17-41-02-*.jsonl
  # whose first line carries "timestamp":"2026-07-22T15:41:03.435Z" — 17:41
  # Paris, filed under the Paris date. Deriving this path from
  # `Date.utc_today()` therefore names a directory that does not exist for
  # every dispatch made west of UTC late in the day (at UTC-7: 17:00–23:59
  # local), and the capture burns its whole retry budget for nothing — the
  # worker runs, its session_uuid is lost, and it cannot be resumed.
  #
  # One day is also not enough on its own: the dispatch and the transcript
  # write can straddle local midnight in either direction. So search
  # yesterday / today / tomorrow in local time and take the newest matching
  # transcript across all three. That window also absorbs a stale zone read —
  # the BEAM resolves the local zone through libc, which on some platforms
  # holds the value captured when the OS process started, and no zone on earth
  # is more than one civil day from another.
  #
  # `SHUTTLE_CODEX_SESSIONS_DIR` overrides the ROOT (the `~/.codex/sessions`
  # equivalent); the YYYY/MM/DD fan-out applies to it too.
  @doc "The three local-civil-day directories used while capturing a new rollout."
  @spec codex_session_dirs(keyword()) :: [String.t()]
  def codex_session_dirs(opts \\ []) do
    root = codex_sessions_root(opts)
    today = local_today()

    Enum.map([1, 0, -1], fn offset ->
      date = Date.add(today, offset)
      Path.join([root, "#{date.year}", pad2(date.month), pad2(date.day)])
    end)
  end

  @doc "A bounded date-tree glob for one Codex rollout, regardless of its age."
  @spec codex_session_glob(String.t(), keyword()) :: String.t()
  def codex_session_glob(session, opts \\ []) when is_binary(session) do
    Path.join(codex_sessions_root(opts), "*/*/*/rollout-*#{session}.jsonl")
  end

  # The absolute path with every "/" replaced by "-", bracketed by "--" — e.g.
  # /home/user/loom → --home-user-loom--. The LEADING slash becomes a dash too,
  # so the munge of /a/b starts with three dashes before the bracket is added;
  # trimming it first is what keeps the encoding two-dash-fronted like pi's own
  # directories. This encoding was once wrong in exactly that leading slash,
  # and every pi dispatch's session capture timed out.
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

  defp configured_path(opts, option_keys, env_key, fallback) do
    Enum.find_value(option_keys, fn key -> non_empty(Keyword.get(opts, key)) end) ||
      non_empty(System.get_env(env_key)) || fallback.()
  end

  defp non_empty(value) when is_binary(value) and value != "", do: value
  defp non_empty(_), do: nil

  defp pad2(n) when n < 10, do: "0#{n}"
  defp pad2(n), do: "#{n}"
end
