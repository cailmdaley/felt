defmodule Shuttle.LifecycleStoreTest do
  use ExUnit.Case
  import Shuttle.Test.EnvHelpers

  alias Shuttle.LifecycleStore

  describe "mark_awaiting/1 — the standing-exit writer (active → closed, untempered)" do
    test "flips status:active → closed with closed-at, no verdict, and reads as doc-awaiting" do
      with_doc_awaiting_role(
        fn fiber_id, path ->
          assert {:ok, message} = LifecycleStore.mark_awaiting(fiber_id)
          assert message =~ "awaiting review"

          fm = read_frontmatter(path)
          assert fm["status"] == "closed"
          assert is_binary(fm["closed-at"])
          refute Map.has_key?(fm, "tempered")
        end,
        status: "active"
      )
    end
  end

  describe "pinned roles are interactive interfaces (park at open on session end)" do
    test "park flips an active pinned role back to the strip (active → open), pinned-only" do
      # The pinned worker-exit closer: a pinned role's session ending parks it
      # back to the strip (status:open), the mirror of mark_awaiting's standing
      # close (status:closed). Pinned-only — it rejects a standing/oneshot block
      # by kind so the exit path can't park the wrong thing.
      with_pinned_role(
        fn fiber_id, path ->
          assert read_frontmatter(path)["status"] == "active"
          assert {:ok, message} = LifecycleStore.park(fiber_id)
          assert message =~ "parked"
          assert read_frontmatter(path)["status"] == "open"
        end,
        status: "active"
      )
    end

    test "park is idempotent on an already-parked role and rejects a standing role" do
      with_pinned_role(
        fn fiber_id, _path ->
          assert {:ok, msg} = LifecycleStore.park(fiber_id)
          assert msg =~ "already parked"
        end,
        status: "open"
      )
    end

    test "mark_awaiting rejects a pinned role (standing worker-exit closer is standing-only)" do
      # mark_awaiting is the STANDING worker-exit closer (writes status:closed).
      # A pinned worker exit is handled differently (park / redispatch), so
      # mark_awaiting rejects a pinned block by KIND — even in the awaiting-shaped
      # status:closed + untempered state a standing role would accept from.
      with_pinned_role(
        fn fiber_id, path ->
          assert {:error, msg} = LifecycleStore.mark_awaiting(fiber_id)
          assert msg =~ "standing"
          # Untouched: mark_awaiting did not close it.
          assert read_frontmatter(path)["status"] == "closed"
        end,
        status: "closed"
      )
    end

    test "rearm starts a parked pinned role (open → active) for force-dispatch" do
      # The board's strip → In-flight "start" gesture force-dispatches a parked
      # (status:open) pinned role; maybe_force_rearm → rearm writes open → active
      # so the role both spawns now AND keeps looping. rearm covers pinned because
      # a pinned role is perennial (its active state re-dispatches).
      with_pinned_role(
        fn fiber_id, path ->
          assert read_frontmatter(path)["status"] == "open"
          assert {:ok, message} = LifecycleStore.rearm(fiber_id)
          assert message =~ "re-armed"
          assert read_frontmatter(path)["status"] == "active"
        end,
        status: "open"
      )
    end
  end

  describe "surgical frontmatter writes — block scalars + byte-stability (the cmbx regression)" do
    # The real bug that broke science/cmbx/cmbx.md: a lifecycle write round-tripped
    # the whole frontmatter map through a hand-rolled emitter that (a) alphabetically
    # reordered keys and (b) collapsed the `outcome: |-` block scalar into an
    # Elixir-inspect-escaped one-liner the felt CLI could no longer parse — the fiber
    # vanished from the kanban. The write must now be surgical: flip only the targeted
    # key, leave every other byte (the outcome block scalar especially) untouched.
    # Logical outcome content (the string YamlElixir returns after parsing the
    # block scalar — block-scalar indentation is YAML syntax, stripped on parse).
    # Carries every edge case that broke the real file: embedded `"`, a literal
    # `---` line, and unicode.
    @rich_outcome [
                    "First line with an embedded quote — Cail: \"much better\" — and more.",
                    "A literal delimiter line below should survive verbatim:",
                    "---",
                    "Unicode physics: δκ and γκ agree to ~100% within 1σ; S/N ≥ 3 → robust ✓.",
                    "Final line, no trailing newline issues."
                  ]
                  |> Enum.join("\n")

    test "mark_awaiting preserves the outcome block scalar byte-for-byte and only flips status" do
      with_rich_outcome_role(
        fn fiber_id, path, original ->
          assert {:ok, _} = LifecycleStore.mark_awaiting(fiber_id)

          written = File.read!(path)

          # Still parses via the same lib felt/shuttle use — not a mangled doc.
          assert {:ok, parsed} = YamlElixir.read_from_string(frontmatter_of(written))

          # The outcome round-trips to the SAME string the fixture authored — every
          # quote, the literal `---`, and the unicode survive.
          assert parsed["outcome"] == @rich_outcome

          # And it is emitted as a real YAML block scalar, NOT an inspect-escaped
          # one-liner. The original `outcome: |-` header line is untouched, and no
          # `outcome: "..."` quoted form appears.
          assert written =~ "outcome: |-"
          refute written =~ ~s(outcome: ")

          # Surgical: only the intended keys changed. Every other authored line is
          # byte-identical to the original; status flipped open → closed.
          assert_only_keys_changed(original, written, %{
            "status" => "closed",
            "closed-at" => :added,
            "tempered" => :removed
          })
        end,
        status: "open"
      )
    end

    test "writing twice in a row is idempotent — no churn, no key reordering" do
      with_rich_outcome_role(
        fn fiber_id, path, _original ->
          assert {:ok, _} = LifecycleStore.mark_awaiting(fiber_id)
          first = File.read!(path)

          # A second mark_awaiting re-stamps closed-at (a timestamp), so compare the
          # parts that must be byte-stable: everything except the closed-at value.
          assert {:ok, _} = LifecycleStore.mark_awaiting(fiber_id)
          second = File.read!(path)

          assert strip_closed_at(first) == strip_closed_at(second),
                 "repeated writes churned the file:\n#{first}\n--- vs ---\n#{second}"
        end,
        status: "open"
      )
    end

    test "daemon-owned runtime keys nested under shuttle: are evicted, block scalar untouched" do
      with_rich_outcome_role(
        fn fiber_id, path, _original ->
          assert {:ok, _} = LifecycleStore.mark_awaiting(fiber_id)
          written = File.read!(path)

          # The runtime keys seeded inside shuttle: are gone, the durable shuttle
          # keys remain, and the outcome block scalar is intact.
          refute written =~ "next_due_at:"
          refute written =~ "last_run_at:"
          assert written =~ "kind: standing"
          assert {:ok, parsed} = YamlElixir.read_from_string(frontmatter_of(written))
          assert parsed["outcome"] == @rich_outcome
          assert parsed["shuttle"]["kind"] == "standing"
          refute Map.has_key?(parsed["shuttle"], "next_due_at")
          refute Map.has_key?(parsed["shuttle"], "last_run_at")
        end,
        status: "open"
      )
    end
  end

  # Builds a fiber whose frontmatter carries a multi-line `outcome: |-` block
  # scalar with the edge cases that broke the real file (embedded `"`, a literal
  # `---` line, unicode), plus daemon-owned runtime keys nested under shuttle:.
  # Keys are in authored (non-alphabetical) order so a reordering regression is
  # observable. Runs `fun.(fiber_id, path, original_text)`.
  defp with_rich_outcome_role(fun, opts) do
    status = Keyword.get(opts, :status, "open")

    loom =
      Path.join(
        System.tmp_dir!(),
        "shuttle-lifecycle-rich-test-#{System.unique_integer([:positive])}"
      )

    felt_dir = Path.join([loom, ".felt", "science", "cmbx"])
    File.mkdir_p!(felt_dir)
    path = Path.join(felt_dir, "cmbx.md")

    # Indent each logical line by 4 spaces to form the `|-` block-scalar body
    # (matching the real cmbx fiber's 4-space frontmatter style).
    outcome_block =
      @rich_outcome |> String.split("\n") |> Enum.map_join("\n", &("    " <> &1))

    original = """
    ---
    id: 01KTCA2CYQXYRS3F77JZNJD8HZ
    name: cmbx — analysis hub
    status: #{status}
    outcome: |-
    #{outcome_block}
    description: Root fiber and analysis hub.
    shuttle:
      kind: standing
      host: testhost
      agent: claude-opus
      next_due_at: 2026-06-15T08:00:00Z
      last_run_at: 2026-06-14T08:00:00Z
      schedule:
        expr: "0 8 * * *"
        tz: Europe/Paris
    ---

    Body.
    """

    File.write!(path, original)

    prev_loom = System.get_env("FELT_STORES")
    System.put_env("FELT_STORES", loom)

    try do
      fun.("science/cmbx", path, original)
    after
      restore_env("FELT_STORES", prev_loom)
      File.rm_rf(loom)
    end
  end

  # Frontmatter text between the fences (for re-parsing the written file). Splits
  # on the column-0 "\n---" fence the way the production split_frontmatter does,
  # so an indented `---` line INSIDE a block scalar isn't mistaken for the fence.
  defp frontmatter_of("---\n" <> rest) do
    [fm, _body] = :binary.split(rest, "\n---", [])
    fm
  end

  # The daemon-owned runtime keys every lifecycle write evicts from the shuttle:
  # block (seeded in the fixture). Their disappearance is expected, so they're
  # exempt from the "must survive verbatim" check.
  @evicted_runtime_keys ~w(enabled review next_due_at last_run_at session)

  # Assert that, line for line, the written frontmatter differs from the original
  # ONLY in the expected ways: a key whose value should change, an `:added` key,
  # an `:removed` key, or an evicted runtime key. Every other authored line must
  # be byte-identical (this is what catches reordering + block-scalar mangling).
  defp assert_only_keys_changed(original, written, expected) do
    orig_lines = original |> frontmatter_of() |> String.split("\n")
    new_lines = written |> frontmatter_of() |> String.split("\n")

    # Lines that didn't change at all must appear identically in both.
    removed_keys = for {k, :removed} <- expected, do: k
    changed_keys = for {k, v} <- expected, v != :removed, v != :added, do: k

    unchanged_orig =
      Enum.reject(orig_lines, fn line ->
        Enum.any?(removed_keys ++ changed_keys, &top_level_key_line?(line, &1)) or
          evicted_runtime_line?(line)
      end)

    Enum.each(unchanged_orig, fn line ->
      assert line in new_lines,
             "expected unchanged frontmatter line to survive verbatim: #{inspect(line)}"
    end)

    # Changed keys carry their new scalar value.
    for {k, v} <- expected, v not in [:added, :removed] do
      assert Enum.any?(new_lines, &(&1 == "#{k}: #{v}")),
             "expected `#{k}: #{v}` in written frontmatter"
    end
  end

  # A (possibly indented) line declaring one of the evicted runtime keys.
  defp evicted_runtime_line?(line) do
    trimmed = String.trim_leading(line)
    Enum.any?(@evicted_runtime_keys, &String.match?(trimmed, ~r{^#{&1}:(?:\s|$)}))
  end

  defp top_level_key_line?(line, key) do
    String.match?(line, ~r{^#{Regex.escape(key)}:(?:\s|$)})
  end

  # Drop the closed-at line (its value is a fresh timestamp each write) so two
  # writes can be compared for structural byte-stability.
  defp strip_closed_at(text) do
    text
    |> String.split("\n")
    |> Enum.reject(&String.starts_with?(&1, "closed-at:"))
    |> Enum.join("\n")
  end

  # Builds a real on-disk felt fiber (resolvable by the felt CLI) in the
  # new-model awaiting shape, points FELT_STORES at the fixture, and runs
  # `fun.(fiber_id, path)`. There is no runtime store anymore (slice 6): the
  # felt document carries the entire lifecycle.
  defp with_doc_awaiting_role(fun, opts \\ []) do
    status = Keyword.get(opts, :status, "closed")
    tempered = Keyword.get(opts, :tempered, nil)

    loom =
      Path.join(
        System.tmp_dir!(),
        "shuttle-lifecycle-doc-test-#{System.unique_integer([:positive])}"
      )

    felt_dir = Path.join([loom, ".felt", "life", "french", "practice"])
    File.mkdir_p!(felt_dir)
    path = Path.join(felt_dir, "practice.md")

    tempered_line = if is_nil(tempered), do: "", else: "tempered: #{tempered}\n"

    File.write!(path, """
    ---
    name: Daily French practice
    status: #{status}
    #{tempered_line}shuttle:
      kind: standing
      host: testhost
      agent: claude-sonnet
      schedule:
        expr: "0 8 * * *"
        tz: Europe/Paris
    ---

    Body.
    """)

    prev_loom = System.get_env("FELT_STORES")
    System.put_env("FELT_STORES", loom)

    try do
      fun.("life/french/practice", path)
    after
      restore_env("FELT_STORES", prev_loom)
      File.rm_rf(loom)
    end
  end

  # Pinned variant of with_doc_awaiting_role: a schedule-less pinned block. The
  # pinned role's parked rest state is status:open on the strip (Option D);
  # status:active is the looping state.
  defp with_pinned_role(fun, opts) do
    status = Keyword.get(opts, :status, "open")
    tempered = Keyword.get(opts, :tempered, nil)

    loom =
      Path.join(
        System.tmp_dir!(),
        "shuttle-lifecycle-pin-test-#{System.unique_integer([:positive])}"
      )

    felt_dir = Path.join([loom, ".felt", "ai-futures", "tokenmaxxing", "operator"])
    File.mkdir_p!(felt_dir)
    path = Path.join(felt_dir, "operator.md")

    tempered_line = if is_nil(tempered), do: "", else: "tempered: #{tempered}\n"

    File.write!(path, """
    ---
    name: Operator
    status: #{status}
    #{tempered_line}shuttle:
      kind: pinned
      host: testhost
      agent: claude-opus
    ---

    Body.
    """)

    prev_loom = System.get_env("FELT_STORES")
    System.put_env("FELT_STORES", loom)

    try do
      fun.("ai-futures/tokenmaxxing/operator", path)
    after
      restore_env("FELT_STORES", prev_loom)
      File.rm_rf(loom)
    end
  end

  defp read_frontmatter(path) do
    [_, fm, _] = File.read!(path) |> String.split("---", parts: 3)
    YamlElixir.read_from_string!(fm)
  end
end
