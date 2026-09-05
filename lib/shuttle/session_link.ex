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
    case Moment.transcript_path(session, opts) do
      path when is_binary(path) -> last_url(path)
      nil -> nil
    end
  end

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
