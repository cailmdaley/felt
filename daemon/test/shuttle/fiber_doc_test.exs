defmodule Shuttle.FiberDocTest do
  use ExUnit.Case, async: true

  alias Shuttle.FiberDoc

  defp write_doc!(content) do
    dir = Path.join(System.tmp_dir!(), "fiber-doc-test-#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)
    path = Path.join(dir, "fiber.md")
    File.write!(path, content)
    on_exit(fn -> File.rm_rf!(dir) end)
    path
  end

  test "read_path parses a well-formed fiber" do
    path = write_doc!("---\nid: sample\nstatus: open\n---\nbody text\n")

    assert {:ok, ^path, raw_fm, frontmatter, body} = FiberDoc.read_path(path)
    assert raw_fm =~ "id: sample"
    assert frontmatter == %{"id" => "sample", "status" => "open"}
    assert body =~ "body text"
  end

  test "read_path returns an error for a missing closing fence" do
    path = write_doc!("---\nid: sample\nno closing fence")

    assert {:error, "missing closing frontmatter delimiter"} = FiberDoc.read_path(path)
  end

  # Malformed YAML does not always come back as `{:error, _}` from the parser:
  # some documents RAISE out of the parse or the key normalization instead.
  # These raises used to propagate out of read_path and crash the Poller
  # GenServer mid-handle_call; they must land as {:error, reason}.
  test "read_path maps a raising parse (non-scalar mapping key) to {:error, reason}" do
    path = write_doc!("---\n? {a: 1}\n: value\n---\nbody\n")

    assert {:error, message} = FiberDoc.read_path(path)
    assert message =~ "malformed fiber document"
  end

  test "read_path maps a non-map frontmatter document to {:error, reason}" do
    path = write_doc!("---\n- just\n- a list\n---\nbody\n")

    assert {:error, message} = FiberDoc.read_path(path)
    assert message =~ "malformed fiber document"
  end

  defp temp_files(dir), do: dir |> File.ls!() |> Enum.filter(&String.ends_with?(&1, ".tmp"))

  test "write! replaces the file and leaves no temp file" do
    path = write_doc!("---\nid: sample\nstatus: open\n---\nbody text\n")
    {:ok, ^path, raw_fm, _fm, body} = FiberDoc.read_path(path)

    assert :ok = FiberDoc.write!(path, raw_fm, body, [{:put, "status", "active"}])

    assert File.read!(path) == "---\nid: sample\nstatus: active\n---\nbody text\n"
    assert temp_files(Path.dirname(path)) == []
  end

  # Every writer gets its own temp file: with one shared name, a second
  # writer's rename finds the first one's temp already gone.
  test "concurrent snapshot writes refuse stale images instead of losing completed edits" do
    path = write_doc!("---\nid: sample\nstatus: open\n---\nbody\n")
    {:ok, ^path, raw_fm, _fm, body} = FiberDoc.read_path(path)

    results =
      1..20
      |> Enum.map(fn i ->
        Task.async(fn ->
          try do
            FiberDoc.write!(path, raw_fm, body, [{:put, "status", "s#{i}"}])
          rescue
            error -> {:refused, Exception.message(error)}
          end
        end)
      end)
      |> Task.await_many(30_000)

    assert Enum.count(results, &(&1 == :ok)) == 1
    assert Enum.count(results, &match?({:refused, _}, &1)) == 19
    assert File.read!(path) =~ ~r/\A---\nid: sample\nstatus: s\d+\n---\nbody\n\z/
    assert temp_files(Path.dirname(path)) == []
  end

  test "write! through a symlink replaces the file it names and keeps the link" do
    real = write_doc!("---\nid: sample\nstatus: open\n---\nbody\n")
    link = Path.join(Path.dirname(real), "link.md")
    File.ln_s!(real, link)
    {:ok, ^link, raw_fm, _fm, body} = FiberDoc.read_path(link)

    assert :ok = FiberDoc.write!(link, raw_fm, body, [{:put, "status", "active"}])

    assert {:ok, %File.Stat{type: :symlink}} = File.lstat(link)
    assert File.read!(real) =~ "status: active"
    assert temp_files(Path.dirname(real)) == []
  end

  test "a snapshot mutation refuses a missing document behind a dangling symlink" do
    dir = Path.dirname(write_doc!("---\nid: other\n---\n"))
    link = Path.join(dir, "dangling.md")
    missing = Path.join(dir, "missing.md")
    File.ln_s!(missing, link)

    assert_raise RuntimeError, fn ->
      FiberDoc.write!(link, "id: sample\nstatus: open\n", "\n", [])
    end

    assert {:ok, %File.Stat{type: :symlink}} = File.lstat(link)
    refute File.exists?(missing)
  end
end
