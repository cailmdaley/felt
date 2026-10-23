defmodule Shuttle.WorkerBackend do
  @moduledoc """
  Backend operations for terminal workers and durable app conversations.

  A worker is addressed by its handle (`handle/1`): an app reference
  (`codex-app:<id>`), or a terminal execution's `%{session, uuid, pane}`,
  which is observed and stopped by the process holding it. A bare session
  name addresses a terminal by name only.
  """

  alias Shuttle.AppWorkers

  @doc """
  The backend handle of running metadata `meta`: the app reference, or the
  terminal execution its conversation UUID (`:holder_uuid`) and bound pane
  identify, with its session name kept for display.
  """
  def handle(%{session: session} = meta) do
    if AppWorkers.app?(session),
      do: session,
      else: %{session: session, uuid: Map.get(meta, :holder_uuid), pane: Map.get(meta, :pane)}
  end

  def session_status(runner, %{} = handle), do: Shuttle.Tmux.worker_status(runner, handle)

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
  def observe(session, expected \\ %{})

  def observe(%{}, _expected), do: :terminal

  def observe(session, expected) do
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

  def present?(runner, session), do: session_status(runner, session) != :gone

  def stop(runner, %{} = handle), do: Shuttle.Tmux.stop_worker(runner, handle)

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
