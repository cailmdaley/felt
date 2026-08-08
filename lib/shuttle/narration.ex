defmodule Shuttle.Narration do
  @moduledoc """
  Commit narration for a civil-day range — the data layer behind
  `GET /api/v1/narration`.

  ## What it reads

  The daemon's **primary felt store** (`Shuttle.FeltStores.configured_hosts/0`,
  first entry — the same store the poller treats as primary) is a git repo, or
  sits inside one. `git log` there is the closest thing this system has to a
  narrated history: by convention every commit subject reads
  `<fiber-slug>: what happened`, so a day's subjects are a day's story. This
  module returns those subjects verbatim; parsing the convention is the
  reader's business, not ours.

  ## Civil days, local time

  `from`/`to` are civil dates and both ends are inclusive: the window runs from
  `from 00:00:00` to `to 23:59:59` in the **daemon's local timezone**, which is
  what a human means by "what happened Tuesday". `git log --since/--until`
  filter on committer date, and `%cI` renders that date in the committer's own
  offset, so the returned `iso` strings are directly comparable to the bounds a
  human typed.

  ## Never 500

  Every failure is the empty list: a store root that is not a git repo, a repo
  with no commits, a missing directory, a git binary that is not installed, a
  daemon with no configured store at all. The narration strip is decoration on
  a temporal view — it degrades to blank, it does not take the view down.
  """

  # ASCII unit separator: git subjects can contain anything printable, so the
  # date/subject delimiter has to be something a subject cannot.
  @separator "\x1f"

  @typedoc "One commit, in the wire shape the endpoint serves."
  @type commit :: %{iso: String.t(), subject: String.t()}

  @doc """
  Commits whose committer date falls in the inclusive civil-day range
  `from..to`, newest first (git's own order).

  Opts (for tests): `:store_root`, overriding the daemon's primary felt store.
  """
  @spec commits(Date.t(), Date.t(), keyword()) :: [commit()]
  def commits(%Date{} = from, %Date{} = to, opts \\ []) do
    case Keyword.get(opts, :store_root) || default_store_root() do
      root when is_binary(root) and root != "" -> git_log(Path.expand(root), from, to)
      _ -> []
    end
  end

  defp default_store_root do
    List.first(Shuttle.FeltStores.configured_hosts())
  rescue
    _ -> nil
  end

  # `git -C` discovers the enclosing repo itself, so a store that merely lives
  # *inside* a repo works with no extra probing. A non-repo (or missing) path
  # exits non-zero, which is the empty list.
  defp git_log(root, from, to) do
    args = [
      "-C",
      root,
      "log",
      "--since=#{Date.to_iso8601(from)} 00:00:00",
      "--until=#{Date.to_iso8601(to)} 23:59:59",
      "--pretty=format:%cI#{@separator}%s"
    ]

    # Fold stderr in rather than letting it reach the daemon's console: a store
    # that isn't a repo would otherwise print `fatal: not a git repository` on
    # every poll. Folded lines are harmless — `parse/1` keeps only lines
    # carrying the separator, and a non-zero status discards the output whole.
    case System.cmd("git", args, stderr_to_stdout: true) do
      {output, 0} -> parse(output)
      _ -> []
    end
  rescue
    # No git on PATH, or an unreadable cwd — System.cmd raises rather than
    # returning a status for those.
    _ -> []
  catch
    :exit, _ -> []
  end

  defp parse(output) do
    output
    |> String.split("\n", trim: true)
    |> Enum.flat_map(fn line ->
      case String.split(line, @separator, parts: 2) do
        [iso, subject] -> [%{iso: iso, subject: subject}]
        _ -> []
      end
    end)
  end
end
