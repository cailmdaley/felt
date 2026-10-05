defmodule Shuttle.Test.TranscriptHelpers do
  @moduledoc "Harness transcripts on disk, for continuation tests."

  @doc """
  Writes a Claude transcript for `session`, last modified `age_s` seconds ago,
  under a per-test projects root (`SHUTTLE_CLAUDE_PROJECTS_DIR`, in the test's
  scope), and returns its path.
  """
  def write_transcript(session, age_s \\ 0) do
    root =
      Path.join(System.tmp_dir!(), "shuttle-transcripts-#{System.unique_integer([:positive])}")

    Shuttle.Test.Env.put_env("SHUTTLE_CLAUDE_PROJECTS_DIR", root)
    ExUnit.Callbacks.on_exit(fn -> File.rm_rf!(root) end)

    path = Path.join([root, "-work", "#{session}.jsonl"])
    File.mkdir_p!(Path.dirname(path))
    File.write!(path, "{}\n")
    File.touch!(path, System.os_time(:second) - age_s)
    path
  end
end
