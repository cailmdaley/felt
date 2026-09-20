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
  def observe(session) do
    case AppWorkers.id(session) do
      nil ->
        :terminal

      id ->
        remote = AppWorkers.client().state(id)

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

          {state, {:ok, %{"active" => true} = record}} when state in [:idle, :running] ->
            if record["remote_state"] != Atom.to_string(state),
              do: AppWorkers.update(id, %{"remote_state" => Atom.to_string(state)})

          _ ->
            :ok
        end

        remote
    end
  end

  def present?(runner, session), do: session_status(runner, session) != :gone

  def stop(runner, session) do
    case AppWorkers.id(session) do
      nil ->
        runner.cmd("tmux", ["kill-session", "-t", session], stderr_to_stdout: true)

      id ->
        result =
          if AppWorkers.client().state(id) == :missing,
            do: :ok,
            else: AppWorkers.client().interrupt(id)

        case result do
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
