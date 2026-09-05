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

  # A found link is stable for the life of the session; a session with no link
  # yet (the bridge comes up a few seconds after launch) is asked again after
  # this long. Stored in persistent_term: a handful of running workers, written
  # once each — the poll that stamps every feed row must never re-read a
  # transcript it has already read.
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

      {nil, checked_at} when now - checked_at < @retry_ms ->
        nil

      _ ->
        url = remote_url(session, opts)
        :persistent_term.put({__MODULE__, session}, {url, now})
        url
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
