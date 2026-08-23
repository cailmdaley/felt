defmodule Shuttle.TranscriptTest do
  use ExUnit.Case, async: false

  alias Shuttle.Transcript

  @session "a3edf873-cb1c-40ab-a891-f26f5333b320"

  setup do
    root =
      Path.join(System.tmp_dir!(), "shuttle_transcript_#{System.unique_integer([:positive])}")

    File.mkdir_p!(Path.join(root, "-Users-cail-french"))

    on_exit(fn -> File.rm_rf(root) end)
    {:ok, root: root}
  end

  test "resolves a native file and identifies its harness", %{root: root} do
    path = Path.join([root, "-Users-cail-french", "#{@session}.jsonl"])
    File.write!(path, "native bytes\n")

    assert %{availability: :available_local, source_path: ^path, harness: "claude-code"} =
             Transcript.resolve(@session, root: root)

    assert {:ok, ^path} = Transcript.bytes(@session, root: root)
  end

  test "reports a valid but unknown UUID as transcript_missing", %{root: root} do
    assert %{availability: :transcript_missing, source_path: nil} =
             Transcript.resolve(@session, root: root, ledger_path: Path.join(root, "ledger"))
  end

  test "reports transcript_missing once the ledger has an identity", %{root: root} do
    ledger = Path.join(root, "ledger")

    Shuttle.SessionLedger.record(
      path: ledger,
      fiber: "work/example",
      session: @session,
      harness: "codex",
      host: "candide",
      kind: :dispatch
    )

    assert %{availability: :transcript_missing, host: "candide", harness: "codex"} =
             Transcript.resolve(@session, root: root, ledger_path: ledger)

    assert {:error, :transcript_missing} =
             Transcript.bytes(@session, root: root, ledger_path: ledger)
  end
end
