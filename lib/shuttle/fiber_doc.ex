defmodule Shuttle.FiberDoc do
  @moduledoc """
  Low-level surgical read/write of a fiber's frontmatter document — the single
  primitive the daemon uses to flip fields on a felt `.md` without disturbing the
  rest of the file.

  Shared by two consumers:

    * `Shuttle.LifecycleStore` — felt-native lifecycle fields (`status`,
      `tempered`, `closed-at`, `outcome`) on accept / resume / mark-awaiting /
      park / rearm.
    * `Shuttle.Continuation` — the runtime continuation fields nested under
      `shuttle:` (`session_uuid`, `dispatched_at`, `run_id`, `handed_off_at`)
      stamped at dispatch and at clean exit.

  The write path edits the raw frontmatter TEXT directly (via
  `Shuttle.FrontmatterEdit`) and never round-trips the parsed map through an
  emitter — that round-trip used to reorder keys (churn across machines) and
  collapse multi-line block scalars like `outcome: |-` into
  `inspect/1`-escaped one-liners the felt CLI could no longer parse (the fiber
  vanished from the kanban). Writes are atomic (tmp + rename).
  """

  alias Shuttle.{FeltStores, FrontmatterEdit}

  @doc """
  Read a fiber by id, returning `{:ok, path, raw_fm, frontmatter, body}`.

  `raw_fm` is the verbatim frontmatter text (no `---` fences) for surgical,
  byte-stable writes; `frontmatter` is the parsed, string-keyed map for gates and
  field reads; `body` is everything after the closing fence.
  """
  @spec read(String.t()) ::
          {:ok, String.t(), String.t(), map(), String.t()} | {:error, String.t()}
  def read(fiber_id) when is_binary(fiber_id) do
    case resolve_path(fiber_id) do
      {:ok, path} -> read_path(path)
      {:error, :not_found} -> {:error, "fiber not found: #{fiber_id}"}
    end
  end

  @doc """
  Read a fiber by its on-disk `.md` path (skips id resolution), returning
  `{:ok, path, raw_fm, frontmatter, body}`. Used when the caller already holds the
  path (e.g. the dispatcher carries `fiber["path"]` from the poll).
  """
  @spec read_path(String.t()) ::
          {:ok, String.t(), String.t(), map(), String.t()} | {:error, String.t()}
  def read_path(path) when is_binary(path) do
    with {:ok, text} <- File.read(path),
         {:ok, frontmatter_yaml, body} <- split_frontmatter(text),
         {:ok, frontmatter} <- YamlElixir.read_from_string(frontmatter_yaml) do
      {:ok, path, frontmatter_yaml, stringify_keys(frontmatter || %{}), body}
    else
      {:error, reason} when is_atom(reason) -> {:error, to_string(reason)}
      {:error, reason} when is_binary(reason) -> {:error, reason}
      {:error, reason} -> {:error, inspect(reason)}
    end
  end

  @doc """
  Read a fiber, apply the surgical edit `ops`, and write it back atomically.

  Returns `:ok` or `{:error, reason}` (propagating a read failure). The two-step
  read-then-write is the common path for both consumers.
  """
  @spec edit(String.t(), [FrontmatterEdit.op()]) :: :ok | {:error, String.t()}
  def edit(fiber_id, ops) when is_binary(fiber_id) and is_list(ops) do
    with {:ok, path, raw_fm, _frontmatter, body} <- read(fiber_id) do
      write!(path, raw_fm, body, ops)
    end
  end

  @doc "As `edit/2`, but for a known `.md` path (skips id resolution)."
  @spec edit_path(String.t(), [FrontmatterEdit.op()]) :: :ok | {:error, String.t()}
  def edit_path(path, ops) when is_binary(path) and is_list(ops) do
    with {:ok, ^path, raw_fm, _frontmatter, body} <- read_path(path) do
      write!(path, raw_fm, body, ops)
    end
  end

  @doc """
  Atomic (tmp + rename), surgical write: apply the edit `ops` to the raw
  frontmatter text and reconstruct the file. Only the targeted frontmatter lines
  change; the `body` is re-emitted verbatim.

  Byte-stability of the fences: `split_frontmatter` splits on `"\\n---"`, so the
  newline that terminated the last frontmatter line is consumed by the split, and
  `body` begins with the `"\\n"` that terminates the closing `---` fence line. We
  therefore normalize the frontmatter to exactly one trailing newline and write
  the closing fence as bare `"---"` (no newline) — `body`'s leading `"\\n"`
  completes it. Writing `"---\\n"` here instead would double the newline and grow
  a blank line after the fence on every write.
  """
  @spec write!(String.t(), String.t(), String.t(), [FrontmatterEdit.op()]) :: :ok
  def write!(path, raw_fm, body, ops) do
    new_fm = raw_fm |> FrontmatterEdit.apply(ops) |> ensure_single_trailing_newline()
    tmp = path <> ".tmp"
    File.write!(tmp, ["---\n", new_fm, "---", body, ensure_trailing_newline(body)])
    File.rename!(tmp, path)
    :ok
  end

  defp resolve_path(fiber_id) do
    case FeltStores.resolve_fiber(fiber_id) do
      {:ok, %{path: path}} -> {:ok, path}
      {:error, :not_found} -> {:error, :not_found}
    end
  end

  defp split_frontmatter("---\n" <> rest) do
    case :binary.split(rest, "\n---", []) do
      [frontmatter, body] -> {:ok, frontmatter, body}
      _ -> {:error, "missing closing frontmatter delimiter"}
    end
  end

  defp split_frontmatter(_), do: {:error, "missing opening frontmatter delimiter"}

  defp ensure_single_trailing_newline(text), do: String.trim_trailing(text, "\n") <> "\n"

  defp ensure_trailing_newline(""), do: ""
  defp ensure_trailing_newline(body), do: if(String.ends_with?(body, "\n"), do: "", else: "\n")

  defp stringify_keys(map),
    do: Map.new(map, fn {key, value} -> {to_string(key), stringify_value(value)} end)

  defp stringify_value(value) when is_map(value), do: stringify_keys(value)
  defp stringify_value(value) when is_list(value), do: Enum.map(value, &stringify_value/1)
  defp stringify_value(value), do: value
end
