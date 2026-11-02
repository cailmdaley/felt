defmodule Shuttle.WorkerBackend do
  @moduledoc "Operations on workers in the host terminal backend."

  def session_status(runner, session), do: Shuttle.Terminal.status(runner, session)
  def observe(_session), do: :terminal

  def present?(runner, session), do: session_status(runner, session) != :gone

  def stop(runner, session), do: Shuttle.Terminal.stop(runner, session)

  def wire(session) do
    %{surface: "cli", tmux_session: session, terminal: Shuttle.Terminal.observed_id(session)}
  end

  def wire(session, _record), do: wire(session)
  def tmux(session), do: session
end
