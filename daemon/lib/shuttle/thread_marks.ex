defmodule Shuttle.ThreadMarks do
  @moduledoc """
  Each thread's launches and commits over the board's reach, keyed by fiber uid.

  A launch is a session-ledger pairing (dispatch, claim, resume, migrate). A
  burst of three or more resumes on one host within one two-minute bucket is that
  host's daemon coming back and reopening its workers, so it marks nothing.

  A commit joins its thread by one key, `{host, session}`: the host that
  recorded the commit and the harness session that made it, looked up among the
  session ledger's pairings. On this host a pairing also answers for its
  session's current successor (`Shuttle.SessionBinding`), so a commit made after
  a receiver resumed the conversation under a new id still finds its thread.
  """

  alias Shuttle.SessionBinding

  @burst_ms 120_000
  @burst_size 3

  @type marks :: %{String.t() => %{launches: [integer()], commits: [integer()]}}

  @doc """
  Fold session-ledger records and commit-ledger records (each carrying its
  `host`) into per-thread marks, oldest first. A commit served twice (one sha)
  counts once.
  """
  @spec compose([map()], [map()], String.t(), map()) :: marks()
  def compose(sessions, commits, own_host, bindings \\ SessionBinding.new()) do
    bursts =
      sessions
      |> Enum.filter(&(&1["kind"] == "resume"))
      |> Enum.frequencies_by(&bucket/1)

    paired = Enum.filter(sessions, &uid/1)

    owners =
      Enum.reduce(paired, %{}, fn row, acc ->
        session = row["session"]
        host = row["host"]
        acc = Map.put(acc, {host, session}, row["uid"])

        if host == own_host,
          do: Map.put(acc, {host, SessionBinding.current(bindings, session)}, row["uid"]),
          else: acc
      end)

    launched =
      paired
      |> Enum.reject(&(&1["kind"] == "resume" and Map.get(bursts, bucket(&1), 0) >= @burst_size))
      |> Enum.group_by(& &1["uid"], & &1["at"])

    committed =
      commits
      |> Enum.uniq_by(& &1["sha"])
      |> Enum.flat_map(fn row ->
        case Map.get(owners, {row["host"], row["session"]}) do
          nil -> []
          uid -> [{uid, row["at"]}]
        end
      end)
      |> Enum.group_by(&elem(&1, 0), &elem(&1, 1))

    Map.new(Enum.uniq(Map.keys(launched) ++ Map.keys(committed)), fn uid ->
      {uid,
       %{
         launches: Enum.sort(Map.get(launched, uid, [])),
         commits: Enum.sort(Map.get(committed, uid, []))
       }}
    end)
  end

  defp uid(%{"uid" => uid}) when is_binary(uid) and uid != "", do: uid
  defp uid(_), do: nil

  defp bucket(row), do: {row["host"], div(row["at"], @burst_ms)}
end
