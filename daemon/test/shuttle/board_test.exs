defmodule Shuttle.BoardTest do
  use ExUnit.Case, async: true

  alias Shuttle.{Board, EventStream}

  test "folds by id, prunes and orders records" do
    now = System.system_time(:millisecond)

    records = [
      %{"type" => "board", "id" => "b", "timestamp" => now, "kind" => "post"},
      %{"type" => "board", "id" => "a", "timestamp" => now - 1, "kind" => "message"},
      %{"type" => "board", "id" => "old", "timestamp" => now - 15 * 86_400_000},
      %{"type" => "stop", "id" => "other", "timestamp" => now},
      %{"type" => "board", "id" => "", "timestamp" => now}
    ]

    folded = Enum.reduce(records, %{}, &Board.fold(&2, &1)) |> Board.prune(now)
    assert Enum.map(Board.since(folded, 0), & &1["id"]) == ["a", "b"]
    assert Enum.map(Board.since(folded, now), & &1["id"]) == ["b"]
  end

  test "seeds both files and follows append, rotation and rebuild" do
    dir = Path.join(System.tmp_dir!(), "board-test-#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)
    on_exit(fn -> File.rm_rf!(dir) end)
    path = Path.join(dir, "events.jsonl")
    now = System.system_time(:millisecond)

    line = fn id ->
      Jason.encode!(%{"type" => "board", "id" => id, "timestamp" => now}) <> "\n"
    end

    File.write!(path <> ".1", line.("a"))
    File.write!(path, line.("b"))
    name = :board_projection_test
    start_supervised!({EventStream, name: name, events_file: path, poll_interval_ms: 60_000})
    assert {:ok, records} = EventStream.board_records(name, path)
    assert Map.keys(records) |> Enum.sort() == ["a", "b"]
    File.write!(path, line.("c"), [:append])
    File.rename!(path, path <> ".1")
    File.write!(path, line.("d"))
    assert {:ok, records} = EventStream.board_records(name, path)
    assert Map.keys(records) |> Enum.sort() == ["a", "b", "c", "d"]
    File.write!(path, "")
    assert {:ok, records} = EventStream.board_records(name, path)
    assert Map.keys(records) |> Enum.sort() == ["b", "c"]
  end
end
