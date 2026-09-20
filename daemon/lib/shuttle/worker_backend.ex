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

  def present?(runner, session), do: session_status(runner, session) != :gone

  def stop(runner, session) do
    case AppWorkers.id(session) do
      nil ->
        runner.cmd("tmux", ["kill-session", "-t", session], stderr_to_stdout: true)

      id ->
        case AppWorkers.client().interrupt(id) do
          :ok ->
            case AppWorkers.deactivate(id) do
              :ok -> {"", 0}
              error -> {inspect(error), 1}
            end

          error ->
            {inspect(error), 1}
        end
    end
  end

  def wire(session) do
    case AppWorkers.id(session) do
      nil ->
        %{surface: "cli", tmux_session: session}

      id ->
        project_id =
          case AppWorkers.get(id) do
            {:ok, record} -> record["project_id"]
            _ -> nil
          end

        %{surface: "app", tmux_session: nil, session_uuid: id, project_id: project_id}
    end
  end

  def tmux(session), do: if(AppWorkers.app?(session), do: nil, else: session)
end
