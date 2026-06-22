defmodule ShuttleWeb.AttachController do
  @moduledoc """
  Open a worker's tmux session in kitty: `POST /api/v1/attach`.

  The standalone board fires this when the ▸ aloft / ☞ needs-you-now pill is
  clicked. Unlike the kanban write-plane this is **not** owner-routed: the
  terminal must open on the machine serving the UI (where the human is), so the
  receiving daemon always handles it locally — for a remote-owned worker it
  opens a local kitty tab that `ssh`es to the owning host (see `Shuttle.Kitty`).

  Body: `{ "tmux_session": "...", "shuttle_host": "..." }` (`shuttle_host`
  optional; absent/own-host → local attach). Returns 200 `{ "attached": true }`
  on success, 400 for a missing session, 502 when kitty can't be reached.
  """

  use Phoenix.Controller, formats: [:json]

  def create(conn, %{"tmux_session" => session} = params) when is_binary(session) do
    case Shuttle.Kitty.open(session, Map.get(params, "shuttle_host")) do
      :ok ->
        json(conn, %{attached: true, session: session})

      {:error, reason} ->
        conn |> put_status(502) |> json(%{error: reason})
    end
  end

  def create(conn, _params) do
    conn |> put_status(400) |> json(%{error: "tmux_session is required"})
  end
end
