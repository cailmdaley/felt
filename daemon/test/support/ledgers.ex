defmodule Shuttle.Test.Ledgers do
  @moduledoc """
  Fixtures for the JSONL ledgers (`commits.jsonl`, `sessions.jsonl`) and the
  controllers that serve them.

  `import Shuttle.Test.Ledgers` from a NON-async test module — `ledger_setup!/2`
  mutates process-global env.
  """

  import ExUnit.Callbacks, only: [on_exit: 1]

  @doc """
  Write `records` as JSONL, one object per line — the shape the hook writes.
  """
  def write_jsonl!(path, records) do
    File.write!(path, Enum.map_join(records, "", &(Jason.encode!(&1) <> "\n")))
  end

  @doc """
  A commit-ledger record, with `overrides` merged over the hook's field set.
  """
  def commit_record(overrides \\ %{}) do
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
      overrides
    )
  end

  @doc """
  Point a ledger controller at a throwaway `.jsonl` under `env_var`, and sweep
  it (plus the rotated sibling the reader also reads) afterwards.

  The override lives in the test's scope (`Shuttle.Test.Env`); the suite pins
  SHUTTLE_DATA_DIR, the fallback root, to an empty dir.
  """
  def ledger_setup!(env_var, prefix) do
    path =
      Path.join(
        System.tmp_dir!(),
        "#{prefix}_#{System.unique_integer([:positive])}.jsonl"
      )

    Shuttle.Test.Env.put_env(env_var, path)

    on_exit(fn ->
      File.rm(path)
      File.rm(path <> ".1")
    end)

    path
  end
end
