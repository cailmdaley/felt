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
end
