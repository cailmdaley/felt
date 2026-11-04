defmodule Shuttle.RuntimeDocumentsTest do
  use ExUnit.Case, async: true
  alias Shuttle.RuntimeDocuments, as: Documents

  setup do
    path = Path.join(System.tmp_dir!(), "runtime-document-#{System.unique_integer([:positive])}")
    on_exit(fn -> File.rm_rf(path) end)
    {:ok, path: path}
  end

  test "external edits enter at the next snapshot, including a cached missing file", %{path: path} do
    assert {:error, :enoent} = Documents.read(path)
    File.write!(path, "first")
    assert {:error, :enoent} = Documents.read(path)
    Process.sleep(1_010)
    assert {:ok, "first"} = Documents.read(path)
    File.write!(path, "other")
    assert {:ok, "first"} = Documents.read(path)
    Process.sleep(1_010)
    assert {:ok, "other"} = Documents.read(path)
  end

  test "a completed writer invalidates the snapshot for every reader", %{path: path} do
    File.write!(path, "before")
    assert {:ok, "before"} = Documents.read(path)
    assert :ok = Documents.change(path, fn -> File.write(path, "after") end)

    readers = for _ <- 1..20, do: Task.async(fn -> Documents.read(path) end)
    assert Enum.map(readers, &Task.await/1) == List.duplicate({:ok, "after"}, 20)
  end

  test "a cold read waits for an in-flight writer without blocking other documents", %{path: path} do
    owner = self()

    writer =
      Task.async(fn ->
        Documents.change(path, fn ->
          send(owner, :writing)

          receive do
            :commit -> File.write(path, "committed")
          end
        end)
      end)

    assert_receive :writing
    reader = Task.async(fn -> Documents.read(path) end)
    assert Task.yield(reader, 20) == nil
    assert {:error, :enoent} = Documents.read(path <> ".other")
    send(writer.pid, :commit)
    assert Task.await(writer) == :ok
    assert Task.await(reader) == {:ok, "committed"}
  end

  test "failed filesystem reads are retried immediately", %{path: path} do
    File.mkdir_p!(path)
    assert {:error, :eisdir} = Documents.read(path)
    File.rmdir!(path)
    File.write!(path, "recovered")
    assert {:ok, "recovered"} = Documents.read(path)
  end
end
