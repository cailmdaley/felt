defmodule Shuttle.Moment do
  @moduledoc """
  The words behind a minute — real excerpts recovered from a harness transcript.

  The temporal views (Day, Week) bucket a host's `events.jsonl` into per-minute
  activity marks. A mark says *that* something happened; it cannot say *what*.
  The transcript can. Claude Code writes one JSONL file per session under
  `~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl`, one line per
  conversation record, each stamped with an ISO-8601 `timestamp`. Given a
  session UUID and a minute window, this module returns the handful of messages
  that fell inside it.

  ## What counts as a word

  Only what a human would recognise as the conversation:

    * `"user"` — a real prompt. String content, or the `text` blocks of an
      array. Tool RESULTS are also `type: "user"` records and are skipped, as
      are `isMeta` records (skill preambles, injected context) — neither was
      typed by anyone.
    * `"assistant"` — the `text` blocks of the content array. `thinking` and
      `tool_use` blocks are skipped: thinking is not addressed to the reader,
      and a tool call is already what the activity mark is made of.
    * `"notification"` — `type: "system"` records with string content (bridge
      status, hook notices). Machine speech, kept separate from either voice.

  ## Defensive by construction

  A transcript is another program's private format, read from a directory this
  daemon does not own. Every line is decoded independently and a line that does
  not decode — or does not carry a usable timestamp, role, or text — is
  skipped. A missing directory, a missing transcript, or an unreadable file
  yields `[]`. Nothing here raises, because the caller is a hover.

  Other harnesses (codex, pi) write elsewhere in other shapes; they are out of
  scope and yield `[]`.

  ## Bounds

  `@max_window_ms` (2 h) caps the window, `@cap` (6) the excerpts, `@max_chars`
  (280) each excerpt's text. Lookup is a single `Path.wildcard/1` over
  `<root>/*/<uuid>.jsonl` — a glob one level deep, never a walk — and the
  session id is validated as UUID-shaped first, so no caller-supplied pattern
  reaches the filesystem.
  """

  require Logger

  @max_window_ms 2 * 60 * 60 * 1000
  @cap 6
  @max_chars 280

  # Canonical UUID. Narrow on purpose: this string becomes a glob segment.
  @uuid ~r/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

  @typedoc "One recovered message: when it landed, who spoke, what they said."
  @type excerpt :: %{at_ms: integer(), role: String.t(), text: String.t()}

  @doc """
  The transcript root — `$SHUTTLE_CLAUDE_PROJECTS_DIR`, else
  `~/.claude/projects`. The env override exists so a test can point at a
  fixture tree; nothing in production sets it.
  """
  @spec projects_root() :: String.t()
  def projects_root do
    System.get_env("SHUTTLE_CLAUDE_PROJECTS_DIR") ||
      Path.join([System.user_home!() || "/root", ".claude", "projects"])
  end

  @doc """
  Validate a window without reading anything, so a controller can refuse a bad
  one before paying for the scan. Mirrors `Shuttle.Activity.check_range/2`.
  """
  @spec check_window(integer(), integer()) ::
          :ok | {:error, :inverted_range | :range_too_wide}
  def check_window(from_ms, to_ms) when is_integer(from_ms) and is_integer(to_ms) do
    cond do
      to_ms < from_ms -> {:error, :inverted_range}
      to_ms - from_ms > @max_window_ms -> {:error, :range_too_wide}
      true -> :ok
    end
  end

  @doc "The widest window `excerpts/4` will serve, in milliseconds."
  @spec max_window_ms() :: pos_integer()
  def max_window_ms, do: @max_window_ms

  @doc """
  Up to #{@cap} excerpts from `session`'s transcript inside the inclusive
  window `from_ms..to_ms`, oldest first.

  Never raises and never signals absence as an error: an unknown session, a
  harness that is not Claude Code, and a transcript with nothing in the window
  all return `[]`.

  Opts (for tests): `:root` (transcript root), `:cap`, `:max_chars`.
  """
  @spec excerpts(String.t(), integer(), integer(), keyword()) :: [excerpt()]
  def excerpts(session, from_ms, to_ms, opts \\ [])

  def excerpts(session, from_ms, to_ms, opts)
      when is_binary(session) and is_integer(from_ms) and is_integer(to_ms) do
    cap = Keyword.get(opts, :cap, @cap)
    max_chars = Keyword.get(opts, :max_chars, @max_chars)

    case transcript_path(session, opts) do
      nil ->
        []

      path ->
        path
        |> stream_excerpts(from_ms, to_ms, max_chars)
        |> Enum.sort_by(& &1.at_ms)
        |> Enum.take(cap)
    end
  end

  def excerpts(_session, _from_ms, _to_ms, _opts), do: []

  @doc """
  The transcript file for `session`, or `nil` when no harness on this host
  wrote one. Public because "are there words here at all?" is a question worth
  asking without reading them.
  """
  @spec transcript_path(String.t(), keyword()) :: String.t() | nil
  def transcript_path(session, opts \\ []) when is_binary(session) do
    if Regex.match?(@uuid, session) do
      root = Keyword.get(opts, :root, projects_root())

      root
      |> Path.join("*/#{session}.jsonl")
      |> Path.wildcard()
      |> Enum.find(&File.regular?/1)
    end
  end

  defp stream_excerpts(path, from_ms, to_ms, max_chars) do
    path
    |> File.stream!()
    |> Stream.flat_map(&excerpt_for_line(&1, from_ms, to_ms, max_chars))
    |> Enum.to_list()
  rescue
    # Vanished or unreadable mid-read (a session compacting its own file).
    # A hover shows nothing rather than failing.
    error ->
      Logger.debug("moment: skipped #{path} — #{Exception.message(error)}")
      []
  end

  defp excerpt_for_line(line, from_ms, to_ms, max_chars) do
    with {:ok, record} <- Jason.decode(line),
         true <- is_map(record),
         {:ok, at_ms} <- at_ms(record),
         true <- at_ms >= from_ms and at_ms <= to_ms,
         {:ok, role} <- role(record),
         {:ok, text} <- text(record, max_chars) do
      [%{at_ms: at_ms, role: role, text: text}]
    else
      _ -> []
    end
  end

  defp at_ms(%{"timestamp" => stamp}) when is_binary(stamp) do
    case DateTime.from_iso8601(stamp) do
      {:ok, dt, _offset} -> {:ok, DateTime.to_unix(dt, :millisecond)}
      _ -> :skip
    end
  end

  defp at_ms(%{"timestamp" => stamp}) when is_integer(stamp), do: {:ok, stamp}
  defp at_ms(_), do: :skip

  # `isMeta` records are injected context wearing a user's clothes.
  defp role(%{"isMeta" => true}), do: :skip
  defp role(%{"type" => "user"}), do: {:ok, "user"}
  defp role(%{"type" => "assistant"}), do: {:ok, "assistant"}
  defp role(%{"type" => "system"}), do: {:ok, "notification"}
  defp role(_), do: :skip

  defp text(%{"message" => %{"content" => content}}, max_chars),
    do: content |> from_content() |> trim(max_chars)

  defp text(%{"content" => content}, max_chars) when is_binary(content),
    do: content |> trim(max_chars)

  defp text(_, _), do: :skip

  defp from_content(content) when is_binary(content), do: content

  defp from_content(blocks) when is_list(blocks) do
    blocks
    |> Enum.filter(&match?(%{"type" => "text", "text" => t} when is_binary(t), &1))
    |> Enum.map_join("\n", & &1["text"])
  end

  defp from_content(_), do: ""

  defp trim(text, max_chars) when is_binary(text) do
    collapsed = text |> String.replace(~r/\s+/u, " ") |> String.trim()

    cond do
      collapsed == "" -> :skip
      String.length(collapsed) <= max_chars -> {:ok, collapsed}
      true -> {:ok, String.slice(collapsed, 0, max_chars - 1) <> "…"}
    end
  end

  defp trim(_, _), do: :skip
end
