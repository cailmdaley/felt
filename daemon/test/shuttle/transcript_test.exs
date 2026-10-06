defmodule Shuttle.TranscriptTest do
  use ExUnit.Case, async: true

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

  describe "path/2" do
    @absent "/nope/not/here"
    @unknown "11111111-2222-3333-4444-555555555555"

    defp touch(path) do
      File.mkdir_p!(Path.dirname(path))
      File.write!(path, "{}\n")
      path
    end

    defp tmp_root(label) do
      root =
        Path.join(System.tmp_dir!(), "shuttle_#{label}_#{System.unique_integer([:positive])}")

      on_exit(fn -> File.rm_rf(root) end)
      root
    end

    test "finds a claude transcript under any project directory", %{root: root} do
      path = touch(Path.join([root, "-Users-cail-french", "#{@session}.jsonl"]))

      assert Transcript.path(@session, root: root, pi_root: @absent, codex_root: @absent) == path
      assert Transcript.path(@unknown, root: root, pi_root: @absent, codex_root: @absent) == nil
    end

    test "finds a pi transcript the claude root does not have" do
      pi = tmp_root("pi")

      path =
        touch(Path.join([pi, "--Users-cail-french--", "2026-08-01T10-00-00_#{@session}.jsonl"]))

      assert Transcript.path(@session, root: @absent, pi_root: pi, codex_root: @absent) == path
      assert Transcript.path(@unknown, root: @absent, pi_root: pi, codex_root: @absent) == nil
    end

    test "finds a Codex rollout in its date fan-out, however old" do
      codex = tmp_root("codex")
      date = Date.add(Shuttle.HarnessPaths.local_today(), -7)
      day = Calendar.strftime(date, "%Y/%m/%d")
      path = touch(Path.join([codex, day, "rollout-2026-08-23T18-19-21-052Z-#{@session}.jsonl"]))

      assert Transcript.path(@session, root: @absent, pi_root: @absent, codex_root: codex) == path
      assert Transcript.path(@unknown, root: @absent, pi_root: @absent, codex_root: codex) == nil
    end

    test "a non-UUID session is never globbed", %{root: root} do
      touch(Path.join([root, "-Users-cail-french", "*.jsonl"]))
      assert Transcript.path("*", root: root, pi_root: @absent, codex_root: @absent) == nil
    end
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
