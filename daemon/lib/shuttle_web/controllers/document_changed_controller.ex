defmodule ShuttleWeb.DocumentChangedController do
  use Phoenix.Controller, formats: [:json]

  def create(conn, %{"fiber_id" => id}) when is_binary(id) do
    GenServer.cast(Shuttle.Env.server(Shuttle.Poller), {:document_changed, id})
    json(conn, %{ok: true})
  end
end
