defmodule Shuttle.ThreadMarksTest do
  use ExUnit.Case, async: true

  alias Shuttle.ThreadMarks

  defp session(uid, kind, at, extra \\ %{}),
    do:
      Map.merge(
        %{"uid" => uid, "kind" => kind, "at" => at, "host" => "a", "session" => "s-#{uid}"},
        extra
      )

  test "a burst of resumes on one host is a restart; dispatches and lone resumes mark" do
    t = 1_000_000_020_000

    marks =
      ThreadMarks.compose(
        [
          session("a", "dispatch", t - 600_000),
          session("a", "resume", t),
          session("b", "resume", t + 1000),
          session("c", "resume", t + 2000),
          session("b", "resume", t + 3_600_000)
        ],
        [],
        "a"
      )

    assert marks["a"].launches == [t - 600_000]
    assert marks["b"].launches == [t + 3_600_000]
    refute Map.has_key?(marks, "c")
  end

  test "resumes on different hosts are not one burst" do
    t = 1_000_000_020_000

    marks =
      ThreadMarks.compose(
        [
          session("a", "resume", t),
          session("b", "resume", t + 1000, %{"host" => "b"}),
          session("c", "resume", t + 2000, %{"host" => "c"})
        ],
        [],
        "a"
      )

    assert Enum.map(~w(a b c), &marks[&1].launches) == [[t], [t + 1000], [t + 2000]]
  end

  test "a commit joins by host and session, once per sha" do
    sessions = [session("a", "dispatch", 1)]

    commits = [
      %{"at" => 2, "host" => "a", "session" => "s-a", "sha" => "x"},
      %{"at" => 2, "host" => "a", "session" => "s-a", "sha" => "x"},
      %{"at" => 3, "host" => "other", "session" => "s-a", "sha" => "y"},
      %{"at" => 4, "host" => "a", "session" => "unpaired", "sha" => "z"}
    ]

    assert ThreadMarks.compose(sessions, commits, "a") == %{
             "a" => %{launches: [1], commits: [2]}
           }
  end

  test "on this host a commit from the session's successor finds its thread" do
    now = System.system_time(:millisecond)

    event = fn id, type, at ->
      %{
        "sessionId" => id,
        "type" => type,
        "timestamp" => at,
        "receiverPid" => 1,
        "receiverBirth" => "birth",
        "harness" => "claude-code"
      }
    end

    bindings =
      [event.("old", "pre_tool_use", now - 2000), event.("new", "session_start", now - 1000)]
      |> Enum.reduce(
        Shuttle.SessionBinding.new(),
        &Shuttle.SessionBinding.apply_event(&2, &1, now)
      )

    sessions = [session("a", "dispatch", 1, %{"session" => "old"})]
    commit = %{"at" => 5, "host" => "a", "session" => "new", "sha" => "x"}

    assert ThreadMarks.compose(sessions, [commit], "a", bindings)["a"].commits == [5]
    # Succession is this host's evidence; another host's pairing joins by its own id only.
    assert ThreadMarks.compose(sessions, [commit], "b", bindings)["a"].commits == []
  end
end
