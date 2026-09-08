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
  import Shuttle.Test.Ledgers

  setup do
    path =
      Path.join(System.tmp_dir!(), "shuttle_commits_#{System.unique_integer([:positive])}.jsonl")

    on_exit(fn ->
      File.rm(path)
      File.rm(path <> ".1")
    end)

    {:ok, path: path}
  end

  describe "read_between/3 — open-ended" do
    test "serves the whole line the hook wrote, unmodified", %{path: path} do
      record = commit_record(%{})
      write_jsonl!(path, [record])

      assert CommitLedger.read_between(0, nil, path: path) == [record]
    end

    test "returns everything at or after the bound, oldest first", %{path: path} do
      write_jsonl!(path, [
        commit_record(%{"at" => 300, "sha" => "new"}),
        commit_record(%{"at" => 100, "sha" => "old"}),
        commit_record(%{"at" => 200, "sha" => "edge"})
      ])

      assert Enum.map(CommitLedger.read_between(200, nil, path: path), & &1["sha"]) == [
               "edge",
               "new"
             ]

      assert Enum.map(CommitLedger.read_between(0, nil, path: path), & &1["sha"]) == [
               "old",
               "edge",
               "new"
             ]

      assert CommitLedger.read_between(301, nil, path: path) == []
    end

    test "reads the rotated sibling too, and orders across both files", %{path: path} do
      write_jsonl!(path <> ".1", [
        commit_record(%{"at" => 100, "sha" => "rotated"}),
        commit_record(%{"at" => 250, "sha" => "rotated-late"})
      ])

      write_jsonl!(path, [commit_record(%{"at" => 200, "sha" => "live"})])

      assert Enum.map(CommitLedger.read_between(150, nil, path: path), & &1["sha"]) ==
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
            Jason.encode!(commit_record(%{"at" => nil, "sha" => "no-at"})),
            Jason.encode!(commit_record(%{"at" => "100", "sha" => "string-at"})),
            Jason.encode!(commit_record(%{"at" => 100, "sha" => "good"}))
          ],
          "\n"
        ) <> "\n"
      )

      assert Enum.map(CommitLedger.read_between(0, nil, path: path), & &1["sha"]) == ["good"]
    end

    test "drops a record with no sha — the join key every reader dedupes on", %{path: path} do
      File.write!(
        path,
        Enum.join(
          [
            Jason.encode!(Map.delete(commit_record(%{"at" => 100}), "sha")),
            Jason.encode!(commit_record(%{"at" => 100, "sha" => ""})),
            Jason.encode!(commit_record(%{"at" => 100, "sha" => "kept"}))
          ],
          "\n"
        ) <> "\n"
      )

      assert Enum.map(CommitLedger.read_between(0, nil, path: path), & &1["sha"]) == ["kept"]
    end

    test "keeps a commit the hook could not pair with a session", %{path: path} do
      # A commit made outside a harness session still happened. Coverage is
      # partial by construction; an unpaired commit is data, not an error.
      write_jsonl!(path, [commit_record(%{"session" => nil, "tmux" => nil})])

      assert [%{"session" => nil}] = CommitLedger.read_between(0, nil, path: path)
    end

    test "an absent ledger reads as empty", %{path: path} do
      assert CommitLedger.read_between(0, nil, path: path) == []
    end
  end

  describe "read_between/3" do
    test "bounds inclusively on both sides", %{path: path} do
      write_jsonl!(path, [
        commit_record(%{"at" => 100, "sha" => "before"}),
        commit_record(%{"at" => 200, "sha" => "lower-edge"}),
        commit_record(%{"at" => 250, "sha" => "inside"}),
        commit_record(%{"at" => 300, "sha" => "upper-edge"}),
        commit_record(%{"at" => 400, "sha" => "after"})
      ])

      assert Enum.map(CommitLedger.read_between(200, 300, path: path), & &1["sha"]) ==
               ["lower-edge", "inside", "upper-edge"]
    end

    test "a nil upper bound is open-ended", %{path: path} do
      write_jsonl!(path, [
        commit_record(%{"at" => 100, "sha" => "a"}),
        commit_record(%{"at" => 400, "sha" => "b"})
      ])

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
