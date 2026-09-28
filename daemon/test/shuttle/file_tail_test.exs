defmodule Shuttle.FileTailTest do
  @moduledoc """
  The byte mechanics both `events.jsonl` followers share: seed to the last
  newline, read only what was appended, never consume a partial line, and
  report a shrink rather than deciding what it means.
  """
  use ExUnit.Case, async: true

  alias Shuttle.FileTail

  setup do
    path = Path.join(System.tmp_dir!(), "file_tail_#{System.unique_integer([:positive])}")
    on_exit(fn -> File.rm(path) end)
    {:ok, path: path}
  end

  test "a missing file seeds empty at offset zero and advances to nothing", %{path: path} do
    assert FileTail.seed(path) == {[], 0}
    assert FileTail.advance(path, 0) == :noop
  end

  test "seed returns whole lines and the offset just past the last newline", %{path: path} do
    File.write!(path, "a\nb\n")
    assert FileTail.seed(path) == {["a", "b"], 4}
  end

  test "seed leaves a partial trailing line unconsumed", %{path: path} do
    File.write!(path, "a\npartial")
    assert {["a"], 2} = FileTail.seed(path)

    # Completing the line makes it available to the very next advance, whole.
    File.write!(path, "-rest\n", [:append])
    assert {:append, ["partial-rest"], 15} = FileTail.advance(path, 2)
  end

  test "advance reads only appended bytes", %{path: path} do
    File.write!(path, "a\n")
    {_lines, offset} = FileTail.seed(path)
    File.write!(path, "b\nc\n", [:append])
    assert {:append, ["b", "c"], new_offset} = FileTail.advance(path, offset)
    assert new_offset == byte_size(File.read!(path))
    assert FileTail.advance(path, new_offset) == :noop
  end

  test "advance holds back a partial append until its newline lands", %{path: path} do
    File.write!(path, "a\n")
    assert FileTail.advance(path, 2) == :noop
    File.write!(path, "b", [:append])
    assert FileTail.advance(path, 2) == :noop
    File.write!(path, "\n", [:append])
    assert {:append, ["b"], 4} = FileTail.advance(path, 2)
  end

  test "a shrink is reported with the file's current size, not acted on", %{path: path} do
    File.write!(path, "a\nb\n")
    assert {:reset, 4} = FileTail.advance(path, 100)
    File.write!(path, "c\n")
    assert {:reset, 2} = FileTail.advance(path, 4)
  end

  test "blank lines are dropped, not surfaced as empty records", %{path: path} do
    File.write!(path, "a\n\n\nb\n")
    assert {["a", "b"], 6} = FileTail.seed(path)
  end
end
