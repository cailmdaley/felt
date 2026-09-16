defmodule Shuttle.SessionLink do
  @moduledoc """
  The web address of a session — where a phone can open it.

  When a Claude Code session is bridged to claude.ai (remote control), the
  harness writes an `attachment` record of type `remote_session_change` into
  the transcript carrying the bridge URL (`https://claude.ai/code/session_…`).
  That URL is a universal link: on a phone with the Claude app installed it
  opens the very session, not the app's front door. The record is written when
  the bridge comes up and again whenever it changes, so the LAST one is the
  live address.

  This module reads only that one record shape. It does not interpret anything
  else in the transcript, and a session from another harness, or one that was
  never bridged, honestly has no link.
  """

  alias Shuttle.Moment

  @marker "remote_session_change"

  @doc """
  The bridge URL for `session` (a harness UUID), or `nil` when the transcript
  is not on this host or carries no bridge record.

  `opts` are forwarded to `Shuttle.Moment.transcript_path/2` (`:root` for tests).
  """
  @spec remote_url(String.t(), keyword()) :: String.t() | nil
  def remote_url(session, opts \\ []) when is_binary(session) do
    with path when is_binary(path) <- Moment.transcript_path(session, opts) do
      last_url(path)
    end
  end

  # A found link is stable for the life of the session and is never re-read.
  # A session with NO link yet is a different animal: the harness writes the
  # bridge record 20–30s after launch, and a phone that just tapped "New
  # session" is waiting on exactly that record. So a miss is re-checked every
  # `@young_retry_ms` while the session is young (its first miss is less than
  # `@young_window_ms` ago), and only settles to `@retry_ms` after — a session
  # that was never bridged then costs one transcript read a minute, as before.
  #
  # Stored in persistent_term: a handful of running workers. A found link is a
  # `{url, checked_at}` 2-tuple and is never looked up again; a miss is a
  # `{nil, checked_at, first_miss_at}` 3-tuple, so the young window survives
  # across re-checks. A pre-upgrade 2-tuple miss simply re-reads once.
  @young_retry_ms 3_000
  @young_window_ms 300_000
  @retry_ms 60_000

  @doc """
  `remote_url/2`, memoised per session. What the poller stamps on a feed row.
  """
  @spec cached_url(String.t(), keyword()) :: String.t() | nil
  def cached_url(session, opts \\ []) when is_binary(session) do
    now = System.monotonic_time(:millisecond)

    case :persistent_term.get({__MODULE__, session}, nil) do
      {url, _} when is_binary(url) ->
        url

      {nil, checked_at, first_miss_at} ->
        if now - checked_at < miss_retry_ms(now, first_miss_at),
          do: nil,
          else: lookup(session, opts, now, first_miss_at)

      _ ->
        lookup(session, opts, now, now)
    end
  end

  defp miss_retry_ms(now, first_miss_at) when now - first_miss_at < @young_window_ms,
    do: @young_retry_ms

  defp miss_retry_ms(_now, _first_miss_at), do: @retry_ms

  defp lookup(session, opts, now, first_miss_at) do
    case remote_url(session, opts) do
      url when is_binary(url) ->
        :persistent_term.put({__MODULE__, session}, {url, now})
        url

      nil ->
        :persistent_term.put({__MODULE__, session}, {nil, now, first_miss_at})
        nil
    end
  end

  @doc false
  def forget(session), do: :persistent_term.erase({__MODULE__, session})

  defp last_url(path) do
    path
    |> File.stream!()
    # Substring first: decoding every line of a multi-megabyte transcript to
    # find one record is the wrong order of operations.
    |> Stream.filter(&String.contains?(&1, @marker))
    |> Stream.map(&decode_url/1)
    |> Stream.reject(&is_nil/1)
    |> Enum.reduce(nil, fn url, _last -> url end)
  rescue
    _ -> nil
  end

  defp decode_url(line) do
    case Jason.decode(line) do
      {:ok, %{"attachment" => %{"type" => @marker, "url" => url}}} when is_binary(url) ->
        if String.starts_with?(url, "https://"), do: url

      _ ->
        nil
    end
  end
end
