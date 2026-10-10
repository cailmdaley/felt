defmodule Shuttle.WaitingTracker do
  @moduledoc """
  A pure per-harness-session state machine over the host's hook-event stream.

  Sessions are keyed by nonempty `sessionId`, independently of tmux naming.
  Each record tracks turn state, outstanding Claude background work, Codex
  children, a pending human request, its last activity time, and its harness.
  `phases/2` derives attention, working, or waiting; background work only
  suppresses waiting for one hour after the session's last event.

  Event timestamps are activity timestamps, not an ordering authority. Events
  fold in stream order, while `at` never moves backward when timestamps arrive
  out of order. Event identities and their ingestion order distinguish a
  retained prefix from unread suffixes during replay, within a 48-hour window.
  """

  @bg_suppress_ms 60 * 60 * 1_000
  @max_age_ms 48 * 60 * 60 * 1_000
  @unknown_session "unknown"

  defmodule Session do
    @moduledoc false
    defstruct turn: :open,
              bg: 0,
              kids: 0,
              pending: false,
              at: 0,
              harness: nil,
              child_events: %{},
              events: %{},
              sequence: 0
  end

  @type sessions :: %{optional(String.t()) => %Session{}}

  @doc "Derives each session's timestamp and phase at `now`."
  @spec phases(sessions(), integer()) ::
          %{optional(String.t()) => %{last_event_at: integer(), phase: String.t()}}
  def phases(sessions, now) do
    Map.new(sessions, fn {id, session} ->
      live = now - session.at < @bg_suppress_ms and session.turn != :ended

      phase =
        cond do
          session.pending -> "attention"
          session.turn == :open -> "working"
          live and session.bg + session.kids > 0 -> "working"
          true -> "waiting"
        end

      {id, %{last_event_at: session.at, phase: phase}}
    end)
  end

  @doc "Applies one decoded event to the session map."
  @spec apply_event(sessions(), map(), integer()) :: sessions()
  def apply_event(sessions, %{"type" => "file_sent"}, _now), do: sessions

  def apply_event(sessions, %{"type" => type, "sessionId" => id} = event, now)
      when is_binary(type) and is_binary(id) and id != "" and id != @unknown_session do
    session = Map.get(sessions, id, %Session{harness: event["harness"]})

    case transition(session, type, event, now) do
      :ignore -> sessions
      updated -> Map.put(sessions, id, remember_event(updated, event, now))
    end
  end

  def apply_event(sessions, _event, _now), do: sessions

  @doc "Removes sessions whose last activity is older than 48 hours at `now`."
  @spec prune(sessions(), integer()) :: sessions()
  def prune(sessions, now) do
    cutoff = now - @max_age_ms

    sessions
    |> Map.reject(fn {_id, session} -> session.at < cutoff end)
    |> Map.new(fn {id, session} -> {id, trim_events(session, cutoff)} end)
  end

  @doc "Replays unseen suffix events onto known facts without rewinding retained prefixes."
  @spec replay_events(sessions(), [map()], integer()) :: sessions()
  def replay_events(known, events, now) do
    events
    |> Enum.group_by(& &1["sessionId"])
    |> Enum.reduce(known, fn {id, events}, sessions ->
      case known[id] do
        nil -> Enum.reduce(events, sessions, &apply_event(&2, &1, now))
        session -> replay_session(sessions, session, events, now)
      end
    end)
  end

  defp replay_session(sessions, session, events, now) do
    # Only the last known transition anchors an unread suffix. An earlier
    # known event can belong to an incomplete prefix missing the real tail.
    frontier =
      Enum.find_index(events, fn event ->
        case session.events[event_key(event)] do
          {sequence, _at} -> sequence == session.sequence
          nil -> false
        end
      end)

    events
    |> Enum.with_index()
    |> Enum.reduce(sessions, fn {event, index}, sessions ->
      current = sessions[event["sessionId"]]
      unseen = not Map.has_key?(current.events, event_key(event))

      follows =
        if is_nil(frontier),
          do: event_at(event, now) > session.at,
          else: index > frontier

      recent = event_at(event, now) >= now - @max_age_ms
      if unseen and follows and recent, do: apply_event(sessions, event, now), else: sessions
    end)
  end

  defp event_key(%{"id" => id}) when is_binary(id) and id != "", do: {:id, id}

  defp event_key(event),
    do: {:content, :crypto.hash(:sha256, :erlang.term_to_binary(event, [:deterministic]))}

  defp remember_event(session, event, now) do
    sequence = session.sequence + 1
    events = Map.put(session.events, event_key(event), {sequence, event_at(event, now)})
    %{session | events: events, sequence: sequence}
  end

  defp transition(session, type, event, now) do
    if rejected_child_event?(session, type, event, now) do
      :ignore
    else
      do_transition(session, type, event, now)
    end
  end

  defp do_transition(session, "session_end", event, now) do
    touch(session, event, now,
      turn: :ended,
      bg: 0,
      kids: 0,
      pending: false,
      child_events: %{}
    )
  end

  defp do_transition(session, "session_start", event, now) do
    touch(session, event, now,
      turn: :open,
      bg: 0,
      kids: 0,
      pending: false,
      child_events: %{}
    )
  end

  defp do_transition(%Session{turn: :ended}, _type, _event, _now), do: :ignore

  defp do_transition(session, "user_prompt_submit", event, now) do
    touch(session, event, now, turn: :open, bg: 0, pending: false)
  end

  defp do_transition(session, "stop", event, now) do
    touch(session, event, now,
      turn: :closed,
      bg: background_tasks(event),
      pending: false
    )
  end

  defp do_transition(session, "notification", event, now) do
    pending =
      if Map.get(event, "notificationKind") == "idle_prompt", do: session.pending, else: true

    touch(session, event, now, turn: :closed, pending: pending)
  end

  defp do_transition(session, type, event, now) when type in ["pre_tool_use", "post_tool_use"] do
    session = child_started(session, type, event, now)
    keep_closed = session.turn == :closed and session.harness == "codex" and session.kids > 0

    touch(session, event, now,
      turn: if(keep_closed, do: :closed, else: :open),
      pending: if(keep_closed, do: session.pending, else: false)
    )
  end

  defp do_transition(session, "subagent_stop", event, now) do
    if session.harness == "codex" and codex_event?(event, session) and session.kids > 0 do
      session = remember_child_event(session, event, now)
      kids = session.kids - 1

      if kids == 0 and session.turn == :closed do
        %{session | kids: 0, at: max(session.at, event_at(event, now))}
      else
        %{session | kids: kids}
      end
    else
      :ignore
    end
  end

  defp do_transition(_session, _type, _event, _now), do: :ignore

  defp touch(session, event, now, changes) do
    at = max(session.at, event_at(event, now))
    harness = Map.get(event, "harness", session.harness)
    struct(session, Keyword.merge([at: at, harness: harness], changes))
  end

  defp child_started(
         session,
         "post_tool_use",
         %{"harness" => "codex", "tool" => tool} = event,
         now
       )
       when tool in ["collaborationspawn_agent", "collaborationfollowup_task"] do
    case event["id"] do
      id when is_binary(id) and id != "" ->
        session
        |> remember_child_event(event, now)
        |> Map.update!(:kids, &(&1 + 1))

      _ ->
        Map.update!(session, :kids, &(&1 + 1))
    end
  end

  defp child_started(session, _type, _event, _now), do: session

  defp rejected_child_event?(session, type, event, now) do
    if identified_child_event?(type, event) do
      id = event["id"]
      event_at(event, now) < now - @max_age_ms or Map.has_key?(session.child_events, id)
    else
      false
    end
  end

  defp identified_child_event?("post_tool_use", %{
         "harness" => "codex",
         "tool" => tool,
         "id" => id
       })
       when tool in ["collaborationspawn_agent", "collaborationfollowup_task"] and is_binary(id) and
              id != "",
       do: true

  defp identified_child_event?("subagent_stop", %{"harness" => "codex", "id" => id})
       when is_binary(id) and id != "",
       do: true

  defp identified_child_event?(_type, _event), do: false

  defp remember_child_event(session, event, now) do
    case event["id"] do
      id when is_binary(id) and id != "" ->
        cutoff = now - @max_age_ms
        events = Map.put(session.child_events, id, event_at(event, now))
        %{session | child_events: Map.reject(events, fn {_id, at} -> at < cutoff end)}

      _ ->
        session
    end
  end

  defp trim_events(session, cutoff) do
    %{
      session
      | child_events: Map.reject(session.child_events, fn {_id, at} -> at < cutoff end),
        events: Map.reject(session.events, fn {_key, {_sequence, at}} -> at < cutoff end)
    }
  end

  defp codex_event?(%{"harness" => "codex"}, _session), do: true
  defp codex_event?(_event, _session), do: false

  defp background_tasks(%{"backgroundTasks" => count}) when is_integer(count) and count > 0,
    do: count

  defp background_tasks(_event), do: 0

  defp event_at(%{"timestamp" => at}, _now) when is_integer(at), do: at
  defp event_at(_event, now), do: now
end
