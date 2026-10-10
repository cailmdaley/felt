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
  out of order. Event ids deduplicate child-count mutations during replay.
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
              child_events: MapSet.new()
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
      updated -> Map.put(sessions, id, updated)
    end
  end

  def apply_event(sessions, _event, _now), do: sessions

  @doc "Removes sessions whose last activity is older than 48 hours at `now`."
  @spec prune(sessions(), integer()) :: sessions()
  def prune(sessions, now) do
    cutoff = now - @max_age_ms
    Map.reject(sessions, fn {_id, session} -> session.at < cutoff end)
  end

  @doc "Merges a rebuild with known state, preferring the newer activity timestamp."
  @spec merge_known(sessions(), sessions()) :: sessions()
  def merge_known(known, rebuilt) do
    Map.merge(known, rebuilt, fn _id, old, new -> if new.at >= old.at, do: new, else: old end)
  end

  defp transition(session, "session_end", event, now) do
    touch(session, event, now, turn: :ended, bg: 0, kids: 0, pending: false)
  end

  defp transition(session, "session_start", event, now) do
    touch(session, event, now,
      turn: :open,
      bg: 0,
      kids: 0,
      pending: false,
      child_events: MapSet.new()
    )
  end

  defp transition(%Session{turn: :ended}, _type, _event, _now), do: :ignore

  defp transition(session, "user_prompt_submit", event, now) do
    touch(session, event, now, turn: :open, bg: 0, pending: false)
  end

  defp transition(session, "stop", event, now) do
    touch(session, event, now,
      turn: :closed,
      bg: background_tasks(event),
      pending: false
    )
  end

  defp transition(session, "notification", event, now) do
    pending =
      if Map.get(event, "notificationKind") == "idle_prompt", do: session.pending, else: true

    touch(session, event, now, turn: :closed, pending: pending)
  end

  defp transition(session, type, event, now) when type in ["pre_tool_use", "post_tool_use"] do
    session = child_started(session, type, event)
    keep_closed = session.turn == :closed and session.harness == "codex" and session.kids > 0
    touch(session, event, now, turn: if(keep_closed, do: :closed, else: :open), pending: false)
  end

  defp transition(session, "subagent_stop", event, now) do
    if session.harness == "codex" and codex_event?(event, session) and session.kids > 0 and
         first_child_event?(session, event) do
      session = remember_child_event(session, event)
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

  defp transition(_session, _type, _event, _now), do: :ignore

  defp touch(session, event, now, changes) do
    at = max(session.at, event_at(event, now))
    harness = Map.get(event, "harness", session.harness)
    struct(session, Keyword.merge([at: at, harness: harness], changes))
  end

  defp child_started(session, "post_tool_use", %{"harness" => "codex", "tool" => tool} = event)
       when tool in ["collaborationspawn_agent", "collaborationfollowup_task"] do
    if first_child_event?(session, event) do
      session
      |> remember_child_event(event)
      |> Map.update!(:kids, &(&1 + 1))
    else
      session
    end
  end

  defp child_started(session, _type, _event), do: session

  defp first_child_event?(session, event) do
    case event["id"] do
      id when is_binary(id) and id != "" -> not MapSet.member?(session.child_events, id)
      _ -> true
    end
  end

  defp remember_child_event(session, event) do
    case event["id"] do
      id when is_binary(id) and id != "" ->
        %{session | child_events: MapSet.put(session.child_events, id)}

      _ ->
        session
    end
  end

  defp codex_event?(%{"harness" => "codex"}, _session), do: true
  defp codex_event?(_event, _session), do: false

  defp background_tasks(%{"backgroundTasks" => count}) when is_integer(count) and count > 0,
    do: count

  defp background_tasks(_event), do: 0

  defp event_at(%{"timestamp" => at}, _now) when is_integer(at), do: at
  defp event_at(_event, now), do: now
end
