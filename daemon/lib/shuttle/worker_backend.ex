defmodule Shuttle.WorkerBackend do
  @moduledoc "Backend operations for terminal workers and durable app conversations."

  alias Shuttle.AppWorkers

  def session_status(runner, session) do
    case AppWorkers.id(session) do
      nil ->
        Shuttle.Terminal.status(runner, session)

      id ->
        case AppWorkers.get(id) do
          {:ok, %{"active" => true}} -> :alive
          {:ok, _} -> :gone
          _ -> :unknown
        end
    end
  end

  @doc "Observe app state without releasing ownership on an idle or uncertain result."
  def observe(session) do
    case AppWorkers.id(session) do
      nil ->
        :terminal

      id ->
        %{state: remote, phase: phase} = AppWorkers.status(id)

        case {remote, AppWorkers.get(id)} do
          {:missing, {:ok, %{"active" => true} = record}} ->
            if record["remote_state"] != "missing" do
              AppWorkers.update(id, %{
                "remote_state" => "missing",
                "launch_state" => "blocked",
                "last_error" =>
                  "The app conversation no longer exists. Start a new session or stop this worker."
              })
            end

          {state, {:ok, %{"active" => true} = record}} ->
            if record["remote_state"] != Atom.to_string(state) or record["remote_phase"] != phase do
              values = %{"remote_state" => Atom.to_string(state), "remote_phase" => phase}

              values =
                if phase && phase != record["remote_phase"],
                  do: Map.put(values, "phase_changed_at", System.system_time(:millisecond)),
                  else: values

              AppWorkers.update(id, values)
            end

          _ ->
            :ok
        end

        remote
    end
  end

  @doc """
  Release a finished assignment without ending or reloading its conversation.

  Retiring also closes the assignment's terminal viewer, as a Claude worker's
  exit verb ends its own tmux session: the turn is already idle or unloaded,
  and the thread's identity and rollout stay with the App Server, so attach or
  resume can open a new viewer later. A viewer that fails to stop is left for
  `Shuttle.CodexTerminal.sweep/1`.
  """
  def retire_assignment(runner, session, fiber) do
    with id when is_binary(id) <- AppWorkers.id(session),
         {:ok, record} <- AppWorkers.get(id),
         true <- completed?(AppWorkers.state(id), fiber, assignment_start(record)),
         :ok <- retire(runner, session, id, fiber) do
      :retired
    else
      _ -> :retained
    end
  end

  # Under the terminal lock, without waiting for it: a viewer being prepared or
  # stopped elsewhere retires on a later poll. The state is read again inside
  # the lock so a turn started meanwhile keeps its assignment.
  defp retire(runner, session, id, fiber) do
    :global.trans(
      {{Shuttle.CodexTerminal, id}, self()},
      fn ->
        with {:ok, record} <- AppWorkers.get(id),
             true <- completed?(AppWorkers.state(id), fiber, assignment_start(record)),
             :ok <- AppWorkers.deactivate(id) do
          case tmux(session) do
            nil ->
              :ok

            terminal ->
              Shuttle.Terminal.stop(runner, terminal)
          end

          :ok
        else
          _ -> :retained
        end
      end,
      [node()],
      0
    )
  end

  # Unloaded/missing threads and native system errors cannot be doing work.
  # Idle alone is still a conversation waiting for input, not a completed assignment.
  defp completed?(state, _fiber, _start)
       when state in [:not_loaded, :missing, :system_error],
       do: true

  defp completed?(:idle, fiber, start), do: assignment_ended?(fiber, start)
  defp completed?(_state, _fiber, _start), do: false

  defp assignment_start(record) do
    case record["started_at"] do
      stamp when is_binary(stamp) ->
        case DateTime.from_iso8601(stamp) do
          {:ok, timestamp, _} -> timestamp
          _ -> nil
        end

      _ ->
        nil
    end
  end

  @doc "Completion evidence must belong to this assignment, not an earlier run."
  def assignment_ended?(%{"status" => "closed"}, _started_at), do: true

  def assignment_ended?(fiber, started_at) do
    boundaries =
      [started_at, Shuttle.Continuation.dispatched_at(fiber)]
      |> Enum.filter(&match?(%DateTime{}, &1))

    case Shuttle.Continuation.handed_off_at(fiber) do
      %DateTime{} = handoff when boundaries != [] ->
        Enum.all?(boundaries, &(DateTime.compare(handoff, &1) != :lt))

      _ ->
        false
    end
  end

  def present?(runner, session), do: session_status(runner, session) != :gone

  def stop(runner, session) do
    case AppWorkers.id(session) do
      nil ->
        Shuttle.Terminal.stop(runner, session)

      id ->
        :global.trans({{Shuttle.CodexTerminal, id}, self()}, fn ->
          stop_app(runner, session, id)
        end)
    end
  end

  defp stop_app(runner, session, id) do
    result =
      with :ok <- AppWorkers.check_endpoint(id) do
        if AppWorkers.state(id) == :missing,
          do: :ok,
          else: AppWorkers.call(id, :interrupt)
      end

    case result do
      stopped when stopped in [:ok, {:error, :thread_missing}] ->
        with {_, 0} <- stop_viewer(runner, session),
             :ok <- AppWorkers.deactivate(id) do
          {"", 0}
        else
          {output, _status} -> {output, 1}
          error -> {inspect(error), 1}
        end

      error ->
        {inspect(error), 1}
    end
  end

  defp stop_viewer(runner, session) do
    case tmux(session) do
      nil -> {"", 0}
      terminal -> Shuttle.Terminal.stop(runner, terminal)
    end
  end

  def wire(session) do
    record =
      case AppWorkers.id(session) do
        nil ->
          nil

        id ->
          case AppWorkers.get(id) do
            {:ok, record} -> record
            _ -> nil
          end
      end

    wire(session, record)
  end

  @doc "Build a worker presentation from an already-read ownership record."
  def wire(session, record) do
    case AppWorkers.id(session) do
      nil ->
        %{surface: "cli", tmux_session: session, terminal: terminal_id(session)}

      id ->
        record = if is_map(record), do: record, else: %{}
        surface = record["surface"] || "app"

        %{
          surface: surface,
          tmux_session: if(surface == "cli", do: record["terminal_tmux"]),
          terminal: if(surface == "cli", do: terminal_id(record["terminal_tmux"])),
          session_uuid: id,
          thread_id: id,
          transcript_session_uuid: record["transcript_session_uuid"] || id,
          desktop_link: Shuttle.SessionLink.desktop_url(id),
          project_id: record["project_id"],
          terminal_error: record["terminal_error"],
          backend_error: record["backend_error"]
        }
    end
  end

  defp terminal_id(nil), do: nil

  defp terminal_id(name), do: Shuttle.Terminal.observed_id(name)

  def tmux(session), do: wire(session).tmux_session
end
