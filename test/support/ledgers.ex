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

  SHUTTLE_DATA_DIR is deleted for the duration: the daemon resolves it as the
  fallback root, so leaving a real one set would let ledger resolution find a
  file this test never wrote.
  """
  def ledger_setup!(env_var, prefix) do
    path =
      Path.join(
        System.tmp_dir!(),
        "#{prefix}_#{System.unique_integer([:positive])}.jsonl"
      )

    previous = System.get_env(env_var)
    previous_data_dir = System.get_env("SHUTTLE_DATA_DIR")
    System.delete_env("SHUTTLE_DATA_DIR")
    System.put_env(env_var, path)

    on_exit(fn ->
      File.rm(path)
      File.rm(path <> ".1")
      if previous, do: System.put_env(env_var, previous)
      if previous_data_dir, do: System.put_env("SHUTTLE_DATA_DIR", previous_data_dir)
    end)

    path
  end
end
