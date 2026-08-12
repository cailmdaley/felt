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

  ## When there are no words: what the tools were

  A minute of pure tool work is silent by the rule above — the agent said
  nothing, it *did* things. The tooltip used to answer such a minute with "the
  minute is recorded, not the words", which is true and useless: the transcript
  knows exactly which tools ran.

  So `moment/4` returns a second field. When a window yields **zero** prose
  excerpts, the same assistant records' `tool_use` blocks are summarised into a
  compact line — tool names in first-appearance order, deduped with counts, and
  one short hint for the dominant tool when the call carried a `description`:

      "Bash ×2 · Read ×3 · Edit — run the activity tests"

  It is deliberately a separate field (`:tools`) and not a synthetic excerpt.
  Nobody said this; the UI must be able to draw it in a register that is
  visibly not speech. When there are real words, `:tools` is `nil` — the words
  are the better answer and the tooltip has no room for both.

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

  # The tool summary's bounds: distinct names shown, the hint's length, and the
  # whole line's. A tooltip footer, not a log.
  @tool_cap 5
  @tool_hint_chars 48
  @tool_summary_chars 120

  # Tools whose input carries a human-written one-liner. Everything else's
  # arguments are paths and payloads — noise in a footer.
  @hint_tools ~w(Bash)

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
  def excerpts(session, from_ms, to_ms, opts \\ []) do
    moment(session, from_ms, to_ms, opts).excerpts
  end

  @doc """
  Everything the transcript can say about the window: the words, and — only
  when there are none — a one-line summary of the tools that ran instead.

  Same guarantees as `excerpts/4`: never raises, absence is `%{excerpts: [],
  tools: nil}`.
  """
  @spec moment(String.t(), integer(), integer(), keyword()) ::
          %{excerpts: [excerpt()], tools: String.t() | nil}
  def moment(session, from_ms, to_ms, opts \\ [])

  def moment(session, from_ms, to_ms, opts)
      when is_binary(session) and is_integer(from_ms) and is_integer(to_ms) do
    cap = Keyword.get(opts, :cap, @cap)
    max_chars = Keyword.get(opts, :max_chars, @max_chars)

    case transcript_path(session, opts) do
      nil ->
        %{excerpts: [], tools: nil}

      path ->
        {excerpts, tools} = stream_window(path, from_ms, to_ms, max_chars)

        case Enum.sort_by(excerpts, & &1.at_ms) do
          [] -> %{excerpts: [], tools: tool_summary(Enum.reverse(tools))}
          found -> %{excerpts: Enum.take(found, cap), tools: nil}
        end
    end
  end

  def moment(_session, _from_ms, _to_ms, _opts), do: %{excerpts: [], tools: nil}

  @doc """
  The tool line for a window's `tool_use` calls, oldest first, or `nil` for
  none. Public because it is the whole judgment in this module worth testing on
  its own: `[{"Bash", "run the tests"}, {"Bash", nil}, {"Read", nil}]` becomes
  `"Bash ×2 · Read — run the tests"`.
  """
  @spec tool_summary([{String.t(), String.t() | nil}]) :: String.t() | nil
  def tool_summary([]), do: nil

  def tool_summary(calls) do
    # First appearance fixes the order; the hint is the first one that tool
    # offered. `Enum.reduce` over an ordered list keeps both without a sort.
    {names, counts, hints} =
      Enum.reduce(calls, {[], %{}, %{}}, fn {name, hint}, {names, counts, hints} ->
        {
          if(Map.has_key?(counts, name), do: names, else: [name | names]),
          Map.update(counts, name, 1, &(&1 + 1)),
          if(hint, do: Map.put_new(hints, name, hint), else: hints)
        }
      end)

    names = names |> Enum.reverse()
    shown = Enum.take(names, @tool_cap)

    line =
      shown
      |> Enum.map_join(" · ", fn name ->
        case counts[name] do
          1 -> name
          n -> "#{name} ×#{n}"
        end
      end)

    line = if length(names) > @tool_cap, do: line <> " · …", else: line

    dominant = Enum.max_by(shown, &counts[&1])

    line =
      case hints[dominant] do
        nil -> line
        hint -> line <> " — " <> hint
      end

    if String.length(line) <= @tool_summary_chars,
      do: line,
      else: String.slice(line, 0, @tool_summary_chars - 1) <> "…"
  end

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

  # One pass, two harvests: the prose excerpts and the tool calls behind them.
  # Tools accumulate reversed — `tool_summary/1` is given them oldest-first.
  defp stream_window(path, from_ms, to_ms, max_chars) do
    path
    |> File.stream!()
    |> Enum.reduce({[], []}, fn line, {excerpts, tools} ->
      case in_window(line, from_ms, to_ms) do
        {:ok, record} ->
          {
            excerpt_for(record, max_chars) ++ excerpts,
            Enum.reverse(tool_calls(record)) ++ tools
          }

        :skip ->
          {excerpts, tools}
      end
    end)
  rescue
    # Vanished or unreadable mid-read (a session compacting its own file).
    # A hover shows nothing rather than failing.
    error ->
      Logger.debug("moment: skipped #{path} — #{Exception.message(error)}")
      {[], []}
  end

  defp in_window(line, from_ms, to_ms) do
    with {:ok, record} <- Jason.decode(line),
         true <- is_map(record),
         {:ok, at_ms} <- at_ms(record),
         true <- at_ms >= from_ms and at_ms <= to_ms do
      {:ok, Map.put(record, :at_ms, at_ms)}
    else
      _ -> :skip
    end
  end

  defp excerpt_for(record, max_chars) do
    with {:ok, role} <- role(record),
         {:ok, text} <- text(record, max_chars) do
      [%{at_ms: record.at_ms, role: role, text: text}]
    else
      _ -> []
    end
  end

  # `{name, hint}` per assistant `tool_use` block, in the order they were made.
  defp tool_calls(%{"type" => "assistant", "message" => %{"content" => blocks}})
       when is_list(blocks) do
    for %{"type" => "tool_use", "name" => name} = block <- blocks, is_binary(name), name != "" do
      {name, hint(name, block["input"])}
    end
  end

  defp tool_calls(_), do: []

  defp hint(name, %{"description" => description}) when is_binary(description) do
    if name in @hint_tools do
      case trim(description, @tool_hint_chars) do
        {:ok, hint} -> hint
        _ -> nil
      end
    end
  end

  defp hint(_name, _input), do: nil

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
