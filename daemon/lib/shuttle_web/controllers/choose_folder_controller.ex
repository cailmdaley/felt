defmodule ShuttleWeb.ChooseFolderController do
  @moduledoc """
  Raise the owning host's native folder dialog: `POST /api/v1/choose-folder`.

  The native half of the pickers' "+ Add project…". This asks the OS for the
  one it already has (`Shuttle.FolderPicker` — Finder via `osascript`, zenity,
  kdialog). The board calls it for the LOCAL host when that daemon reports a
  native picker, and hands the returned path straight to
  `POST /api/v1/projects`; otherwise it asks the human to type the absolute
  path on the selected host.

  Lives apart from `ProjectsController` on purpose: registering a path is a
  write to the picker list, whereas this writes nothing at all — it borrows the
  host's screen for as long as a human takes to answer, and its interesting
  outcomes (cancelled, no mechanism) are not the registration contract's.

  **Owner-routed via `Shuttle.OriginRouter.route_host/2`** — only the owning
  daemon can drive its own host's display, and an origin this daemon cannot
  place is refused rather than quietly raising a dialog HERE under another
  machine's name.

  A remote origin therefore raises the dialog on *that machine's* desktop. That
  is a real thing to want (a second workstation) and a bad thing to do blindly
  (a login node with nobody at it), so the decision is the caller's and it is
  made from data rather than from a rule: each host reports
  `native_folder_picker` for itself in the origins feed, and
  `FolderPicker.available?/0` answers false where there is no display to put a
  dialog on. The board offers Browse exactly where that flag is true, and says
  whose screen it will appear on when that is not the reader's.

  The request blocks until the human answers (bounded at five minutes inside
  `FolderPicker`), so a caller wants a long client timeout — including the
  FORWARD, which is why this one overrides `OriginRouter`'s 30s default.

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
    case OriginRouter.route_host(Map.get(params, "origin")) do
      {:error, {:unknown_origin, origin}} ->
        conn
        |> put_status(400)
        |> json(%{ok: false, error: OriginRouter.unknown_origin_message(origin)})

      {:remote, remote} ->
        relay_json(
          conn,
          # Longer than `FolderPicker`'s own five-minute bound, so the far side
          # is what decides a forgotten dialog has waited long enough. At the
          # 30s default every remote Browse timed out before a human could
          # plausibly have answered it.
          OriginRouter.forward(remote, "/api/v1/choose-folder", params,
            forward_timeout_ms: 330_000
          ),
          fn name, reason ->
            %{ok: false, error: "forward to #{name} failed: #{inspect(reason)}"}
          end
        )

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
