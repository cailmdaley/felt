defmodule Shuttle.FiberDoc do
  @moduledoc """
  Read fiber frontmatter and prepare surgical edits. Snapshot-based writes use
  Shuttle's locked compare-and-swap writer; a changed source document refuses
  the edit rather than replacing another writer's content. Standing lifecycle
  decisions use `Shuttle.LifecycleStore`'s run-conditional writer.
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
      # A wedged felt is not absence — say so, never "not found" (a caller
      # acting on "not found" would write against the wrong store).
      {:error, :timeout} -> {:error, "felt timed out resolving #{fiber_id}"}
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
    with {:ok, text} <- Shuttle.FS.read(path),
         {:ok, frontmatter_yaml, body} <- split_frontmatter(text),
         {:ok, frontmatter} <- parse_frontmatter(frontmatter_yaml, path) do
      {:ok, path, frontmatter_yaml, frontmatter, body}
    else
      {:error, reason} when is_atom(reason) -> {:error, to_string(reason)}
      {:error, reason} when is_binary(reason) -> {:error, reason}
      {:error, reason} -> {:error, inspect(reason)}
    end
  end

  # Malformed frontmatter does not always come back as `{:error, _}`: some
  # documents RAISE instead — YamlElixir on pathological input, and our own
  # key normalization on YAML that parses to a non-map (a bare list) or with
  # a non-scalar mapping key (`? [a, b]`), where `stringify_keys/1` blows up.
  # A user hand-edits a fiber; the daemon must return a readable error, not
  # crash the Poller GenServer mid-handle_call. Same `{:error, binary}` shape
  # as every other failure of `read_path/1`. The rescue spans ONLY the
  # parse + normalize — a bug in the file read or splitting above must crash
  # loudly, not masquerade as YAML corruption.
  defp parse_frontmatter(frontmatter_yaml, path) do
    case YamlElixir.read_from_string(frontmatter_yaml) do
      {:ok, frontmatter} ->
        {:ok, (frontmatter || %{}) |> stringify_keys() |> Shuttle.FiberDocuments.normalize()}

      {:error, _} = error ->
        error
    end
  rescue
    error -> {:error, "malformed fiber document #{path}: #{Exception.message(error)}"}
  end

  @doc """
  Apply `ops` only if the document still matches `raw_fm` and `body`. Shuttle
  checks the source digest after acquiring the canonical felt lock and commits
  the patch atomically. A stale or missing document raises without writing.
  """
  @spec write!(String.t(), String.t(), String.t(), [FrontmatterEdit.op()], keyword()) :: :ok
  def write!(path, raw_fm, body, ops, opts \\ []) do
    original_body = Keyword.get(opts, :before_body, body)
    original = "---\n" <> ensure_single_trailing_newline(raw_fm) <> "---" <> original_body
    new_fm = raw_fm |> FrontmatterEdit.apply(ops) |> ensure_single_trailing_newline()

    updated = "---\n" <> new_fm <> "---" <> body <> ensure_trailing_newline(body)

    case replace(path, original, updated) do
      :ok -> :ok
      {:error, reason} -> raise reason
    end
  end

  @doc "Replace an exact source image under the canonical lock, refusing concurrent edits."
  def replace(path, original, updated) do
    request = %{
      "path" => path,
      "before_sha256" => :crypto.hash(:sha256, original) |> Base.encode16(case: :lower),
      "after" => IO.iodata_to_binary(updated)
    }

    case Shuttle.CLI.run(["patch-document"],
           input: Jason.encode!(request) <> "\n",
           timeout_ms: :infinity
         ) do
      {:ok, _} -> :ok
      failure -> {:error, "conditional document patch failed: #{inspect(failure)}"}
    end
  end

  defp resolve_path(fiber_id) do
    case FeltStores.resolve_fiber(fiber_id) do
      {:ok, %{path: path}} -> {:ok, path}
      {:error, _} = error -> error
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

  @doc """
  Deeply string-key a decoded map — every nested map's keys too, lists mapped
  element-wise, scalars passed through. The shape felt's frontmatter wants,
  whether it arrived from YAML or from a JSON request body.
  """
  def stringify_keys(map),
    do: Map.new(map, fn {key, value} -> {to_string(key), stringify_value(value)} end)

  defp stringify_value(value) when is_map(value), do: stringify_keys(value)
  defp stringify_value(value) when is_list(value), do: Enum.map(value, &stringify_value/1)
  defp stringify_value(value), do: value
end
