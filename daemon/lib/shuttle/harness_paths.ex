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
      Path.join([Shuttle.Env.home(), ".claude", "projects"])
    end)
  end

  @doc "The pi sessions root, with test and operator overrides."
  @spec pi_sessions_root(keyword()) :: String.t()
  def pi_sessions_root(opts \\ []) do
    configured_path(opts, [:pi_root], "SHUTTLE_PI_SESSIONS_DIR", fn ->
      Path.join([Shuttle.Env.home(), ".pi", "agent", "sessions"])
    end)
  end

  @doc "The Codex sessions root, with test and operator overrides."
  @spec codex_sessions_root(keyword()) :: String.t()
  def codex_sessions_root(opts \\ []) do
    configured_path(opts, [:codex_root], "SHUTTLE_CODEX_SESSIONS_DIR", fn ->
      Path.join([Shuttle.Env.home(), ".codex", "sessions"])
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
  # Fresh capture searches yesterday / today / tomorrow in local time. For
  # recovery, :since extends that window back to the dispatch's UTC date minus
  # one day. Codex's local filing date can differ from UTC in either direction;
  # the padding also covers the capture timestamp's five-second grace across
  # midnight. Only this bounded date range is read, never the whole session tree.
  #
  # `SHUTTLE_CODEX_SESSIONS_DIR` overrides the ROOT (the `~/.codex/sessions`
  # equivalent); the YYYY/MM/DD fan-out applies to it too.
  @doc "Codex date directories, newest first; :since extends recovery back to dispatch, and :today pins the local civil date."
  @spec codex_session_dirs(keyword()) :: [String.t()]
  def codex_session_dirs(opts \\ []) do
    root = codex_sessions_root(opts)
    today = Keyword.get_lazy(opts, :today, &local_today/0)
    near_start = Date.add(today, -1)

    first =
      case Keyword.get(opts, :since) do
        %DateTime{} = since ->
          dispatch_start =
            since |> DateTime.shift_zone!("Etc/UTC") |> DateTime.to_date() |> Date.add(-1)

          if Date.before?(dispatch_start, near_start), do: dispatch_start, else: near_start

        nil ->
          near_start
      end

    Date.range(Date.add(today, 1), first, -1)
    |> Enum.map(fn date ->
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
      non_empty(Shuttle.Env.get(env_key)) || fallback.()
  end

  defp non_empty(value) when is_binary(value) and value != "", do: value
  defp non_empty(_), do: nil

  defp pad2(n) when n < 10, do: "0#{n}"
  defp pad2(n), do: "#{n}"
end
