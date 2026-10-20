defmodule ShuttleWeb.RemoteControlController do
  @moduledoc "Host-scoped reconciled Remote Control status; reads never trigger a launch."
  use Phoenix.Controller, formats: [:json]

  def show(conn, _params) do
    json(conn, Shuttle.RemoteControl.status())
  end
end
