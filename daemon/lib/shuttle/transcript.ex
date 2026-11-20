defmodule Shuttle.Transcript do
  @moduledoc """
  Resolve a harness-owned session UUID to its native transcript file.

  This module deliberately does not parse or normalize transcript records. The
  harness file is the source of truth; Shuttle only identifies it and exposes
  the path or exact bytes to a caller that wants to use ordinary `jq`, `rg`,
  or the harness-specific recipes.
  """

  alias Shuttle.{Poller, SessionLedger}

  @search_order [
    Shuttle.Harness.Claude,
    Shuttle.Harness.Pi,
    Shuttle.Harness.Codex,
    Shuttle.Harness.Antigravity
  ]
  @head_lines 200

  @uuid ~r/\A[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\z/

  @typedoc "A session availability receipt, with string keys at the HTTP edge."
  @type receipt :: %{
          session: String.t(),
          availability: :identity_pending | :available_local | :transcript_missing,
          host: String.t() | nil,
          harness: String.t() | nil,
          source_path: String.t() | nil,
          byte_count: non_neg_integer() | nil,
          sha256: String.t() | nil
        }

  @doc "True when `session` is a canonical UUID safe to use in harness paths."
  @spec valid_session?(term()) :: boolean()
  def valid_session?(session) when is_binary(session), do: Regex.match?(@uuid, session)
  def valid_session?(_), do: false

  @doc """
  Resolve a session on this daemon.

  A transcript already present on disk is authoritative even when its ledger
  row has not arrived yet; this is important during the short capture/backfill
  race. A missing file with a ledger row is `:transcript_missing`, while a UUID
  with neither is `:transcript_missing`; `:identity_pending` is reserved for
  an active dispatch whose harness UUID has not been captured yet, rather than
  guessed from an arbitrary UUID.

  Opts (for tests): `:root`, `:pi_root`, `:codex_root`, and `:ledger_path`.
  """
  @spec resolve(String.t(), keyword()) :: receipt()
  def resolve(session, opts \\ []) when is_binary(session) do
    ledger_path = Keyword.get(opts, :ledger_path, SessionLedger.default_path())
    ledger = SessionLedger.latest_for_session(session, path: ledger_path)

    case path(session, opts) do
      path when is_binary(path) ->
        %{
          session: session,
          availability: :available_local,
          host: Poller.own_host_id(),
          harness: harness_for(path, opts),
          source_path: path,
          byte_count: byte_count(path),
          sha256: sha256(path)
        }

      nil when is_map(ledger) ->
        %{
          session: session,
          availability: :transcript_missing,
          host: ledger["host"],
          harness: ledger["harness"],
          source_path: nil,
          byte_count: nil,
          sha256: nil
        }

      nil ->
        %{
          session: session,
          availability: :transcript_missing,
          host: nil,
          harness: nil,
          source_path: nil,
          byte_count: nil,
          sha256: nil
        }
    end
  end

  @doc """
  The transcript file for `session`, or `nil` when no harness on this host
  wrote one.

  Each harness's wildcards (`Shuttle.Harness.transcript_globs/2`) are globbed
  in turn — Claude Code first, then pi, Codex and Antigravity — and the first
  regular-file hit wins; the later ones are not globbed. The session id is
  UUID-validated before any of this, so it remains the only caller-supplied
  pattern component.

  Opts (for tests): `:root`, `:pi_root`, `:codex_root`, `:antigravity_root`.
  """
  @spec path(String.t(), keyword()) :: String.t() | nil
  def path(session, opts \\ []) when is_binary(session) do
    if valid_session?(session) do
      @search_order
      |> Enum.flat_map(& &1.transcript_globs(session, opts))
      |> Enum.find_value(fn pattern ->
        pattern |> Shuttle.FS.wildcard() |> Enum.find(&Shuttle.FS.regular?/1)
      end)
    end
  end

  @doc "Return the native path when available, otherwise the honest status."
  @spec bytes(String.t(), keyword()) :: {:ok, String.t()} | {:error, atom()}
  def bytes(session, opts \\ []) when is_binary(session) do
    case resolve(session, opts) do
      %{availability: :available_local, source_path: path} when is_binary(path) -> {:ok, path}
      %{availability: availability} -> {:error, availability}
    end
  end

  @doc "The exact native-file size and SHA-256 used by byte-transfer receipts."
  @spec digest(String.t()) :: {non_neg_integer(), String.t()}
  def digest(path) when is_binary(path), do: {byte_count(path), sha256(path)}

  @doc "The harness that owns `path`, by which transcript root it sits under."
  @spec harness_for(String.t(), keyword()) :: String.t() | nil
  def harness_for(path, opts \\ []) do
    expanded = Shuttle.Env.expand(path)

    Enum.find_value(@search_order, fn harness ->
      if under?(expanded, Shuttle.Env.expand(harness.transcript_root(opts))),
        do: harness.ledger_name()
    end)
  end

  @doc """
  The values at `keys` in the first lines of the transcript at `path`, lazily:
  the records that carry them, in order.
  """
  @spec head_values(String.t(), [String.t()]) :: Enumerable.t()
  def head_values(path, keys) do
    path
    |> Shuttle.FS.stream!()
    |> Stream.take(@head_lines)
    |> Stream.map(&value(&1, keys))
  end

  defp value(line, keys) do
    if String.contains?(line, "\"#{List.last(keys)}\"") do
      case Jason.decode(line) do
        {:ok, %{} = record} ->
          case dig(record, keys) do
            value when is_binary(value) and value != "" -> value
            _ -> nil
          end

        _ ->
          nil
      end
    end
  end

  defp dig(value, []), do: value
  defp dig(%{} = map, [key | rest]), do: dig(Map.get(map, key), rest)
  defp dig(_value, _keys), do: nil

  defp under?(path, root), do: path == root or String.starts_with?(path, root <> "/")

  defp byte_count(path) do
    case Shuttle.FS.stat(path) do
      {:ok, %File.Stat{size: size}} -> size
      _ -> 0
    end
  end

  defp sha256(path) do
    path
    |> Shuttle.FS.stream!([], 64 * 1024)
    |> Enum.reduce(:crypto.hash_init(:sha256), fn chunk, digest ->
      :crypto.hash_update(digest, chunk)
    end)
    |> :crypto.hash_final()
    |> Base.encode16(case: :lower)
  rescue
    _ -> nil
  end
end
