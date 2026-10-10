defmodule Shuttle.SessionBinding do
  @moduledoc """
  Receiver succession inferred from explicit session starts, never from panes.
  A known UUID anchors a worker to the first receiver observed for that UUID.
  Other receivers cannot acquire that UUID, and ordinary hooks cannot switch
  a receiver's current session. Missing receiver metadata preserves direct UUID
  joins. Evidence survives session ends and is retained for 48 hours of activity.
  """

  @max_age_ms 48 * 60 * 60 * 1000

  def new, do: %{members: %{}, processes: %{}}

  def valid_id?(id), do: is_binary(id) and id not in ["", "unknown"]

  def apply_event(state, event, now) do
    id = event["sessionId"]
    pid = event["receiverPid"]
    birth = event["receiverBirth"]
    harness = if event["harness"] == "claude-code", do: "claude", else: event["harness"]
    at = event["timestamp"]

    if valid_id?(id) and is_integer(pid) and pid > 0 and is_binary(birth) and birth != "" and
         harness in ["claude", "codex", "pi"] and is_integer(at) and at >= now - @max_age_ms do
      key = {harness, pid, birth}
      owner = Map.get(state.members, id)
      process = Map.get(state.processes, key)

      start_key = event["id"] || {id, at}

      next =
        cond do
          event["type"] == "session_start" and process != nil and start_key in process.starts ->
            state

          process != nil and Map.get(process, :retired, false) ->
            state

          owner != nil and owner != key ->
            previous = Map.fetch!(state.processes, owner)

            if event["type"] == "session_start" and at > previous.at do
              state = %{
                state
                | processes: Map.put(state.processes, owner, Map.put(previous, :retired, true)),
                  members: Enum.reduce(previous.members, state.members, &Map.put(&2, &1, key))
              }

              put(state, key, id, at, previous.members)
            else
              state
            end

          process == nil ->
            put(state, key, id, at, MapSet.new([id]))

          at < process.at ->
            state

          event["type"] == "session_start" ->
            put(state, key, id, at, MapSet.put(process.members, id))

          owner == key ->
            put(state, key, process.current, at, process.members)

          true ->
            state
        end

      if event["type"] == "session_start" and next != state do
        update_in(next, [:processes, key, :starts], &Enum.take([start_key | &1], 256))
      else
        next
      end
    else
      state
    end
  end

  @doc "Whether receiver-bearing evidence belongs to the current session lifetime."
  def accept_event?(state, event) do
    pid = event["receiverPid"]
    birth = event["receiverBirth"]
    harness = if event["harness"] == "claude-code", do: "claude", else: event["harness"]

    if is_integer(pid) and pid > 0 and is_binary(birth) and birth != "" and
         harness in ["claude", "codex", "pi"] do
      key = {harness, pid, birth}

      case Map.get(state.processes, key) do
        %{current: id, retired: false} ->
          id == event["sessionId"] and Map.get(state.members, id) == key

        _ ->
          false
      end
    else
      true
    end
  end

  def current(state, anchor) do
    if valid_id?(anchor) do
      with key when not is_nil(key) <- Map.get(state.members, anchor),
           %{current: current} <- Map.get(state.processes, key) do
        current
      else
        _ -> anchor
      end
    end
  end

  def prune(state, now) do
    processes = Map.reject(state.processes, fn {_key, p} -> p.at < now - @max_age_ms end)
    rebuild(processes)
  end

  defp put(state, key, id, at, members) do
    %{
      state
      | members: Enum.reduce(members, state.members, &Map.put_new(&2, &1, key)),
        processes:
          Map.put(state.processes, key, %{
            current: id,
            at: at,
            members: members,
            retired: false,
            starts: get_in(state, [:processes, key, :starts]) || []
          })
    }
  end

  defp rebuild(processes) do
    members =
      Enum.reduce(processes, %{}, fn {key, p}, members ->
        if Map.get(p, :retired, false),
          do: members,
          else: Enum.reduce(p.members, members, &Map.put_new(&2, &1, key))
      end)

    %{members: members, processes: processes}
  end
end
