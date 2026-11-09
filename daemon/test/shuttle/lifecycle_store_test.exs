defmodule Shuttle.LifecycleStoreTest do
  use ExUnit.Case, async: true

  alias Shuttle.LifecycleStore

  @dispatched "    dispatched_at: 2026-01-02T00:00:00Z\n    run_id: scheduled-2\n"

  describe "conclude/2 — the standing-exit writer" do
    test "stamps the unconcluded run's handoff and leaves the role armed" do
      with_standing_doc(fn fiber_id, path ->
        assert {:ok, message} = conclude(fiber_id)
        assert message =~ "concluded"

        fm = read_frontmatter(path)
        assert fm["status"] == "active"
        refute Map.has_key?(fm, "closed-at")
        refute Map.has_key?(fm, "tempered")
        runtime = fm["shuttle"]["runtime"]
        assert is_binary(runtime["handed_off_at"])
        assert runtime["thread_exit_verb"] == "handed off"
        assert runtime["custom_marker"] == "keep"
      end)
    end

    test "recovery stamps the handoff at the run's dispatch instant" do
      with_standing_doc(fn fiber_id, path ->
        assert {:ok, _} = conclude(fiber_id, recovery: true)

        {:ok, at, _} =
          DateTime.from_iso8601(read_frontmatter(path)["shuttle"]["runtime"]["handed_off_at"])

        assert DateTime.compare(at, ~U[2026-01-02 00:00:00Z]) == :eq
      end)
    end

    test "leaves handed-off, undispatched, paused, retired and foreign documents byte-identical" do
      for opts <- [
            [runtime: @dispatched <> "    handed_off_at: 2026-01-03T00:00:00Z\n"],
            [runtime: ""],
            [status: "open"],
            [status: "closed", tempered: false],
            [host: "other-host"]
          ] do
        with_standing_doc(
          fn id, path ->
            before = File.read!(path)
            assert {:ok, message} = conclude(id)
            assert message =~ "as it stands"
            assert File.read!(path) == before
          end,
          opts
        )
      end
    end

    test "a newer run than the observed one is left as it stands" do
      with_standing_doc(fn fiber_id, path ->
        {:ok, _, _, fm, _} = Shuttle.FiberDoc.read_path(path)
        observed = put_in(fm, ["shuttle", "runtime", "run_id"], "scheduled-1")
        before = File.read!(path)
        assert {:ok, _} = conclude(fiber_id, observed: observed)
        assert File.read!(path) == before
      end)
    end
  end

  describe "the standing-only writer refuses a oneshot" do
    # conclude belongs to the cron lifecycle. A oneshot — and a `kind: pinned`,
    # read as one — is refused by kind and left alone.
    for kind <- ["oneshot", "pinned"] do
      test "conclude leaves a #{kind} document untouched" do
        with_oneshot_doc(
          fn fiber_id, path ->
            before = File.read!(path)
            assert {:error, msg} = conclude(fiber_id)
            assert msg =~ "standing"
            assert File.read!(path) == before
          end,
          status: "active",
          kind: unquote(kind)
        )
      end
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

    test "conclude preserves the outcome block scalar byte-for-byte and only adds run markers" do
      with_rich_outcome_role(
        fn fiber_id, path, original ->
          assert {:ok, _} = conclude(fiber_id)

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

          # Surgical: every authored line is byte-identical to the original;
          # the run's handoff markers are added under shuttle.runtime.
          assert_only_keys_changed(original, written, %{})
          assert written =~ "handed_off_at:"
        end,
        status: "active"
      )
    end

    test "writing twice in a row is idempotent — no churn, no key reordering" do
      with_rich_outcome_role(
        fn fiber_id, path, _original ->
          assert {:ok, _} = conclude(fiber_id)
          first = File.read!(path)

          # A concluded run is not another worker exit.
          assert {:ok, _} = conclude(fiber_id)
          second = File.read!(path)

          assert first == second,
                 "repeated writes churned the file:\n#{first}\n--- vs ---\n#{second}"
        end,
        status: "active"
      )
    end

    test "daemon-owned runtime keys nested under shuttle: are evicted, block scalar untouched" do
      with_rich_outcome_role(
        fn fiber_id, path, _original ->
          assert {:ok, _} = conclude(fiber_id)
          written = File.read!(path)

          # The runtime keys seeded inside shuttle: are gone, the durable shuttle
          # keys remain, and the outcome block scalar is intact.
          refute written =~ "next_due_at:"
          refute written =~ "last_run_at:"
          assert written =~ "kind: standing"
          assert {:ok, parsed} = YamlElixir.read_from_string(frontmatter_of(written))
          assert parsed["outcome"] == @rich_outcome
          assert parsed["shuttle"]["kind"] == "standing"
          assert parsed["shuttle"]["runtime"]["custom_marker"] == "keep"
          assert parsed["shuttle"]["runtime"]["thread_exit_verb"] == "handed off"
          refute Map.has_key?(parsed["shuttle"], "next_due_at")
          refute Map.has_key?(parsed["shuttle"], "last_run_at")
        end,
        status: "active"
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
      host: test-host
      agent: claude-opus
      runtime:
        custom_marker: keep
        dispatched_at: 2026-01-02T00:00:00Z
        run_id: scheduled-2
      next_due_at: 2026-06-15T08:00:00Z
      last_run_at: 2026-06-14T08:00:00Z
      schedule:
        expr: "0 8 * * *"
        tz: Europe/Paris
    ---

    Body.
    """

    File.write!(path, original)

    Shuttle.Test.Env.put_env("SHUTTLE_STORES", loom)

    try do
      fun.("science/cmbx", path, original)
    after
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

  defp conclude(fiber_id, opts \\ []),
    do: LifecycleStore.conclude(fiber_id, Keyword.put_new(opts, :own_host_id, "test-host"))

  # Builds a real on-disk felt fiber (resolvable by the felt CLI): a standing
  # constitution with an unconcluded run on record unless `:runtime` replaces
  # its run markers. Points SHUTTLE_STORES at the fixture and runs
  # `fun.(fiber_id, path)`.
  defp with_standing_doc(fun, opts \\ []) do
    status = Keyword.get(opts, :status, "active")
    tempered = Keyword.get(opts, :tempered, nil)
    host = Keyword.get(opts, :host, "test-host")
    runtime = Keyword.get(opts, :runtime, @dispatched)

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
    id: 01KTCA2CYQXYRS3F77JZNJD8HY
    name: Daily French practice
    status: #{status}
    #{tempered_line}shuttle:
      kind: standing
      host: #{host}
      agent: claude-sonnet
      runtime:
        custom_marker: keep
    #{runtime}  schedule:
        expr: "0 8 * * *"
        tz: Europe/Paris
    ---

    Body.
    """)

    Shuttle.Test.Env.put_env("SHUTTLE_STORES", loom)

    try do
      fun.("life/french/practice", path)
    after
      File.rm_rf(loom)
    end
  end

  # Schedule-less variant of with_standing_doc: a oneshot block (or the
  # legacy kind passed as :kind).
  defp with_oneshot_doc(fun, opts) do
    status = Keyword.get(opts, :status, "open")
    kind = Keyword.get(opts, :kind, "oneshot")
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
      kind: #{kind}
      host: test-host
      agent: claude-opus
    ---

    Body.
    """)

    Shuttle.Test.Env.put_env("SHUTTLE_STORES", loom)

    try do
      fun.("ai-futures/tokenmaxxing/operator", path)
    after
      File.rm_rf(loom)
    end
  end

  defp read_frontmatter(path) do
    [_, fm, _] = File.read!(path) |> String.split("---", parts: 3)
    YamlElixir.read_from_string!(fm)
  end
end
