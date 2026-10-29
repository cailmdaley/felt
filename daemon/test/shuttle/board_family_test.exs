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

    sessions = %{{"host", "session"} => "child", {"host", "recipient"} => "parent"}

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
end
