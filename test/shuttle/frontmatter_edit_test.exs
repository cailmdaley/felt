defmodule Shuttle.FrontmatterEditTest do
  use ExUnit.Case, async: true

  alias Shuttle.FrontmatterEdit

  describe "scalar/1 — real YAML quoting, never Elixir inspect/1" do
    test "bare felt-vocabulary tokens pass through unquoted" do
      assert FrontmatterEdit.scalar("active") == "active"
      assert FrontmatterEdit.scalar("life/french/practice") == "life/french/practice"
      assert FrontmatterEdit.scalar("2026-06-14T08:00:00Z") == "2026-06-14T08:00:00Z"
    end

    test "values needing quotes get YAML double-quotes with minimal escapes" do
      # A space forces quoting; embedded quotes are backslash-escaped — this is
      # YAML, not Elixir inspect (which would be identical here, but the contract
      # is YAML-shaped, e.g. it would NOT prefix with a sigil or use Elixir-only
      # escapes).
      assert FrontmatterEdit.scalar(~s(Cail: "much better")) == ~s("Cail: \\"much better\\"")
      assert FrontmatterEdit.scalar("a\tb") == ~s("a\\tb")
    end

    test "booleans, nil, numbers" do
      assert FrontmatterEdit.scalar(true) == "true"
      assert FrontmatterEdit.scalar(false) == "false"
      assert FrontmatterEdit.scalar(nil) == "null"
      assert FrontmatterEdit.scalar(7) == "7"
    end
  end

  describe "apply/2 — surgical, byte-stable edits" do
    @fm """
    name: Daily practice
    status: open
    outcome: |-
        Line one with a "quote" and unicode σ → ✓.
        ---
        Line two.
    shuttle:
      kind: standing
      next_due_at: 2026-06-15T08:00:00Z
      schedule:
        expr: "0 8 * * *"
    """

    test "put replaces only the targeted key's line, block scalar untouched" do
      out = FrontmatterEdit.apply(@fm, [{:put, "status", "closed"}])

      assert out =~ "status: closed"
      refute out =~ "status: open"
      # Every block-scalar line survives verbatim.
      assert out =~ ~s(    Line one with a "quote" and unicode σ → ✓.)
      assert out =~ "    ---"
      assert out =~ "outcome: |-"
      # No other key moved or changed.
      assert out =~ "name: Daily practice"
    end

    test "put appends a new key when absent" do
      out = FrontmatterEdit.apply(@fm, [{:put, "closed-at", "2026-06-14T09:00:00Z"}])
      assert out =~ "closed-at: 2026-06-14T09:00:00Z"
      # Appended after the existing content, not interleaved.
      assert String.ends_with?(out, "closed-at: 2026-06-14T09:00:00Z\n")
    end

    test "delete removes a top-level key and its whole value span (block scalar)" do
      out = FrontmatterEdit.apply(@fm, [{:delete, "outcome"}])
      refute out =~ "outcome:"
      refute out =~ "Line one"
      refute out =~ "Line two"
      # Sibling keys and the nested block are intact.
      assert out =~ "status: open"
      assert out =~ "kind: standing"
    end

    test "delete_nested removes a child key from inside a block, siblings intact" do
      out = FrontmatterEdit.apply(@fm, [{:delete_nested, "shuttle", "next_due_at"}])
      refute out =~ "next_due_at:"
      assert out =~ "kind: standing"
      assert out =~ "schedule:"
      assert out =~ ~s(    expr: "0 8 * * *")
    end

    test "put_nested appends a fresh child inheriting the block's child indent" do
      out = FrontmatterEdit.apply(@fm, [{:put_nested, "shuttle", "dispatched_at", "2026-06-20T18:00:00Z"}])
      # 2-space child indent inherited from the block's existing children.
      assert out =~ "\n  dispatched_at: 2026-06-20T18:00:00Z"
      # Siblings and the nested schedule block untouched.
      assert out =~ "  kind: standing"
      assert out =~ ~s(    expr: "0 8 * * *")
      {:ok, parsed} = YamlElixir.read_from_string(out)
      assert parsed["shuttle"]["dispatched_at"] == "2026-06-20T18:00:00Z"
      assert parsed["shuttle"]["kind"] == "standing"
    end

    test "put_nested replaces an existing child in place (re-stamp), value-only change" do
      seeded = FrontmatterEdit.apply(@fm, [{:put_nested, "shuttle", "handed_off_at", "2026-06-20T18:00:00Z"}])
      out = FrontmatterEdit.apply(seeded, [{:put_nested, "shuttle", "handed_off_at", "2026-06-20T19:00:00Z"}])
      assert out =~ "handed_off_at: 2026-06-20T19:00:00Z"
      refute out =~ "2026-06-20T18:00:00Z"
      # Exactly one occurrence — replaced, not duplicated.
      assert length(String.split(out, "handed_off_at:")) == 2
    end

    test "put_nested on a 4-space block inherits 4-space indent (felt's writer)" do
      felt_fm = "id: x\nshuttle:\n    kind: oneshot\n    host: h\n"
      out = FrontmatterEdit.apply(felt_fm, [{:put_nested, "shuttle", "session_uuid", "u-123"}])
      assert out =~ "\n    session_uuid: u-123"
      {:ok, parsed} = YamlElixir.read_from_string(out)
      assert parsed["shuttle"]["session_uuid"] == "u-123"
      assert parsed["shuttle"]["host"] == "h"
    end

    test "put_nested creates the parent block when absent" do
      out = FrontmatterEdit.apply("id: x\nstatus: active\n", [{:put_nested, "shuttle", "handed_off_at", "2026-06-20T20:00:00Z"}])
      {:ok, parsed} = YamlElixir.read_from_string(out)
      assert parsed["shuttle"]["handed_off_at"] == "2026-06-20T20:00:00Z"
    end

    test "put_nested preserves a block scalar elsewhere in the document" do
      out = FrontmatterEdit.apply(@fm, [{:put_nested, "shuttle", "session_uuid", "u-9"}])
      assert out =~ "outcome: |-"
      assert out =~ ~s(    Line one with a "quote" and unicode σ → ✓.)
      assert out =~ "    Line two."
    end

    test "no-op edits are byte-identical (idempotency contract)" do
      # Deleting an absent key and re-putting an identical value is a no-op.
      out = FrontmatterEdit.apply(@fm, [{:delete, "tempered"}, {:put, "status", "open"}])
      assert out == @fm
    end

    test "key order is preserved (no alphabetical reordering)" do
      out = FrontmatterEdit.apply(@fm, [{:put, "status", "closed"}])
      keys = for line <- String.split(out, "\n"), m = Regex.run(~r/^(\w[\w\-]*):/, line), do: hd(tl(m))
      assert keys == ["name", "status", "outcome", "shuttle"]
    end
  end

  describe "render/1 — fresh map → YAML block (creation-path emit)" do
    test "nested map + scalars render as valid YAML that round-trips" do
      extra = %{
        "shuttle" => %{"kind" => "pinned", "host" => "cineca", "project_dir" => "/leonardo/cmbx"},
        "horizon" => "now"
      }

      {:ok, parsed} = YamlElixir.read_from_string(FrontmatterEdit.render(extra))
      assert parsed == extra
    end

    test "multi-line string renders as a |- block scalar, never an escaped one-liner" do
      outcome = "First line, Cail: \"much better\"\n---\nSecond chunk, unicode δκ → σ ≥ done"
      out = FrontmatterEdit.render(%{"outcome" => outcome})

      assert out =~ "outcome: |-"
      refute out =~ ~s(outcome: ")
      {:ok, parsed} = YamlElixir.read_from_string(out)
      assert parsed["outcome"] == outcome
    end

    test "embedded quotes + unicode in a single-line value round-trip as YAML (not inspect/1)" do
      {:ok, parsed} =
        FrontmatterEdit.render(%{"name" => "Cail said \"hi\" — δ"})
        |> YamlElixir.read_from_string()

      assert parsed["name"] == "Cail said \"hi\" — δ"
    end

    test "spliced after felt-native frontmatter, the whole document parses" do
      native = "id: 01ABC\nname: Test\nstatus: active\n"
      extra = %{"shuttle" => %{"kind" => "oneshot", "host" => "dapmcw68"}, "outcome" => "line one\nline two"}

      {:ok, parsed} = YamlElixir.read_from_string(native <> FrontmatterEdit.render(extra))
      assert parsed["shuttle"]["kind"] == "oneshot"
      assert parsed["outcome"] == "line one\nline two"
      assert parsed["status"] == "active"
    end
  end
end
