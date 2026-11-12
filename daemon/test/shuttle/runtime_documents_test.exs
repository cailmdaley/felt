defmodule Shuttle.RuntimeDocumentsTest do
  use ExUnit.Case, async: true
  alias Shuttle.RuntimeDocuments, as: Documents

  setup do
    path = Path.join(System.tmp_dir!(), "runtime-document-#{System.unique_integer([:positive])}")
    on_exit(fn -> File.rm_rf(path) end)
    {:ok, path: path}
  end

  # The snapshot's second is the subject. A read that load delays past it may
  # see the edit, so the stale read is checked only while the second lasts.
  @tag :timing
  test "external edits enter at the next snapshot, including a cached missing file", %{path: path} do
    stale_until = System.monotonic_time(:millisecond) + 1_000
    assert {:error, :enoent} = Documents.read(path)
    File.write!(path, "first")
    stale = Documents.read(path)
    if System.monotonic_time(:millisecond) < stale_until, do: assert(stale == {:error, :enoent})
    Process.sleep(1_010)
    stale_until = System.monotonic_time(:millisecond) + 1_000
    assert {:ok, "first"} = Documents.read(path)
    File.write!(path, "other")
    stale = Documents.read(path)
    if System.monotonic_time(:millisecond) < stale_until, do: assert(stale == {:ok, "first"})
    Process.sleep(1_010)
    assert {:ok, "other"} = Documents.read(path)
  end

  test "a completed writer invalidates the snapshot for every reader", %{path: path} do
    File.write!(path, "before")
    assert {:ok, "before"} = Documents.read(path)
    assert :ok = Documents.change(path, fn -> File.write(path, "after") end)

    readers = for _ <- 1..20, do: Task.async(fn -> Documents.read(path) end)
    assert Enum.map(readers, &Task.await(&1, 30_000)) == List.duplicate({:ok, "after"}, 20)
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
    assert Task.await(writer, 30_000) == :ok
    assert Task.await(reader, 30_000) == {:ok, "committed"}
  end

  test "failed filesystem reads are retried immediately", %{path: path} do
    File.mkdir_p!(path)
    assert {:error, :eisdir} = Documents.read(path)
    File.rmdir!(path)
    File.write!(path, "recovered")
    assert {:ok, "recovered"} = Documents.read(path)
  end
end
