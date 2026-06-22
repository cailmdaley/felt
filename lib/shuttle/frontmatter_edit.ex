defmodule Shuttle.FrontmatterEdit do
  @moduledoc """
  Surgical, line-level edits to YAML frontmatter text.

  The lifecycle store flips one or two frontmatter fields on each transition
  (`status`, `tempered`, `closed-at`, plus a handful of daemon-owned runtime
  keys nested under `shuttle:`). Round-tripping the whole document through a
  hand-rolled emitter used to corrupt it: keys got alphabetically reordered on
  every write (churn across machines), and multi-line block scalars like
  `outcome: |-` were collapsed into Elixir-`inspect`-escaped one-liners that the
  felt CLI could no longer parse — the fiber vanished from the kanban.

  This module instead operates on the raw frontmatter text directly. It parses
  the text into top-level entries (each a `key:` line plus its deeper-indented
  continuation lines — block scalars and nested maps are carried as opaque,
  untouched spans), applies the requested edits to just the targeted lines, and
  re-emits every other byte verbatim. The contract is byte-stability: a
  no-op-shaped sequence of edits leaves the file identical, and a real edit
  touches only the affected key's line(s).

  Operations:

    * `{:put, key, value}` — set/replace a top-level scalar key's value (e.g.
      `status: active`). Appends the key at the end if absent. `value` is
      emitted with `FrontmatterEdit.scalar/1` (real YAML quoting, never
      `inspect/1`).
    * `{:delete, key}` — drop a top-level key and its whole value span.
    * `{:delete_nested, parent, child}` — drop a child key (and its span) from
      within the `parent:` block (e.g. a runtime key under `shuttle:`).
    * `{:put_nested, parent, child, value}` — set/replace a scalar `child:` key
      within the `parent:` block (e.g. a runtime key under `shuttle:`). The
      child's indentation is inherited from the block's existing children (so it
      matches felt's 4-space and the Go writer's 2-space alike); a fresh child is
      appended at the end of the block's span. Creates the `parent:` block itself
      if absent. This is the write counterpart to `:delete_nested` — together
      they let the daemon stamp the continuation fields
      (`session_uuid`/`dispatched_at`/`handed_off_at`) into the `shuttle:` block.

  `apply/2` returns the new frontmatter text. The lifecycle store reconstructs
  the file as `"---\n" <> apply(raw_fm, ops) <> "---\n" <> body`.
  """

  @typedoc "A single surgical edit operation."
  @type op ::
          {:put, String.t(), term()}
          | {:delete, String.t()}
          | {:delete_nested, String.t(), String.t()}
          | {:put_nested, String.t(), String.t(), term()}

  @doc """
  Apply a list of `op`s to the raw frontmatter `text`, returning new text.

  The text is the frontmatter body only — no `---` fences. Trailing newline of
  the original is preserved.
  """
  @spec apply(String.t(), [op()]) :: String.t()
  def apply(text, ops) when is_binary(text) and is_list(ops) do
    {lines, trailing} = split_lines(text)

    lines
    |> parse_entries()
    |> apply_ops(ops)
    |> render_entries()
    |> Kernel.<>(trailing)
  end

  # ── YAML scalar emission (real quoting, never Elixir inspect/1) ──────────────

  @doc """
  Render a scalar `value` as a single-line YAML scalar.

  Bare tokens (the felt key vocabulary: idents, ISO timestamps, slugs) pass
  through unquoted; everything else is double-quoted with the minimal YAML
  escapes (`\\`, `"`, control chars). This is the value used by `{:put, ...}`,
  and it deliberately does NOT use `inspect/1` (which would emit Elixir string
  syntax, not YAML).
  """
  @spec scalar(term()) :: String.t()
  def scalar(true), do: "true"
  def scalar(false), do: "false"
  def scalar(nil), do: "null"
  def scalar(value) when is_integer(value), do: Integer.to_string(value)
  def scalar(value) when is_float(value), do: Float.to_string(value)

  def scalar(value) when is_binary(value) do
    cond do
      value == "" -> ~s("")
      bare?(value) -> value
      true -> yaml_double_quote(value)
    end
  end

  # A bare (unquoted) YAML scalar: the felt-key vocabulary — identifiers,
  # slugs, ISO-8601 timestamps. Anything outside this gets double-quoted so the
  # emitted value parses back to the same string.
  defp bare?(value), do: String.match?(value, ~r{^[A-Za-z0-9_/.\-:@+]+$})

  defp yaml_double_quote(value) do
    escaped =
      value
      |> String.replace("\\", "\\\\")
      |> String.replace("\"", "\\\"")
      |> String.replace("\n", "\\n")
      |> String.replace("\t", "\\t")

    ~s(") <> escaped <> ~s(")
  end

  # ── fresh emission (map → YAML block) ────────────────────────────────────────

  @doc """
  Render a map of frontmatter keys to a fresh YAML block — the emit counterpart
  to `apply/2`'s surgical edit. Used by the fiber-CREATION path to splice
  non-native keys (the `shuttle:` block, an authored `outcome`, …) into a newly
  minted fiber. Nested maps recurse; lists become `- item` sequences; multi-line
  strings become `|-` block scalars (never `inspect/1`-escaped one-liners — the
  corruption that vanished cmbx); single-line values use `scalar/1`. Keys are
  emitted in sorted order: a fresh map carries no authored order to preserve, and
  determinism keeps creation byte-stable.
  """
  @spec render(map()) :: String.t()
  def render(map) when is_map(map), do: render_map(map, 0)

  defp render_map(map, indent) do
    map
    |> Enum.sort_by(fn {key, _} -> to_string(key) end)
    |> Enum.map_join("", fn {key, value} -> render_field(to_string(key), value, indent) end)
  end

  defp render_field(key, value, indent) when is_map(value) do
    "#{indent(indent)}#{key}:\n" <> render_map(value, indent + 2)
  end

  defp render_field(key, value, indent) when is_list(value) do
    "#{indent(indent)}#{key}:\n" <>
      Enum.map_join(value, "", fn item -> "#{indent(indent + 2)}- #{scalar(item)}\n" end)
  end

  defp render_field(key, value, indent) when is_binary(value) do
    if String.contains?(value, "\n") do
      render_block_scalar(key, value, indent)
    else
      "#{indent(indent)}#{key}: #{scalar(value)}\n"
    end
  end

  defp render_field(key, value, indent), do: "#{indent(indent)}#{key}: #{scalar(value)}\n"

  # A multi-line string as a `|-` block scalar (strip-chomped: no trailing blank
  # line), each content line indented two past the key. Blank lines stay blank so
  # they don't carry trailing whitespace.
  defp render_block_scalar(key, value, indent) do
    child = indent + 2

    body =
      value
      |> String.trim_trailing("\n")
      |> String.split("\n")
      |> Enum.map_join("\n", fn
        "" -> ""
        line -> indent(child) <> line
      end)

    "#{indent(indent)}#{key}: |-\n#{body}\n"
  end

  defp indent(n), do: String.duplicate(" ", n)

  # ── parsing ──────────────────────────────────────────────────────────────────

  # Split the text into lines, remembering whether it ended with a newline so we
  # can re-emit it byte-identically. We split on "\n" without trimming so an
  # empty trailing line (text ending in "\n") yields a final "" element we drop.
  defp split_lines(""), do: {[], ""}

  defp split_lines(text) do
    trailing = if String.ends_with?(text, "\n"), do: "\n", else: ""

    lines =
      text
      |> String.split("\n")
      |> drop_trailing_empty(trailing)

    {lines, trailing}
  end

  defp drop_trailing_empty(parts, "\n"), do: List.delete_at(parts, -1)
  defp drop_trailing_empty(parts, ""), do: parts

  # Group raw lines into top-level entries. A top-level entry begins at a line
  # whose first non-space column is 0 and that looks like `key:` or `key: value`.
  # Every following line that is more-indented (or blank) belongs to that entry's
  # value span (block scalars, nested maps, flow continuations) and is carried
  # verbatim. Lines before the first key (rare; e.g. a stray comment) are kept as
  # a preamble entry with key `nil`.
  defp parse_entries(lines) do
    lines
    |> Enum.reduce({[], nil}, fn line, {entries, current} ->
      case top_level_key(line) do
        {:ok, key} ->
          {push(entries, current), %{key: key, lines: [line]}}

        :no ->
          case current do
            nil -> {push(entries, %{key: nil, lines: [line]}), nil}
            %{lines: ls} = c -> {entries, %{c | lines: [line | ls]}}
          end
      end
    end)
    |> then(fn {entries, current} -> push(entries, current) end)
    |> Enum.reverse()
    |> Enum.map(fn %{lines: ls} = e -> %{e | lines: Enum.reverse(ls)} end)
  end

  defp push(entries, nil), do: entries
  defp push(entries, entry), do: [entry | entries]

  # A top-level key line: zero indentation and a `key:` (optionally followed by a
  # value). Returns the key string. Comments and blank lines are not keys.
  defp top_level_key(line) do
    case Regex.run(~r{^([A-Za-z0-9_][A-Za-z0-9_\-./]*):(?:\s|$)}, line) do
      [_, key] -> {:ok, key}
      nil -> :no
    end
  end

  # ── applying ops ─────────────────────────────────────────────────────────────

  defp apply_ops(entries, ops), do: Enum.reduce(ops, entries, &apply_op(&2, &1))

  defp apply_op(entries, {:put, key, value}) do
    line = "#{key}: #{scalar(value)}"

    if Enum.any?(entries, &(&1.key == key)) do
      Enum.map(entries, fn
        %{key: ^key} -> %{key: key, lines: [line]}
        other -> other
      end)
    else
      entries ++ [%{key: key, lines: [line]}]
    end
  end

  defp apply_op(entries, {:delete, key}) do
    Enum.reject(entries, &(&1.key == key))
  end

  defp apply_op(entries, {:delete_nested, parent, child}) do
    Enum.map(entries, fn
      %{key: ^parent, lines: lines} = e -> %{e | lines: drop_nested_key(lines, child)}
      other -> other
    end)
  end

  defp apply_op(entries, {:put_nested, parent, child, value}) do
    if Enum.any?(entries, &(&1.key == parent)) do
      Enum.map(entries, fn
        %{key: ^parent, lines: lines} = e -> %{e | lines: put_nested_key(lines, child, value)}
        other -> other
      end)
    else
      # No parent block yet — create it with the single child indented two past
      # the (zero-indent) parent key. Appended at the end, like a fresh top-level
      # key.
      entries ++ [%{key: parent, lines: ["#{parent}:", "  #{child}: #{scalar(value)}"]}]
    end
  end

  # Within a block's lines (the `parent:` line followed by indented children),
  # drop the `child:` line and any deeper-indented continuation lines under it.
  # The child's own indentation defines the span: subsequent lines that are
  # blank or indented strictly deeper than the child line belong to its value.
  defp drop_nested_key([header | rest], child) do
    [header | reject_child_span(rest, child)]
  end

  # Within a block's lines (`parent:` header followed by indented children), set
  # `child:` to `value`. If the child already exists, replace its line in place
  # preserving its own indentation (so a re-stamp is byte-stable but for the
  # value). Otherwise append a fresh `child: value` line, indented to match the
  # block's existing children (felt writes 4 spaces, the Go schema writer 2 — we
  # inherit whichever this block already uses), at the end of the block span.
  defp put_nested_key([header | rest] = lines, child, value) do
    if Enum.any?(rest, &match_child_header?(&1, child)) do
      [
        header
        | Enum.map(rest, fn line ->
            if match_child_header?(line, child) do
              "#{String.duplicate(" ", indent_of(line))}#{child}: #{scalar(value)}"
            else
              line
            end
          end)
      ]
    else
      new_line = "#{String.duplicate(" ", nested_child_indent(rest))}#{child}: #{scalar(value)}"
      insert_before_trailing_blanks(lines, new_line)
    end
  end

  # Append `new_line` after the block's last non-blank line, keeping any trailing
  # blank lines (which `parse_entries` folds into the block span) after it — so a
  # fresh child lands inside the block, not below a stray blank.
  defp insert_before_trailing_blanks(lines, new_line) do
    {trailing_blanks, kept} =
      lines
      |> Enum.reverse()
      |> Enum.split_while(&blank?/1)

    Enum.reverse(kept) ++ [new_line] ++ Enum.reverse(trailing_blanks)
  end

  # The indentation (column count) the block's children sit at: the leading
  # whitespace of its first non-blank child line, or 2 when the block has no
  # children yet (a bare `parent:` header).
  defp nested_child_indent(child_lines) do
    case Enum.find(child_lines, fn line -> not blank?(line) end) do
      nil -> 2
      line -> indent_of(line)
    end
  end

  defp reject_child_span(lines, child) do
    {kept, _} =
      Enum.reduce(lines, {[], :scanning}, fn line, {kept, state} ->
        case state do
          # Inside the dropped child's value span: keep swallowing blank or
          # deeper-indented lines; the first line at/above the child's indent
          # ends the span and is re-examined as a normal line.
          {:dropping, child_indent} ->
            if blank?(line) or indent_of(line) > child_indent do
              {kept, {:dropping, child_indent}}
            else
              step(line, child, kept)
            end

          :scanning ->
            step(line, child, kept)
        end
      end)

    Enum.reverse(kept)
  end

  # One line of the scan: if it's the child header, start dropping its span;
  # otherwise keep it.
  defp step(line, child, kept) do
    if match_child_header?(line, child) do
      {kept, {:dropping, indent_of(line)}}
    else
      {[line | kept], :scanning}
    end
  end

  defp match_child_header?(line, child) do
    Regex.match?(~r{^\s+#{Regex.escape(child)}:(?:\s|$)}, line)
  end

  defp indent_of(line) do
    case Regex.run(~r{^(\s*)}, line) do
      [_, ws] -> String.length(ws)
      _ -> 0
    end
  end

  defp blank?(line), do: String.trim(line) == ""

  # ── rendering ────────────────────────────────────────────────────────────────

  # Join lines with "\n" separators only (no terminator) — `apply/2` re-appends
  # the original's `trailing` ("\n" iff it ended with one). This keeps the
  # final-newline byte-identical to the input.
  defp render_entries(entries) do
    entries
    |> Enum.flat_map(& &1.lines)
    |> Enum.join("\n")
  end
end
