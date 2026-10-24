defmodule Shuttle.WorkerBackend do
  @moduledoc "Backend operations for terminal workers and durable app conversations."

  alias Shuttle.AppWorkers

  def session_status(runner, session) do
    case AppWorkers.id(session) do
      nil ->
        Shuttle.Tmux.session_status(runner, session)

      id ->
        case AppWorkers.get(id) do
          {:ok, %{"active" => true}} -> :alive
          {:ok, _} -> :gone
          _ -> :unknown
        end
    end
  end

  @doc "Observe app state without releasing ownership on an idle or uncertain result."
  def observe(session, expected \\ %{}) do
    case AppWorkers.id(session) do
      nil ->
        :terminal

      id ->
        %{state: remote, phase: phase} = AppWorkers.status(id)

        {remote, phase} =
          if remote == :not_loaded do
            case AppWorkers.recover(
                   id,
                   Map.get(expected, :fiber_id),
                   Map.get(expected, :uid),
                   Map.get(expected, :felt_store)
                 ) do
              :ok ->
                %{state: recovered, phase: recovered_phase} = AppWorkers.status(id)
                {recovered, recovered_phase}

              {:error, _} ->
                {remote, phase}
            end
          else
            {remote, phase}
          end

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

  @doc "Release a finished assignment without ending or reloading its conversation."
  def retire_assignment(session, fiber, started_at) do
    with id when is_binary(id) <- AppWorkers.id(session),
         true <- assignment_ended?(fiber, started_at),
         state when state in [:idle, :not_loaded, :missing] <- AppWorkers.state(id),
         :ok <- AppWorkers.deactivate(id) do
      :retired
    else
      _ -> :retained
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
        Shuttle.Tmux.stop(runner, session)

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
      terminal -> Shuttle.Tmux.stop(runner, terminal)
    end
  end

  def wire(session) do
    case AppWorkers.id(session) do
      nil ->
        %{surface: "cli", tmux_session: session}

      id ->
        record =
          case AppWorkers.get(id) do
            {:ok, record} -> record
            _ -> %{}
          end

        surface = record["surface"] || "app"

        %{
          surface: surface,
          tmux_session: if(surface == "cli", do: record["terminal_tmux"]),
          session_uuid: id,
          thread_id: id,
          transcript_session_uuid: AppWorkers.transcript_id(id),
          desktop_link: Shuttle.SessionLink.desktop_url(id),
          project_id: record["project_id"],
          terminal_error: record["terminal_error"],
          backend_error: record["backend_error"]
        }
    end
  end

  def tmux(session), do: wire(session).tmux_session
end
