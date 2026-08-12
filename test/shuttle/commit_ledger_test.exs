defmodule Shuttle.CommitLedgerTest do
  @moduledoc """
  The commit ledger's read path: what comes back out of `commits.jsonl`, and
  what is refused on the way.

  The *writer* is `loom/hooks/shuttle-hook.sh`, not the daemon, so there is no
  `record/1` to pin here — these tests write the file the way the hook does and
  assert what the reader makes of it, including the shapes a hook mid-rotation
  or mid-line can leave behind.
  """
  # Sync: `default_path/0`'s test mutates SHUTTLE_COMMITS_FILE / SHUTTLE_DATA_DIR,
  # which every other test's ledger resolution reads.
  use ExUnit.Case, async: false

  alias Shuttle.CommitLedger

  setup do
    path =
      Path.join(System.tmp_dir!(), "shuttle_commits_#{System.unique_integer([:positive])}.jsonl")

    on_exit(fn ->
      File.rm(path)
      File.rm(path <> ".1")
    end)

    {:ok, path: path}
  end

  defp commit(fields) do
    Map.merge(
      %{
        "at" => 1_786_203_000_000,
        "kind" => "commit",
        "sha" => "79def80887a45cfdaea4e23a6e0444df808e908a",
        "subject" => "desk: cycle lens",
        "repo" => "/Users/me/dev/felt",
        "files" => 3,
        "insertions" => 42,
        "deletions" => 7,
        "session" => "0883ade1-08e0-4457-94c6-7ac12137eb0f",
        "tmux" => "edits-01KTS261GJMMRDRHS2QDMEFV3K-shuttle",
        "cwd" => "/Users/me/dev/felt"
      },
      fields
    )
  end

  defp write(path, records) do
    File.write!(path, Enum.map_join(records, "\n", &Jason.encode!/1) <> "\n")
  end

  describe "read_since/2" do
    test "serves the whole line the hook wrote, unmodified", %{path: path} do
      record = commit(%{})
      write(path, [record])

      assert CommitLedger.read_since(0, path: path) == [record]
    end

    test "returns everything at or after the bound, oldest first", %{path: path} do
      write(path, [
        commit(%{"at" => 300, "sha" => "new"}),
        commit(%{"at" => 100, "sha" => "old"}),
        commit(%{"at" => 200, "sha" => "edge"})
      ])

      assert Enum.map(CommitLedger.read_since(200, path: path), & &1["sha"]) == ["edge", "new"]

      assert Enum.map(CommitLedger.read_since(0, path: path), & &1["sha"]) == [
               "old",
               "edge",
               "new"
             ]

      assert CommitLedger.read_since(301, path: path) == []
    end

    test "reads the rotated sibling too, and orders across both files", %{path: path} do
      write(path <> ".1", [
        commit(%{"at" => 100, "sha" => "rotated"}),
        commit(%{"at" => 250, "sha" => "rotated-late"})
      ])

      write(path, [commit(%{"at" => 200, "sha" => "live"})])

      assert Enum.map(CommitLedger.read_since(150, path: path), & &1["sha"]) ==
               ["live", "rotated-late"]
    end

    test "skips malformed lines, blank lines, and records with no usable `at`", %{path: path} do
      File.write!(
        path,
        Enum.join(
          [
            "{ not json at all",
            "",
            "   ",
            Jason.encode!(commit(%{"at" => nil, "sha" => "no-at"})),
            Jason.encode!(commit(%{"at" => "100", "sha" => "string-at"})),
            Jason.encode!(commit(%{"at" => 100, "sha" => "good"}))
          ],
          "\n"
        ) <> "\n"
      )

      assert Enum.map(CommitLedger.read_since(0, path: path), & &1["sha"]) == ["good"]
    end

    test "drops a record with no sha — the join key every reader dedupes on", %{path: path} do
      File.write!(
        path,
        Enum.join(
          [
            Jason.encode!(Map.delete(commit(%{"at" => 100}), "sha")),
            Jason.encode!(commit(%{"at" => 100, "sha" => ""})),
            Jason.encode!(commit(%{"at" => 100, "sha" => "kept"}))
          ],
          "\n"
        ) <> "\n"
      )

      assert Enum.map(CommitLedger.read_since(0, path: path), & &1["sha"]) == ["kept"]
    end

    test "keeps a commit the hook could not pair with a session", %{path: path} do
      # A commit made outside a harness session still happened. Coverage is
      # partial by construction; an unpaired commit is data, not an error.
      write(path, [commit(%{"session" => nil, "tmux" => nil})])

      assert [%{"session" => nil}] = CommitLedger.read_since(0, path: path)
    end

    test "an absent ledger reads as empty", %{path: path} do
      assert CommitLedger.read_since(0, path: path) == []
    end
  end

  describe "read_between/3" do
    test "bounds inclusively on both sides", %{path: path} do
      write(path, [
        commit(%{"at" => 100, "sha" => "before"}),
        commit(%{"at" => 200, "sha" => "lower-edge"}),
        commit(%{"at" => 250, "sha" => "inside"}),
        commit(%{"at" => 300, "sha" => "upper-edge"}),
        commit(%{"at" => 400, "sha" => "after"})
      ])

      assert Enum.map(CommitLedger.read_between(200, 300, path: path), & &1["sha"]) ==
               ["lower-edge", "inside", "upper-edge"]
    end

    test "a nil upper bound is open-ended", %{path: path} do
      write(path, [commit(%{"at" => 100, "sha" => "a"}), commit(%{"at" => 400, "sha" => "b"})])

      assert Enum.map(CommitLedger.read_between(0, nil, path: path), & &1["sha"]) == ["a", "b"]
    end
  end

  describe "default_path/0" do
    test "honors SHUTTLE_COMMITS_FILE, then SHUTTLE_DATA_DIR, then ~/.shuttle" do
      previous = Map.new(~w(SHUTTLE_COMMITS_FILE SHUTTLE_DATA_DIR), &{&1, System.get_env(&1)})

      on_exit(fn ->
        Enum.each(previous, fn {k, v} ->
          if v, do: System.put_env(k, v), else: System.delete_env(k)
        end)
      end)

      System.put_env("SHUTTLE_COMMITS_FILE", "/explicit/commits.jsonl")
      assert CommitLedger.default_path() == "/explicit/commits.jsonl"

      System.delete_env("SHUTTLE_COMMITS_FILE")
      System.put_env("SHUTTLE_DATA_DIR", "/data")
      assert CommitLedger.default_path() == "/data/commits.jsonl"

      System.delete_env("SHUTTLE_DATA_DIR")
      assert CommitLedger.default_path() =~ ~r{/\.shuttle/commits\.jsonl$}
    end
  end
end
