defmodule Shuttle.BoardFamilyTest do
  use ExUnit.Case, async: true
  alias Shuttle.BoardFamily

  defp entry(id, uid) do
    %{
      felt_store: "/store",
      fiber: %{
        "id" => id,
        "slug" => id,
        "uid" => uid,
        "name" => uid,
        "shuttle" => %{"host" => "host"}
      }
    }
  end

  test "nested and moved threads resolve at read time, with delivery and session attribution" do
    entries = [
      entry("work/hub", "root"),
      entry("work/hub/parent", "parent"),
      entry("work/hub/parent/child", "child"),
      entry("work/other", "other")
    ]

    sessions = %{{"host", "pi", "session"} => "child", {"host", "pi", "recipient"} => "parent"}

    records = [
      %{
        "id" => "1",
        "timestamp" => 1,
        "kind" => "message",
        "by" => %{"session" => "shuttle://host/pi/session"},
        "to" => %{"session" => "shuttle://host/pi/recipient"}
      },
      %{"id" => "2", "timestamp" => 2, "kind" => "asked", "fiber" => "child"},
      %{
        "id" => "3",
        "timestamp" => 3,
        "kind" => "answered",
        "fiber" => "child",
        "by" => %{"label" => "Cail"}
      },
      %{"id" => "4", "timestamp" => 4, "kind" => "post", "fiber" => "other"},
      %{"id" => "2", "timestamp" => 2, "kind" => "asked", "fiber" => "child"}
    ]

    result =
      BoardFamily.compose(entries, records, sessions, "host", %{"session" => "pi:recipient"})

    assert result.family == %{root_uid: "root", root_id: "work/hub", name: "root", label: "hub"}
    assert result.viewer == "parent"
    assert [message, ask, answer] = result.records
    assert message["fiber"] == "parent"
    assert message["by"]["fiber"] == "child"
    assert message["to"]["fiber"] == "parent"
    assert message["member"] == "hub/parent"
    assert message["to_member"] == "hub/parent"
    assert message["actor"] == "hub/parent/child"
    assert message["delivered"]
    assert ask["member"] == "hub/parent/child"
    assert ask["delivered"]
    refute answer["delivered"]
    assert answer["actor"] == "Cail"

    moved = [
      entry("work/hub", "root"),
      entry("work/hub/parent", "parent"),
      entry("work/other/child", "child"),
      entry("work/other", "other")
    ]

    assert Enum.map(
             BoardFamily.compose(moved, records, sessions, "host", %{"fiber" => "parent"}).records,
             & &1["id"]
           ) == ["1"]

    assert BoardFamily.compose(entries, records, sessions, "host", %{"session" => "pi:unknown"}) ==
             %{family: nil, viewer: nil, records: []}

    assert length(
             BoardFamily.compose(entries, records, sessions, "host", %{"all" => "true"}).records
           ) == 4
  end

  test "session index uses runtime and ledger harness identities without conflating them" do
    dir = Path.join(System.tmp_dir!(), "board-sessions-#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)
    on_exit(fn -> File.rm_rf(dir) end)
    Shuttle.Test.Env.put_env("SHUTTLE_DATA_DIR", dir)
    Shuttle.Test.Env.put_env("SHUTTLE_SESSIONS_FILE", Path.join(dir, "sessions.jsonl"))

    record = %{
      "session" => "ledger-session",
      "fiber" => "hub/child",
      "uid" => "child",
      "host" => "host",
      "harness" => "pi",
      "at" => 1
    }

    File.write!(Path.join(dir, "sessions.jsonl"), Jason.encode!(record) <> "\n")
    child = entry("hub/child", "child")

    child =
      put_in(child.fiber["shuttle"], %{
        "host" => "host",
        "runtime" => %{"session_uuid" => "runtime-session"},
        "resolved" => %{"agent" => %{"cli" => "codex"}}
      })

    now = System.system_time(:millisecond)

    start = %{
      "type" => "session_start",
      "sessionId" => "runtime-session",
      "harness" => "codex",
      "receiverPid" => 42,
      "receiverBirth" => "birth",
      "timestamp" => now
    }

    successor = %{start | "sessionId" => "successor", "timestamp" => now + 1}

    bindings =
      Shuttle.SessionBinding.new()
      |> Shuttle.SessionBinding.apply_event(start, now)
      |> Shuttle.SessionBinding.apply_event(successor, now)

    sessions = BoardFamily.session_index([child], "host", bindings)
    refute Map.has_key?(sessions, {"host", "codex", "successor"})
    assert sessions[{"host", "codex", "runtime-session"}] == "child"
    assert sessions[{"host", "pi", "ledger-session"}] == "child"
    refute Map.has_key?(sessions, {"host", "claude", "ledger-session"})
  end

  test "viewer subject, actor and recipient are delivered except an externally cleared question" do
    entries = [entry("hub", "root"), entry("hub/child", "child")]

    records = [
      %{
        "id" => "1",
        "timestamp" => 1,
        "kind" => "human",
        "fiber" => "child",
        "by" => %{"label" => "human"}
      },
      %{
        "id" => "2",
        "timestamp" => 2,
        "kind" => "answered",
        "fiber" => "child",
        "by" => %{"label" => "human"}
      },
      %{
        "id" => "3",
        "timestamp" => 3,
        "kind" => "cleared",
        "fiber" => "child",
        "by" => %{"fiber" => "root"},
        "to" => %{"fiber" => "child"}
      },
      %{
        "id" => "4",
        "timestamp" => 4,
        "kind" => "cleared",
        "fiber" => "child",
        "by" => %{"fiber" => "child"}
      },
      %{
        "id" => "5",
        "timestamp" => 5,
        "kind" => "post",
        "fiber" => "root",
        "to" => %{"fiber" => "child"}
      }
    ]

    result = BoardFamily.compose(entries, records, %{}, "host", %{"fiber" => "child"})
    assert Enum.map(result.records, & &1["delivered"]) == [true, true, false, true, true]
  end

  test "actor and delivery distinguish authors, replies and outbox lifecycle" do
    entries = [entry("hub", "root"), entry("hub/child", "child")]

    rows =
      for {kind, id} <-
            Enum.with_index(
              ~w(asked closed handed_off rested unblocked answered cleared human),
              1
            ),
          do: %{"id" => "#{id}", "timestamp" => id, "kind" => kind, "fiber" => "child"}

    rows =
      rows ++
        [
          %{
            "id" => "9",
            "timestamp" => 9,
            "kind" => "post",
            "fiber" => "child",
            "by" => %{"fiber" => "root"}
          }
        ]

    result = BoardFamily.compose(entries, rows, %{}, "host", %{"fiber" => "root"})

    assert Enum.map(result.records, & &1["delivered"]) == [
             true,
             true,
             true,
             true,
             true,
             false,
             false,
             false,
             true
           ]
  end

  describe "waiting" do
    defp line(id, ts, kind, fiber, to, extra \\ %{}),
      do:
        Map.merge(
          %{"id" => id, "timestamp" => ts, "kind" => kind, "fiber" => fiber, "to" => to},
          extra
        )

    @cail %{"label" => "Cail"}
    @chair %{"fiber" => "chair"}

    test "a line addressed to the human waits until something handles it" do
      assert BoardFamily.waiting([line("1", 1, "post", "t", @cail)]) == %{
               "t" => %{"id" => "1", "at" => 1}
             }

      assert BoardFamily.waiting([line("1", 1, "asked", "t", @cail)]) == %{
               "t" => %{"id" => "1", "at" => 1}
             }

      assert BoardFamily.waiting([line("1", 1, "closed", "t", @cail)]) == %{
               "t" => %{"id" => "1", "at" => 1}
             }

      for kind <- ~w(human answered cleared rested run_tempered) do
        assert BoardFamily.waiting([
                 line("1", 1, "post", "t", @cail),
                 line("2", 2, kind, "t", nil)
               ]) == %{}
      end

      # Something handled before the line does not handle it.
      assert map_size(
               BoardFamily.waiting([
                 line("0", 0, "human", "t", nil),
                 line("1", 1, "post", "t", @cail)
               ])
             ) == 1
    end

    test "a newer line supersedes the last, whoever it is addressed to" do
      assert BoardFamily.waiting([
               line("1", 1, "asked", "t", @cail),
               line("2", 2, "post", "t", @chair)
             ]) == %{}

      assert BoardFamily.waiting([
               line("1", 1, "post", "t", @cail),
               line("2", 2, "post", "t", nil)
             ]) == %{}

      assert BoardFamily.waiting([
               line("1", 1, "post", "t", @chair),
               line("2", 2, "post", "t", @cail)
             ]) ==
               %{"t" => %{"id" => "2", "at" => 2}}

      # A verdict closes the line.
      assert BoardFamily.waiting([
               line("1", 1, "closed", "t", @cail),
               line("2", 2, "closed", "t", nil, %{"verdict" => "tempered"})
             ]) == %{}
    end

    test "only a person is the human: a fiber, a session or no address waits on no one" do
      for to <- [
            @chair,
            %{"session" => "shuttle://h/claude/s"},
            %{"label" => "Cail", "fiber" => "x"},
            nil
          ] do
        assert BoardFamily.waiting([line("1", 1, "post", "t", to)]) == %{}
      end
    end

    test "the human's clear reaches a line up to its time, unless undone since" do
      clear = &%{"id" => &1, "timestamp" => 9, "kind" => "dismissed", "text" => &2}
      post = line("1", 5, "post", "t", @cail)
      assert BoardFamily.waiting([post, clear.("c", "clear:t:5")]) == %{}
      assert map_size(BoardFamily.waiting([post, clear.("c", "clear:t:4")])) == 1

      assert map_size(
               BoardFamily.waiting([post, clear.("c", "clear:t:5"), clear.("u", "unclear:t:6")])
             ) == 1

      assert BoardFamily.waiting([
               post,
               clear.("c", "clear:t:5"),
               clear.("u", "unclear:t:6"),
               clear.("d", "clear:t:7")
             ]) == %{}

      assert map_size(BoardFamily.waiting([post, clear.("c", "clear:other:5")])) == 1
    end

    test "a legacy line with no address waits on no one" do
      assert BoardFamily.waiting([
               %{"id" => "1", "timestamp" => 1, "kind" => "asked", "fiber" => "t"}
             ]) == %{}
    end
  end
end
