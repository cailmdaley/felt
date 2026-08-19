defmodule ShuttleWeb.ChooseFolderController do
  @moduledoc """
  Raise the owning host's native folder dialog: `POST /api/v1/choose-folder`.

  The native-first half of the pickers' "+ Add project…". `GET /api/v1/browse`
  reimplemented a folder chooser inside the browser; this asks the OS for the
  one it already has (`Shuttle.FolderPicker` — Finder via `osascript`, zenity,
  kdialog). The board calls it for a LOCAL origin whose daemon reports a native
  picker, hands the returned path straight to `POST /api/v1/projects`, and falls
  back to the in-browser browser otherwise.

  Lives apart from `ProjectsController` on purpose: registering a path is a
  write to the picker list, whereas this writes nothing at all — it borrows the
  host's screen for as long as a human takes to answer, and its interesting
  outcomes (cancelled, no mechanism) are not the registration contract's.

  **Owner-routed via `Shuttle.OriginRouter`**, like `/browse` and `/projects` —
  only the owning daemon can drive its own host's display. Routing a remote
  origin here therefore raises the dialog on *that machine's* desktop, where
  nobody is standing; the UI never sends one, and keeps the browse fallback for
  remotes for exactly this reason.

  The request blocks until the human answers (bounded at five minutes inside
  `FolderPicker`), so a caller wants a long client timeout.

  Returns:
    200  %{ok: true, path: "<absolute path>"}
    200  %{ok: false, cancelled: true}          — the human dismissed the dialog
    501  %{ok: false, error: "no native folder picker on this host"}
    500  %{ok: false, error: string}            — including a timed-out dialog
  """

  use Phoenix.Controller, formats: [:json]
  import ShuttleWeb.RelayHelpers, only: [relay_json: 3]

  alias Shuttle.{FolderPicker, OriginRouter}

  def create(conn, params) do
    case OriginRouter.route(Map.get(params, "origin")) do
      {:remote, remote} ->
        relay_json(conn, OriginRouter.forward(remote, "/api/v1/choose-folder", params), fn name,
                                                                                           reason ->
          %{ok: false, error: "forward to #{name} failed: #{inspect(reason)}"}
        end)

      :local ->
        choose_local(conn)
    end
  end

  defp choose_local(conn) do
    case FolderPicker.choose() do
      {:ok, path} ->
        json(conn, %{ok: true, path: path})

      :cancelled ->
        json(conn, %{ok: false, cancelled: true})

      {:error, :unavailable} ->
        conn
        |> put_status(501)
        |> json(%{ok: false, error: "no native folder picker on this host"})

      {:error, reason} ->
        conn
        |> put_status(500)
        |> json(%{ok: false, error: "folder dialog failed: #{inspect(reason)}"})
    end
  end
end
