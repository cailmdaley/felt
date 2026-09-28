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

  ## Two readers, two caches

  `cached_url/2` serves the poller: a handful of LIVE workers, each asked every
  tick, memoised in `:persistent_term` with a miss retried on a timer.

  `resolve/2` serves the card's session history (`GET /api/v1/sessions/links`):
  any past session the drawer shows, asked only when a card opens. Those are
  mostly ended transcripts that will never change, so the answer is cached in
  an ETS table owned by this module's GenServer and validated on the
  transcript's `{mtime, size}` — a repeat costs one `stat` of the remembered
  file rather than a glob across the harness roots and a read of the
  transcript, so an unbridged ended session is read once, and a session still
  running is re-read only when its file has grown. A session with no transcript
  here is remembered as missing for a minute. Without the GenServer the
  resolution still happens, uncached.

  Only a `https://claude.ai/` address counts as a bridge URL, for both readers.
  """

  use GenServer

  alias Shuttle.{Moment, TokenSpend, Transcript}

  @table :shuttle_session_links

  @typedoc "Where one session can be opened, as resolved on this host."
  @type link :: %{
          session: String.t(),
          availability: :available_local | :transcript_missing,
          harness: String.t() | nil,
          url: String.t() | nil,
          desktop_link: String.t() | nil
        }

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @impl true
  def init(_opts) do
    table =
      :ets.new(@table, [:named_table, :public, :set, read_concurrency: true])

    {:ok, %{table: table}}
  end

  @doc """
  Where `session` opens, from its transcript on this host.

    * a Claude Code transcript → `url`, its last bridge URL, when it has one;
    * a Codex rollout → `desktop_link`, the `codex://threads/<id>` route the
      Codex app on THIS host answers (the rollout being here is the evidence
      that this host's Codex has the thread);
    * a pi transcript, or no transcript → neither.

  Nothing is guessed: a missing transcript is `:transcript_missing` with no
  link, whatever the ledger says the harness was.

  Opts (for tests): the transcript roots `Shuttle.Moment.transcript_path/2`
  takes, and `cache: false` to bypass the table.
  """
  @spec resolve(String.t(), keyword()) :: link()
  def resolve(session, opts \\ []) when is_binary(session) do
    cache? = Keyword.get(opts, :cache, true)

    case cache? && lookup(session) do
      {:ok, link} ->
        link

      _ ->
        case Moment.transcript_path(session, opts) do
          nil ->
            link = missing(session)
            if cache?, do: store(session, :missing, deadline(), link)
            link

          path ->
            token = TokenSpend.file_token(path)
            link = read_link(session, path, opts)
            if cache? and not is_nil(token), do: store(session, path, token, link)
            link
        end
    end
  end

  # A transcript that is not here costs three globs to establish, and the
  # answer can change only when a harness writes one, so it is remembered
  # briefly rather than re-established on every open of the card.
  @missing_ttl_ms 60_000

  defp deadline, do: System.monotonic_time(:millisecond) + @missing_ttl_ms

  defp missing(session) do
    %{
      session: session,
      availability: :transcript_missing,
      harness: nil,
      url: nil,
      desktop_link: nil
    }
  end

  defp read_link(session, path, opts) do
    harness = Transcript.harness_for(path, opts)

    %{
      session: session,
      availability: :available_local,
      harness: harness,
      url: if(harness == "claude-code", do: last_url(path)),
      desktop_link: if(harness == "codex", do: desktop_url(session))
    }
  end

  # A hit needs the remembered file to still carry the remembered
  # `{mtime, size}` — one stat, and no glob across the harness roots. A file
  # that moved, grew or vanished is a miss and is looked up afresh. A missing
  # transcript is remembered until its deadline instead.
  defp lookup(session) do
    case :ets.lookup(@table, session) do
      [{^session, :missing, deadline, link}] ->
        if System.monotonic_time(:millisecond) < deadline, do: {:ok, link}, else: :miss

      [{^session, path, token, link}] ->
        if TokenSpend.file_token(path) == token, do: {:ok, link}, else: :miss

      _ ->
        :miss
    end
  rescue
    ArgumentError -> :miss
  end

  defp store(session, path, token, link) do
    :ets.insert(@table, {session, path, token, link})
  rescue
    ArgumentError -> :ok
  end

  @doc "True for a claude.ai address — the only kind of bridge URL this module hands out."
  @spec claude_url?(term()) :: boolean()
  def claude_url?(url), do: is_binary(url) and String.starts_with?(url, "https://claude.ai/")

  @doc "The installed desktop app's native thread route; not a phone universal link."
  def desktop_url(thread_id) when is_binary(thread_id) do
    if Regex.match?(
         ~r/\A[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z/i,
         thread_id
       ),
       do: "codex://threads/" <> thread_id
  end

  def desktop_url(_), do: nil

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
        if claude_url?(url), do: url

      _ ->
        nil
    end
  end
end
