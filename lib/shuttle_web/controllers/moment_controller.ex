defmodule ShuttleWeb.MomentController do
  @moduledoc """
  The words behind a minute:
  `GET /api/v1/moment?session=…&from_ms=…&to_ms=…&host=…`.

      {"host": "hub-mac",
       "excerpts": [{"at_ms": …, "role": "user", "text": "hi french class!…"}]}

  `full=1` asks for the excerpts untruncated — #{Shuttle.Moment.max_chars(true)}
  characters each instead of the ordinary #{Shuttle.Moment.max_chars()}. The
  shape is unchanged; it is the fetch a pinned tooltip makes, where the reader
  has stopped glancing and started reading. Truncation is server-side, so no
  amount of CSS recovers a sentence the ordinary fetch already cut.

  `"tool_lines"` carries what RAN in the window, one call per line
  (`["Bash — run the tests", "Read — moment.ex"]`), and `"tool_count"` says how
  many calls there were before that list was cut. `"excerpt_count"` does the
  same for the words. The counts exist so a client can never claim more than it
  shows: with them it says "showing 6 of 34" and offers the pin (`full=1`) that
  returns all thirty-four; without them it was reduced to printing a number
  from somewhere else entirely beside whatever fraction arrived.

  A `"tools"` field carries the same calls in the older single-string form —
  one call per line
  (`"Bash — run the tests\nRead — moment.ex"`) when there are few enough
  calls to read that way, else the one-line aggregate (`"Bash ×2 · Read"`) —
  see `Shuttle.Moment`'s moduledoc for the threshold. It rides alongside the
  excerpts rather than instead of them: a minute that spoke and also ran forty
  calls is two facts, and a client that could count the calls but never name
  them was the cost of withholding it. Absent only when nothing ran.

  `Shuttle.Moment` does the reading (a Claude Code transcript under
  `~/.claude/projects`); this controller parses the window, decides whose disk
  the words are on, and stamps the host.

  **Host-routed, like `/file` is owner-routed — but the owner here is a host,
  not a fiber.** A transcript lives on the machine that ran the session, so:

    * an explicit `host` that is not this daemon forwards to that daemon's
      identical `/moment` (`OriginRouter.forward_get/4`, the same one leg
      `/file` and `/sent-files` use);
    * with no `host`, `Shuttle.SessionLedger` is asked which host ran the
      session, and the answer routes the same way;
    * anything else is read locally.

  **A hover never fails.** A stale or unreachable remote answers
  `{"excerpts": [], "note": "words live on <host>"}` with a 200, because the
  honest thing to tell someone pointing at a mark is *where* the words are, not
  that a tunnel is down. Same for a missing transcript, a session from another
  harness, or a window with nothing in it — an empty `excerpts`, never a 500.

  Only a malformed request is a 4xx: a missing `session`/bound is a 400, as is
  an inverted or over-wide window (capped at 2 h — see `Shuttle.Moment`).
  """

  use Phoenix.Controller, formats: [:json]

  import ShuttleWeb.RelayHelpers, only: [integer_param: 2, epoch_ms_message: 1, present?: 1]

  alias Shuttle.{Moment, OriginRouter, Poller, Remote, SessionLedger}

  def show(conn, params) do
    with {:ok, session} <- session_param(params),
         {:ok, from_ms} <- integer_param(params, "from_ms"),
         {:ok, to_ms} <- integer_param(params, "to_ms"),
         :ok <- Moment.check_window(from_ms, to_ms) do
      serve(conn, session, from_ms, to_ms, target_host(params, session), full?(params))
    else
      {:error, reason} -> conn |> put_status(400) |> json(%{error: message(reason)})
    end
  end

  # `nil` target = read here. Anything else is a configured remote to forward to.
  defp serve(conn, session, from_ms, to_ms, nil, full?) do
    moment = Moment.moment(session, from_ms, to_ms, full: full?)

    # THE COUNTS RIDE WITH THE ITEMS, UNCONDITIONALLY. They are what lets the
    # reader be told "showing 6 of 34" rather than shown six lines under a
    # claim of thirty-four; a client that only sometimes learns the total is a
    # client that sometimes has to guess, which is the failure this pair fixes.
    body = %{
      host: Poller.own_host_id(),
      excerpts: moment.excerpts,
      excerpt_count: moment.excerpt_count,
      tool_lines: moment.tool_lines,
      tool_count: moment.tool_count
    }

    json(conn, if(moment.tools, do: Map.put(body, :tools, moment.tools), else: body))
  end

  defp serve(conn, session, from_ms, to_ms, %Remote{} = remote, full?) do
    # `host=local` rather than the remote's name: the owner must serve this as
    # its own read, and this makes the hop terminate by construction — no
    # dependence on the remote's name matching its own host id, and no chance
    # of its ledger bouncing the request onward to a third daemon.
    query = %{"session" => session, "from_ms" => from_ms, "to_ms" => to_ms, "host" => "local"}
    query = if full?, do: Map.put(query, "full", "1"), else: query

    case OriginRouter.forward_get(remote, "/api/v1/moment", query) do
      {:forwarded, 200, content_type, body} ->
        conn |> put_resp_content_type(content_type, nil) |> send_resp(200, body)

      # The remote answered, badly — or did not answer at all. Either way the
      # words exist, just not here; say so rather than surfacing plumbing.
      _ ->
        json(conn, %{host: remote.name, excerpts: [], note: "words live on #{remote.name}"})
    end
  end

  # An explicit `host` wins; otherwise the ledger's pairing decides. Either way
  # a name that resolves to this daemon (or to no configured remote) reads
  # locally — `OriginRouter.route/1` is the single arbiter, exactly as for a
  # fiber's origin.
  defp target_host(params, session) do
    name = Map.get(params, "host")
    name = if present?(name), do: name, else: SessionLedger.host_for_session(session)

    case OriginRouter.route(name) do
      {:remote, remote} -> remote
      :local -> nil
    end
  end

  # `full=1` — the pinned tooltip's fetch. Anything falsy-looking is the
  # ordinary hover, so a client that has never heard of the parameter, or sends
  # `full=0`, gets exactly what it always got.
  defp full?(params) do
    case Map.get(params, "full") do
      value when value in ["1", "true", "yes"] -> true
      _ -> false
    end
  end

  defp session_param(params) do
    session = Map.get(params, "session")
    if present?(session), do: {:ok, session}, else: {:error, {:bad_param, "session"}}
  end

  defp message({:bad_param, "session"}), do: "session is required"
  defp message({:bad_param, key}), do: epoch_ms_message(key)
  defp message(:inverted_range), do: "to_ms must be >= from_ms"

  defp message(:range_too_wide),
    do: "window too wide: at most #{div(Moment.max_window_ms(), 60_000)} minutes"
end
