defmodule Shuttle.FileTailTest do
  @moduledoc """
  The byte mechanics behind `Shuttle.EventStream`: snapshot to the last
  newline, read only what was appended, never consume a partial line, report
  a shrink rather than deciding what it means, and drain a rotated file.
  """
  use ExUnit.Case, async: true

  alias Shuttle.FileTail

  setup do
    path = Path.join(System.tmp_dir!(), "file_tail_#{System.unique_integer([:positive])}")
    on_exit(fn -> File.rm(path) end)
    {:ok, path: path}
  end

  test "a missing file snapshots empty at offset zero and advances to nothing", %{path: path} do
    assert FileTail.snapshot(path) == {[], 0, nil}
    assert FileTail.advance(path, 0) == :noop
  end

  test "snapshot returns whole lines, the offset just past the last newline, and the inode",
       %{path: path} do
    File.write!(path, "a\nb\n")
    assert FileTail.snapshot(path) == {["a", "b"], 4, FileTail.inode(path)}
  end

  test "snapshot leaves a partial trailing line unconsumed", %{path: path} do
    File.write!(path, "a\npartial")
    assert {["a"], 2, _inode} = FileTail.snapshot(path)

    # Completing the line makes it available to the very next advance, whole.
    File.write!(path, "-rest\n", [:append])
    assert {:append, ["partial-rest"], 15} = FileTail.advance(path, 2)
  end

  test "advance reads only appended bytes", %{path: path} do
    File.write!(path, "a\n")
    {_lines, offset, _inode} = FileTail.snapshot(path)
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
    assert {["a", "b"], 6, _inode} = FileTail.snapshot(path)
  end

  test "drain reads a finished file from an offset, unterminated last line included",
       %{path: path} do
    File.write!(path, "a\nb\nc")
    assert FileTail.drain(path, 2) == ["b", "c"]
    assert FileTail.drain(path, 5) == []
    assert FileTail.drain(path <> ".missing", 0) == []
  end

  test "inode survives an append and moves with a rename", %{path: path} do
    assert FileTail.inode(path) == nil
    File.write!(path, "a\n")
    inode = FileTail.inode(path)
    File.write!(path, "b\n", [:append])
    assert FileTail.inode(path) == inode

    File.rename!(path, path <> ".1")
    on_exit(fn -> File.rm(path <> ".1") end)
    File.write!(path, "c\n")
    assert FileTail.inode(path <> ".1") == inode
    refute FileTail.inode(path) == inode
  end
end
