defmodule Shuttle.Moment do
  require Logger

  @moduledoc """
  The words behind a minute — real excerpts recovered from a harness transcript.

  The temporal views (Day, Week) bucket a host's `events.jsonl` into per-minute
  activity marks. A mark says *that* something happened; it cannot say *what*.
  The transcript can. Claude Code writes one JSONL file per session under
  `~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl`, one line per
  conversation record, each stamped with an ISO-8601 `timestamp`; pi writes a
  different envelope under `~/.pi/agent/sessions/`; and Codex files rollouts
  under `~/.codex/sessions/YYYY/MM/DD/`. Given a session UUID and a minute
  window, this module returns the handful of messages that fell inside it,
  whichever harness wrote them.

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

  ## The third register: delegation

  A session that fans work out to subagents says almost nothing in its own
  voice while they run — the transcript's own prose goes quiet exactly where
  the most work is happening. What it does hold is the two ends of each
  delegation, and those are the readable summary of it:

    * a **spawn** — an assistant `tool_use` block naming a spawn tool
      (`Agent`, `Task`, `Workflow`). Its `name`/`subagent_type`/`description`
      is who was sent, and its `prompt` is what they were sent to do.
    * a **return** — the report coming back. Three shapes, all of them records
      the PARENT wrote, because the parent's own file is the only one this
      module reads:
        - a `tool_result` closing a spawn's `tool_use` id;
        - a `<task-notification>` record, whose `<result>` is the report and
          whose `<summary>` names the agent;
        - a `<teammate-message teammate_id="…">` record, the shape an
          asynchronous teammate's report arrives in.

  These travel as ordinary excerpts carrying a `kind` of `"spawn"` or
  `"return"` (prose is `"prose"`) and a `name`, so the UI can draw them in a
  register that is visibly neither of the two voices. They are cut shorter than
  prose — 200 characters against 280 — because a delegation prompt is a
  briefing document and a hover is not; a pinned `full` fetch relaxes both to
  the same generous bound.

  Two things are deliberately NOT read. **Sidechain records** (`isSidechain:
  true`) are the subagent's own transcript interleaved into the parent's file;
  they are skipped entirely, because the spawn/return pair already says what
  that agent was for and what it found, and the alternative is a tooltip full
  of another agent's inner monologue. And a spawn `tool_result` that announces
  itself as **internal metadata** (an async launch receipt: an id, and an
  instruction never to quote it) carries no report at all — it is not a return,
  and the real report arrives later in one of the other two shapes.

  ## What the tools were

  A mark says an agent was busy; the transcript knows exactly which tools ran.
  So `moment/4` returns a second field, built from the same assistant records'
  `tool_use` blocks — as individual calls when there are few enough to read one
  by one, as a summary when there are not.

  Few enough (at most `@tool_calls_cap`, presently 6) and each call gets its
  own line, oldest first, tool name and — when the call offers one — its own
  short description:

      "Bash — run the activity tests"
      "Bash — git status --short"
      "Read — DayView.ts"

  A Bash call with no description falls back to its command, as the second
  line shows: "Bash" alone says nothing a reader did not already know.

  Past that count the individual calls would be a wall of lines a hover can't
  hold, so the line steps back to the old aggregate instead: tool names in
  first-appearance order, deduped with counts, one short hint for the
  dominant tool:

      "Bash ×2 · Read ×3 · Edit — run the activity tests"

  Both forms travel in the same field (`:tools`), a single string — the
  per-call form is simply several lines joined by `"\n"`. It is deliberately
  a separate field and not a synthetic excerpt: nobody said this, and the UI
  must be able to draw it in a register that is visibly not speech.

  `:tools` is now the LEGACY of that pair. Beside it travel `:tool_lines` (the
  per-call form, always, capped rather than replaced) and `:tool_count` (how
  many calls there actually were). The aggregate exists because a hover cannot
  hold forty lines; the count exists because a client that is shown six of
  forty must be able to SAY six of forty, and then offer the rest. Same for the
  words: `:excerpt_count` is the number in the window, `:excerpts` the ones
  that fit.

  IT TRAVELS ALONGSIDE THE WORDS, always. It was once withheld whenever a
  window held prose, on the reasoning that the words are the better answer and
  a client should never have to choose between them. But a minute that spoke
  AND ran forty calls is two facts about that minute, and suppressing one left
  the tooltip able to say "tool call ×40" with no way to learn what any of them
  were. The calls are collected either way; only the field was being dropped.

  ## Defensive by construction

  A transcript is another program's private format, read from a directory this
  daemon does not own. Every line is decoded independently and a line that does
  not decode — or does not carry a usable timestamp, role, or text — is
  skipped. A missing directory, a missing transcript, or an unreadable file
  yields `[]`. Nothing here raises, because the caller is a hover.

  ## Three harnesses, one reader

  Pi's transcript differs from Claude's in envelope, not in kind: turns nest
  under `"message"` with a `role` of `user`/`assistant`/`toolResult`, tool
  calls are `toolCall` blocks with lowercase names, and a tool result is a
  turn of its own rather than a block inside a user record. Rather than fork
  the reading logic, pi records are NORMALIZED into the claude shape at decode
  time — `normalize_record/1` recognizes the pi envelope by shape (claude
  never uses it), so no path sniffing, and everything downstream — prose,
  delegation register, tool listing — runs harness-agnostic. A pi minute reads
  like a Claude one because by the time it is read, it is one.

  Codex's rollout is a stream of `response_item` envelopes. Conversation
  messages carry `input_text`/`output_text` blocks, tool calls arrive as
  `custom_tool_call` or `function_call`, and their results carry the matching
  call id. Those records are translated into the same canonical shape. The
  native `exec` operation stays named `Exec`: its payload is usually
  orchestration source (`tools.exec_command(...)`), not a trustworthy shell
  command to copy into a hover. Other tool names remain visible rather than
  being guessed into Claude's vocabulary. Developer messages, reasoning, and
  runtime bookkeeping are excluded as machine context.

  ## Bounds

  `@max_window_ms` (2 h) caps the window, `@cap` (6) the excerpts, `@max_chars`
  (280) each excerpt's text, `@tool_calls_cap` (6) the per-call tool listing
  before it steps back to the aggregate. Claude and pi use bounded
  `Path.wildcard/1` patterns; Codex uses one UUID-validated date-tree glob so
  an old Day/Week session remains readable without a recursive filesystem
  walk. The session id is validated as UUID-shaped first, so no caller-supplied
  pattern reaches the filesystem.
  """

  require Logger

  @max_window_ms 2 * 60 * 60 * 1000
  @cap 6
  @max_chars 280

  # What a PINNED read is allowed to return. A hover is a glance and gets the
  # handful above; a pin is somebody reading, and the panel it opens is
  # scrollable — so the bound here exists only to keep a pathological minute
  # (a fan-out reporting two hundred times) from becoming the response.
  #
  # THE TWO CAPS ARE THE WHOLE REASON THE COUNTS TRAVEL. A cut the client
  # cannot see is a client that says "×14" over six lines; a cut it can see is
  # a client that says "showing 6 of 14" and offers the pin that shows all
  # fourteen. See `moment/4`'s `:excerpt_count` and `:tool_count`.
  @full_cap 200

  # What an excerpt is cut to when the caller asks for the FULL text — a pinned
  # tooltip, which the reader is no longer glancing at but reading. Still a
  # bound and not "no bound at all": the caller is a browser tooltip and a
  # pathological turn (a pasted file, a base64 blob) must not become the
  # response. Generous enough that a real message arrives whole.
  @full_max_chars 8_000

  # The tool summary's bounds: distinct names shown, the hint's length, and the
  # whole line's. A tooltip footer, not a log.
  @tool_cap 5
  @tool_hint_chars 48
  @tool_summary_chars 120

  # Above this many calls, the per-call listing gives way to the aggregate —
  # a hover has room for a handful of lines, not a transcript.
  @tool_calls_cap 6

  # How many per-call lines `:tool_lines` carries. The hover gets a PREVIEW of
  # the same length the aggregate used to replace, and the pin gets the lot:
  # thirty-four calls in a minute is an ordinary fan-out and every one of them
  # must be reachable, because the count beside them says how many there are.
  @tool_lines_cap 6
  @full_tool_lines_cap 400

  # Tools whose input carries a human-written one-liner — or, failing that, an
  # argument that reads as one anywhere it appears (Bash's command). Everything
  # else's arguments are paths and payloads — noise in a footer.
  @hint_tools ~w(Bash)

  # Tools whose argument, standing alone on its own line in the per-call
  # listing, reads as a description rather than as payload — a path (its
  # basename) or a search pattern. Folded into the aggregate's single footer
  # hint this would be noise; one line to itself, it is the useful part of
  # the call.
  @path_hint_tools ~w(Read Edit Write NotebookEdit Multiedit)
  @pattern_hint_tools ~w(Grep Glob)

  # The tools whose call is a DELEGATION — a unit of work handed to an agent of
  # its own — rather than an action taken here. What makes them their own
  # register is that both ends are legible: the prompt going out and the report
  # coming back are the two sentences that say what that stretch of time was.
  # ("Subagent" is pi's delegate tool after name normalization.)
  @spawn_tools ~w(Agent Task Workflow Subagent)

  # A delegation excerpt's ordinary cut. Shorter than prose because a prompt is
  # a briefing and a report is a document: the first two lines identify it, and
  # a reader who wants the rest pins the tooltip and gets the full text.
  @delegation_chars 200

  # An agent's name is a label — a slug, a role, or the caller's one-line
  # errand. One line's worth, whatever the excerpt bound is.
  @name_chars 64

  # The phrase a harness stamps on a tool result that is a launch receipt rather
  # than a report — an agent id, and an explicit instruction not to surface it.
  # A tooltip is user-facing, so such a result is treated as no report at all.
  @internal_result "internal metadata"

  # The body an idle teammate pings with. It is a machine's heartbeat wearing a
  # report's envelope; nothing was reported, so nothing is drawn.
  @idle_report ~s({"type":"idle_notification")

  # Canonical UUID. Narrow on purpose: this string becomes a glob segment.
  @uuid ~r/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

  @typedoc """
  One recovered message: when it landed, who spoke, what they said — and which
  REGISTER it belongs to. `kind` is `"prose"` for the conversation's own two
  voices, `"spawn"` for a delegation going out and `"return"` for its report
  coming back; `name` is the agent's, and is `nil` on prose.
  """
  @type excerpt :: %{
          at_ms: integer(),
          role: String.t(),
          text: String.t(),
          kind: String.t(),
          name: String.t() | nil
        }

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
  The per-excerpt character bound: #{@max_chars} ordinarily, #{@full_max_chars}
  for a caller that asked for the full text.

  Truncation happens HERE and not in the client, which is why relaxing it takes
  a round trip: a tooltip that widens its box still has an ellipsis in the
  string it was given. `full?` is the whole difference between the hover fetch
  and the pinned one.
  """
  @spec max_chars(boolean()) :: pos_integer()
  def max_chars(full? \\ false)
  def max_chars(true), do: @full_max_chars
  def max_chars(_), do: @max_chars

  @doc """
  Up to #{@cap} excerpts from `session`'s transcript inside the inclusive
  window `from_ms..to_ms`, oldest first.

  Never raises and never signals absence as an error: an unknown session, a
  unknown harness, and a transcript with nothing in the window all return `[]`.

  Opts (for tests): `:root` (Claude transcript root), `:pi_root`, `:codex_root`,
  `:cap`, `:max_chars`.
  """
  @spec excerpts(String.t(), integer(), integer(), keyword()) :: [excerpt()]
  def excerpts(session, from_ms, to_ms, opts \\ []) do
    moment(session, from_ms, to_ms, opts).excerpts
  end

  @doc """
  Everything the transcript can say about the window: the words, the tools that
  ran, and — the part that keeps a client honest — HOW MANY OF EACH THERE WERE.

  Five keys:

    * `:excerpts` — up to `:cap` messages, oldest first, each cut to
      `:max_chars`.
    * `:excerpt_count` — how many were in the window before that cut.
    * `:tool_lines` — one line per call (`"Bash — run the tests"`), oldest
      first, up to the line cap.
    * `:tool_count` — how many calls were in the window before that cap.
    * `:tools` — the legacy single string, per-call lines joined by `"\\n"` when
      there were few enough, else the aggregate (`"Bash ×2 · Read"`). Kept for
      clients written before the counts existed; the two new keys say the same
      thing without making the reader infer a cut from a truncation.

  A COUNT WITHOUT ITS ITEMS IS THE BUG THIS SHAPE EXISTS TO PREVENT. The board's
  slip used to print the activity plane's own per-minute event tally beside
  whatever fraction of the transcript survived these caps, and the two numbers
  had no reason to agree — "tool calls ×14" over six lines, or over none.
  Counting and listing here, from one pass over one file, makes them the same
  fact reported twice.

  `full: true` opens both caps to their pinned bounds (#{@full_cap} excerpts,
  #{@full_tool_lines_cap} tool lines) and relaxes `:max_chars` — the read a
  pinned, scrollable panel makes. Explicit `:cap`, `:max_chars` and
  `:tool_lines_cap` still win, for tests.

  Same guarantees as `excerpts/4`: never raises, absence is the empty shape.
  """
  @spec moment(String.t(), integer(), integer(), keyword()) ::
          %{
            excerpts: [excerpt()],
            excerpt_count: non_neg_integer(),
            tools: String.t() | nil,
            tool_lines: [String.t()],
            tool_count: non_neg_integer()
          }
  def moment(session, from_ms, to_ms, opts \\ [])

  def moment(session, from_ms, to_ms, opts)
      when is_binary(session) and is_integer(from_ms) and is_integer(to_ms) do
    full? = Keyword.get(opts, :full, false)
    cap = Keyword.get(opts, :cap, if(full?, do: @full_cap, else: @cap))
    max_chars = Keyword.get(opts, :max_chars, max_chars(full?))

    lines_cap =
      Keyword.get(
        opts,
        :tool_lines_cap,
        if(full?, do: @full_tool_lines_cap, else: @tool_lines_cap)
      )

    case transcript_path(session, opts) do
      nil ->
        empty_moment()

      path ->
        {excerpts, tools} = stream_window(path, from_ms, to_ms, max_chars)
        calls = Enum.reverse(tools)

        # BOTH, ALWAYS. `tools` used to be withheld whenever there were words,
        # on the reasoning that the words are the better answer and a client
        # should never have to choose. That was true of the choice and false of
        # the question: a minute that spoke AND ran forty tool calls has two
        # facts about it, and suppressing one made the tooltip say "tool call
        # ×40" with no way to learn what any of them were. The calls are
        # already collected either way, so this costs nothing but the field.
        %{
          excerpts: excerpts |> Enum.sort_by(& &1.at_ms) |> Enum.take(cap),
          excerpt_count: length(excerpts),
          tools: tools_line(calls),
          tool_lines: call_preview(calls, lines_cap),
          tool_count: length(calls)
        }
    end
  end

  def moment(_session, _from_ms, _to_ms, _opts), do: empty_moment()

  defp empty_moment do
    %{excerpts: [], excerpt_count: 0, tools: nil, tool_lines: [], tool_count: 0}
  end

  # The per-call listing, always in the per-call form and always capped rather
  # than replaced. `call_lines/1` refuses past `@tool_calls_cap` because the
  # LEGACY field has to choose between two forms; this one does not — the count
  # travels beside it, so a cut list is a preview and says so.
  defp call_preview(calls, cap) do
    calls
    |> Enum.take(cap)
    |> Enum.map(fn {name, _footer_hint, line_hint} ->
      if line_hint, do: name <> " — " <> line_hint, else: name
    end)
  end

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
  One line per call — `"Bash — run the tests"`, or bare `"Read"` for a call
  with no description — oldest first, or `nil` when there are more than
  #{@tool_calls_cap} calls to list. `moment/4` falls back to `tool_summary/1`
  on `nil`; this function only decides whether the individual calls fit, not
  what to say when they do not.
  """
  @spec call_lines([{String.t(), String.t() | nil}]) :: [String.t()] | nil
  def call_lines([]), do: nil
  def call_lines(calls) when length(calls) > @tool_calls_cap, do: nil

  def call_lines(calls) do
    Enum.map(calls, fn
      {name, nil} -> name
      {name, hint} -> name <> " — " <> hint
    end)
  end

  # The `:tools` field itself: individual lines when there are few enough
  # calls to read one by one, the aggregate otherwise. `calls` is oldest-first
  # `{name, footer_hint, line_hint}` triples — see `tool_calls/1`.
  defp tools_line([]), do: nil

  defp tools_line(calls) do
    per_call = Enum.map(calls, fn {name, _footer_hint, line_hint} -> {name, line_hint} end)

    case call_lines(per_call) do
      nil ->
        calls
        |> Enum.map(fn {name, footer_hint, _line_hint} -> {name, footer_hint} end)
        |> tool_summary()

      lines ->
        Enum.join(lines, "\n")
    end
  end

  @doc """
  The transcript file for `session`, or `nil` when no harness on this host
  wrote one. Public because "are there words here at all?" is a question worth
  asking without reading them.

  Each harness root is globbed in turn — Claude Code first, then pi, then Codex
  — and the first regular-file hit wins. Pi leads its basenames with an ISO
  stamp, while Codex fans out by local civil date; the session id is
  UUID-validated before any of this, so it remains the only caller-supplied
  pattern component.
  """
  @spec transcript_path(String.t(), keyword()) :: String.t() | nil
  def transcript_path(session, opts \\ []) when is_binary(session) do
    if Regex.match?(@uuid, session) do
      [
        Path.join(claude_root(opts), "*/#{session}.jsonl"),
        Path.join(pi_root(opts), "*/*#{session}.jsonl"),
        codex_paths(session, opts)
      ]
      |> List.flatten()
      |> Enum.flat_map(&Path.wildcard/1)
      |> Enum.find(&File.regular?/1)
    end
  end

  defp claude_root(opts), do: Shuttle.HarnessPaths.claude_projects_root(opts)

  defp pi_root(opts), do: Shuttle.HarnessPaths.pi_sessions_root(opts)

  defp codex_paths(session, opts) do
    [Shuttle.HarnessPaths.codex_session_glob(session, opts)]
  end

  # One pass, three harvests: the excerpts, the tool calls behind them, and the
  # spawn ids seen so far. Tools accumulate reversed — `tool_summary/1` is given
  # them oldest-first. Codex also carries the root/teammate identity in
  # `session_meta`; it lets us distinguish a peer's incoming message from the
  # parent sending one out without guessing from its prose.
  #
  # Spawn ids are collected from EVERY decoded line, in window or not. A
  # delegation's report can land an hour after the call that made it, and the
  # `tool_use` block naming the agent is the only place its name is written; a
  # map built only from in-window lines would leave most returns anonymous.
  # This costs nothing — the whole file is decoded either way.
  defp stream_window(path, from_ms, to_ms, max_chars) do
    {excerpts, tools, _spawns, _codex_self} =
      path
      |> File.stream!()
      |> Enum.reduce({[], [], %{}, "/root"}, fn line, {excerpts, tools, spawns, codex_self} ->
        case decode_record(line) do
          {:ok, record} ->
            codex_self = Map.get(record, "codex_self") || codex_self
            record = Map.put(record, :codex_self, codex_self)
            spawns = note_spawns(spawns, record)

            if record.at_ms >= from_ms and record.at_ms <= to_ms do
              {
                excerpt_for(record, max_chars, spawns) ++ excerpts,
                Enum.reverse(tool_calls(record)) ++ tools,
                spawns,
                codex_self
              }
            else
              {excerpts, tools, spawns, codex_self}
            end

          :skip ->
            {excerpts, tools, spawns, codex_self}
        end
      end)

    {excerpts, tools}
  rescue
    # Vanished or unreadable mid-read (a session compacting its own file).
    # A hover shows nothing rather than failing.
    error ->
      Logger.debug("moment: skipped #{path} — #{Exception.message(error)}")
      {[], []}
  end

  defp decode_record(line) do
    with {:ok, raw} <- Jason.decode(line),
         true <- is_map(raw),
         {:ok, record} <- normalize_record(raw),
         {:ok, at_ms} <- at_ms(record) do
      {:ok, Map.put(record, :at_ms, at_ms)}
    else
      _ -> :skip
    end
  end

  # The one place the harness shapes meet. A pi record announces itself by its
  # envelope — `"type": "message"` with the turn nested under `"message"`, a
  # shape Claude never uses. A Codex record announces itself by the outer
  # `response_item` envelope and its payload type. Both are translated here;
  # everything downstream — prose, delegation register, tool listing — runs
  # on one canonical vocabulary.
  defp normalize_record(%{"type" => "message", "message" => %{"role" => role} = msg} = raw)
       when role in ~w(user assistant toolResult) do
    {:ok,
     %{
       "type" => if(role == "toolResult", do: "user", else: role),
       "timestamp" => raw["timestamp"],
       "message" => %{"content" => pi_content(role, msg)}
     }}
  end

  defp normalize_record(%{"type" => "response_item", "payload" => payload} = raw)
       when is_map(payload) do
    case payload["type"] do
      "message" -> codex_message(raw, payload)
      "custom_tool_call" -> codex_tool_call(raw, payload)
      "function_call" -> codex_tool_call(raw, payload)
      "custom_tool_call_output" -> codex_tool_result(raw, payload)
      "function_call_output" -> codex_tool_result(raw, payload)
      "agent_message" -> codex_agent_message(raw, payload)
      _ -> {:ok, raw}
    end
  end

  # Codex names the root agent `/root` and child sessions by their
  # `agent_path` (for example `/root/reviewer`). Older records may only carry
  # `agent_nickname`, which is a fallback. This is the stable identity used by
  # native `agent_message` routing; it is not derived from the message body.
  defp normalize_record(%{"type" => "session_meta", "payload" => payload} = raw)
       when is_map(payload) do
    self = codex_agent_path(payload)

    if self, do: {:ok, Map.put(raw, "codex_self", self)}, else: {:ok, raw}
  end

  defp normalize_record(raw), do: {:ok, raw}

  defp codex_agent_path(payload) do
    case present_string(payload["agent_path"]) do
      nil ->
        case present_string(payload["agent_nickname"]) do
          nil -> nil
          nickname -> "/root/#{nickname}"
        end

      path ->
        path
    end
  end

  defp present_string(value) when is_binary(value) do
    case String.trim(value) do
      "" -> nil
      value -> value
    end
  end

  defp present_string(_), do: nil

  # Codex's developer messages are injected context, not words spoken by the
  # user. Keep them in the canonical shape with the same `isMeta` marker Claude
  # uses, so the ordinary role/text filter makes the same decision for both.
  defp codex_message(raw, %{"role" => role} = payload)
       when role in ~w(user assistant developer) do
    record = %{
      "type" => if(role == "developer", do: "user", else: role),
      "timestamp" => raw["timestamp"],
      "message" => %{"content" => codex_content(payload["content"])}
    }

    if role == "developer", do: {:ok, Map.put(record, "isMeta", true)}, else: {:ok, record}
  end

  defp codex_message(_raw, _payload), do: {:ok, %{"type" => "codex_machine"}}

  defp codex_tool_call(raw, %{"call_id" => id, "name" => name} = payload)
       when is_binary(id) and is_binary(name) do
    {:ok,
     %{
       "type" => "assistant",
       "timestamp" => raw["timestamp"],
       "message" => %{
         "content" => [
           %{
             "type" => "tool_use",
             "id" => id,
             "name" => codex_tool_name(name),
             "input" => codex_tool_input(name, payload["input"] || payload["arguments"])
           }
         ]
       }
     }}
  end

  defp codex_tool_call(_raw, _payload), do: {:ok, %{"type" => "codex_machine"}}

  defp codex_tool_result(raw, %{"call_id" => id} = payload) when is_binary(id) do
    {:ok,
     %{
       "type" => "user",
       "timestamp" => raw["timestamp"],
       "message" => %{
         "content" => [
           %{
             "type" => "tool_result",
             "tool_use_id" => id,
             "content" => from_content(codex_content(payload["output"]))
           }
         ]
       }
     }}
  end

  defp codex_tool_result(_raw, _payload), do: {:ok, %{"type" => "codex_machine"}}

  # Native Codex peer messages are the closest equivalent to Claude's
  # `<teammate-message>` return envelope. Keep the author and body in a small
  # private canonical record; `delegation/3` turns it into the same return
  # register without manufacturing XML or treating it as ordinary prose.
  defp codex_agent_message(raw, payload) do
    {:ok,
     %{
       "type" => "codex_agent_message",
       "timestamp" => raw["timestamp"],
       "name" => agent_name(payload["author"]),
       "author" => payload["author"],
       "recipient" => payload["recipient"],
       "content" => from_content(codex_content(payload["content"]))
     }}
  end

  defp codex_content(content) when is_binary(content),
    do: [%{"type" => "text", "text" => content}]

  defp codex_content(blocks) when is_list(blocks) do
    Enum.flat_map(blocks, fn
      %{"type" => type, "text" => text}
      when type in ~w(input_text output_text text) and is_binary(text) ->
        [%{"type" => "text", "text" => text}]

      _block ->
        []
    end)
  end

  defp codex_content(_), do: []

  # Keep Codex's orchestration operation distinct from Claude's `Bash`: the
  # payload is generated harness source, not a shell command we can safely
  # summarize. The remaining native coordination names stay visible, just
  # rendered readably.
  defp codex_tool_name("exec"), do: "Exec"
  defp codex_tool_name("spawn_agent"), do: "Subagent"

  defp codex_tool_name(name) do
    name |> String.split("_") |> Enum.map_join(" ", &String.capitalize/1)
  end

  # Codex's exec payload is usually orchestration source for the harness
  # (tools.exec_command(...)), not a shell command. Keep the call visible
  # under its native name without copying generated source into a hover hint.
  defp codex_tool_input("exec", _input), do: %{}
  defp codex_tool_input(_name, input) when is_map(input), do: input

  defp codex_tool_input(_name, input) when is_binary(input) do
    case Jason.decode(input) do
      {:ok, decoded} when is_map(decoded) -> decoded
      _ -> %{"arguments" => input}
    end
  end

  defp codex_tool_input(_name, _input), do: %{}

  # A pi turn's content, in claude's block vocabulary. Assistant `toolCall`
  # blocks become `tool_use` (lowercase name capitalized, so a pi minute reads
  # like a claude one); a `toolResult` turn — a record of its own in pi, where
  # claude nests the result inside a user record — becomes a user record
  # carrying one `tool_result` block keyed the way `result_mark/4` looks it up.
  defp pi_content("assistant", %{"content" => blocks}) when is_list(blocks) do
    Enum.map(blocks, fn
      %{"type" => "toolCall", "id" => id, "name" => name} = block when is_binary(name) ->
        %{
          "type" => "tool_use",
          "id" => id,
          "name" => String.capitalize(name),
          "input" => block["arguments"] || %{}
        }

      # A toolCall block that lost its id or name would otherwise fall through
      # the catch-all unchanged, fail every downstream tool_use match, and
      # vanish from the minute — harness drift made visible instead of quiet.
      %{"type" => "toolCall"} = block ->
        Logger.debug("shuttle moment: unmatched pi toolCall block: #{inspect(block)}")
        block

      block ->
        block
    end)
  end

  defp pi_content("assistant", content), do: content

  defp pi_content("user", %{"content" => content}), do: content

  defp pi_content("user", _), do: []

  defp pi_content("toolResult", %{"toolCallId" => id, "content" => blocks}) do
    [%{"type" => "tool_result", "tool_use_id" => id, "content" => from_content(blocks)}]
  end

  defp pi_content("toolResult", _), do: []

  # A record's excerpts: its delegation, if it is one end of one, else its
  # prose. Never both — a record that spawned an agent said nothing else worth
  # quoting, and one carrying a report is the report.
  defp excerpt_for(%{"isSidechain" => true}, _max_chars, _spawns), do: []

  defp excerpt_for(record, max_chars, spawns) do
    case delegation(record, max_chars, spawns) do
      # Not a delegation at all — whatever else it is, it may be prose.
      :none -> prose(record, max_chars)
      # A delegation envelope that reported nothing (an idle ping, a launch
      # receipt) is SILENCE, not prose. Falling through would print the
      # envelope's own markup as if someone had typed it.
      marks -> marks
    end
  end

  defp prose(record, max_chars) do
    with {:ok, role} <- role(record),
         {:ok, text} <- text(record, max_chars) do
      [%{at_ms: record.at_ms, role: role, text: text, kind: "prose", name: nil}]
    else
      _ -> []
    end
  end

  # ── The delegation register ────────────────────────────────────────────────

  # Every spawn `tool_use` id seen so far, mapped to who it sent. The id is how
  # a `tool_result` names the call it closes.
  defp note_spawns(spawns, %{"type" => "assistant", "message" => %{"content" => blocks}})
       when is_list(blocks) do
    Enum.reduce(blocks, spawns, fn
      %{"type" => "tool_use", "id" => id, "name" => tool, "input" => input}, acc
      when is_binary(id) and is_map(input) ->
        if tool in @spawn_tools, do: Map.put(acc, id, spawn_name(input)), else: acc

      _block, acc ->
        acc
    end)
  end

  defp note_spawns(spawns, _record), do: spawns

  # Who was sent. `name` is the teammate's own — the same string its report
  # comes back under — so it is preferred; `task_name` is Codex's safe native
  # label (its full spawn message is encrypted); `subagent_type` (Claude) and
  # `agent` (pi) name the role when nobody named the agent; `description` is
  # the caller's own summary of the errand and is the last resort.
  defp spawn_name(input) do
    agent_name(input["name"]) || agent_name(input["subagent_type"]) ||
      agent_name(input["agent"]) || agent_name(input["task_name"]) ||
      agent_name(input["description"])
  end

  defp delegation(%{"type" => "assistant", "message" => %{"content" => blocks}} = record, max, _s)
       when is_list(blocks) do
    Enum.flat_map(blocks, fn
      %{"type" => "tool_use", "name" => tool, "input" => input} when is_map(input) ->
        if tool in @spawn_tools,
          do:
            mark(
              record,
              "assistant",
              "spawn",
              spawn_name(input),
              input["prompt"] || input["task"] || input["description"] || input["task_name"],
              max
            ),
          else: []

      _block ->
        []
    end)
    |> recognized()
  end

  defp delegation(
         %{
           "type" => "codex_agent_message",
           "content" => content,
           "name" => name,
           "recipient" => recipient,
           codex_self: self
         } = record,
         max,
         _spawns
       )
       when is_binary(content) and is_binary(recipient) and recipient == self,
       do: mark(record, "user", "return", name, content, max)

  # An outgoing native message is already represented by the parent tool call;
  # it is not a peer return. If identity metadata is absent, suppressing the
  # record is the honest fallback rather than presenting directionless machine
  # traffic as something the other agent said to us.
  defp delegation(%{"type" => "codex_agent_message"}, _max, _spawns), do: []

  defp delegation(
         %{"type" => "user", "message" => %{"content" => content}} = record,
         max,
         spawns
       ),
       do: returns(record, content, max, spawns)

  defp delegation(%{"type" => "user", "content" => content} = record, max, _spawns)
       when is_binary(content),
       do: notice(record, content, max)

  defp delegation(_record, _max, _spawns), do: :none

  # An assistant turn with no spawn call in it, or a user turn carrying neither
  # a report nor a report's envelope, is not a delegation record — it goes on
  # to be read as prose.
  defp recognized([]), do: :none
  defp recognized(marks), do: marks

  # A report comes back either as the tool result that closes the spawn, or —
  # when the agent ran asynchronously and the call returned a receipt — as a
  # notification record arriving later. Both are read; the tool result wins
  # when a record somehow carries both.
  defp returns(record, content, max, spawns) when is_list(content) do
    case Enum.flat_map(content, &result_mark(record, &1, max, spawns)) do
      [] -> notice(record, from_content(content), max)
      marks -> marks
    end
  end

  defp returns(record, content, max, _spawns) when is_binary(content),
    do: notice(record, content, max)

  defp returns(_record, _content, _max, _spawns), do: :none

  defp result_mark(record, %{"type" => "tool_result", "tool_use_id" => id} = block, max, spawns)
       when is_binary(id) do
    case Map.fetch(spawns, id) do
      {:ok, name} -> report(record, name, result_text(block["content"]), max)
      :error -> []
    end
  end

  defp result_mark(_record, _block, _max, _spawns), do: []

  defp result_text(content) when is_binary(content), do: content
  defp result_text(content) when is_list(content), do: from_content(content)
  defp result_text(_), do: ""

  # `<task-notification>` and `<teammate-message>` — the two envelopes a report
  # arrives in when the agent that wrote it was not waited on.
  defp notice(record, text, max) when is_binary(text) do
    cond do
      String.contains?(text, "<task-notification>") ->
        summary = tag(text, "summary")
        report(record, agent_name(titled(summary)), tag(text, "result") || summary || "", max)

      String.contains?(text, "<teammate-message") ->
        report(record, agent_name(attr(text, "teammate_id")), inner(text) || "", max)

      true ->
        :none
    end
  end

  defp notice(_record, _text, _max), do: :none

  # A report that is a launch receipt or an idle ping is not a report. Both are
  # machine bookkeeping that happens to travel in a report's envelope, and
  # drawing them would put a line on the rail for nothing having been said.
  defp report(record, name, text, max) when is_binary(text) do
    if String.contains?(text, @internal_result) or
         String.starts_with?(String.trim_leading(text), @idle_report) or
         codex_launch_receipt?(text),
       do: [],
       else: mark(record, "user", "return", name, text, max)
  end

  defp report(_record, _name, _text, _max), do: []

  # Codex returns a small JSON receipt for an asynchronous `spawn_agent` call:
  # `{"task_name":"/root/reviewer"}`. It is not the worker's report. The
  # native peer `agent_message` that follows is the readable return, so keep
  # this machine-only shape out of the delegation rail while still allowing
  # arbitrary human-readable JSON reports through.
  defp codex_launch_receipt?(text) do
    case Jason.decode(String.trim(text)) do
      {:ok, %{"task_name" => task_name}} when is_binary(task_name) -> true
      _ -> false
    end
  end

  defp mark(record, role, kind, name, text, max) do
    case trim(text || "", delegation_chars(max)) do
      {:ok, body} ->
        [%{at_ms: record.at_ms, role: role, text: body, kind: kind, name: name}]

      _ ->
        []
    end
  end

  # A delegation's cut. The ordinary hover gets the shorter bound; a caller that
  # asked for MORE than prose's ordinary length is the pinned tooltip, and it
  # gets everything, because a report is exactly what a reader pins to read.
  defp delegation_chars(max) when max > @max_chars, do: max
  defp delegation_chars(max), do: min(max, @delegation_chars)

  defp tag(text, name) do
    captured(Regex.run(~r/<#{name}>(.*?)<\/#{name}>/s, text))
  end

  defp attr(text, name) do
    captured(Regex.run(~r/#{name}="([^"]*)"/, text))
  end

  defp inner(text) do
    captured(Regex.run(~r/<teammate-message[^>]*>(.*?)<\/teammate-message>/s, text))
  end

  # The raw capture, uncut: a report's body is trimmed once, by `mark/6`, at
  # whatever bound this fetch asked for. Cutting here would quietly cap a pinned
  # tooltip's full text at the hover's length.
  defp captured([_whole, value]) do
    if String.trim(value) == "", do: nil, else: value
  end

  defp captured(_), do: nil

  # An agent's name is a label, not prose: one line's worth, whatever the
  # excerpt bound is.
  defp agent_name(value), do: described(value, @name_chars)

  # A task notification's summary is a sentence ABOUT the agent — `Agent "…"
  # finished` — and the quoted part is the agent. The sentence around it says
  # only what the arrow already says, so the quotation is the name and the rest
  # is dropped. A summary with no quotation is used whole.
  defp titled(summary) when is_binary(summary) do
    case Regex.run(~r/"([^"]+)"/, summary) do
      [_whole, title] -> title
      _ -> summary
    end
  end

  defp titled(other), do: other

  # `{name, footer_hint, line_hint}` per assistant `tool_use` block, in the
  # order they were made. `footer_hint` is what the aggregate's dominant-tool
  # hint may show (Bash's own words only — see `hint/2`); `line_hint` is what
  # a per-call line may show, which also trusts a path or pattern once it has
  # a line to itself (see `call_hint/2`).
  defp tool_calls(%{"type" => "assistant", "message" => %{"content" => blocks}})
       when is_list(blocks) do
    for %{"type" => "tool_use", "name" => name} = block <- blocks, is_binary(name), name != "" do
      input = block["input"]
      {name, hint(name, input), call_hint(name, input)}
    end
  end

  defp tool_calls(_), do: []

  # A Bash call's own words, else the command it ran.
  #
  # `description` is optional and often absent, and a bare "Bash" tells a reader
  # nothing they did not already know from the fact that a minute had tool calls
  # in it. The command string is the next best account of what happened — it is
  # not prose, but `git status --short` is a far better answer to "what was this
  # minute" than the tool's name alone. Trimmed to the same 48 characters and
  # collapsed of whitespace by `trim/2`, so a heredoc becomes one line.
  defp hint(name, input) when is_map(input) do
    if name in @hint_tools do
      described(input["description"], @tool_hint_chars) ||
        described(input["command"], @tool_hint_chars)
    end
  end

  defp hint(_name, _input), do: nil

  defp described(text, max) when is_binary(text) do
    case trim(text, max) do
      {:ok, hint} -> hint
      _ -> nil
    end
  end

  defp described(_, _), do: nil

  defp call_hint(name, input), do: hint(name, input) || path_hint(name, input)

  # Claude names the file argument `file_path`; pi names it `path`.
  defp path_hint(name, %{"file_path" => path})
       when name in @path_hint_tools and is_binary(path) do
    case trim(Path.basename(path), @tool_hint_chars) do
      {:ok, base} -> base
      _ -> nil
    end
  end

  defp path_hint(name, %{"path" => path})
       when name in @path_hint_tools and is_binary(path) do
    case trim(Path.basename(path), @tool_hint_chars) do
      {:ok, base} -> base
      _ -> nil
    end
  end

  defp path_hint(name, %{"pattern" => pattern})
       when name in @pattern_hint_tools and is_binary(pattern) do
    case trim(pattern, @tool_hint_chars) do
      {:ok, p} -> p
      _ -> nil
    end
  end

  defp path_hint(_name, _input), do: nil

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
