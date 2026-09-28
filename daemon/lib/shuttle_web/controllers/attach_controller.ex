defmodule ShuttleWeb.AttachController do
  @moduledoc """
  Open a tmux session in kitty: `POST /api/v1/attach`.

  Two bodies:

    * `{ "tmux_session": "...", "shuttle_host": "..." }` — a live worker's
      session, from the ▸ aloft / ☞ needs-you-now pill or a History row marked
      live.
    * `{ "session": "<uuid>", "shuttle_host": "..." }` — a past harness session,
      from a History row. The host that ran it first starts (or finds) the
      tmux session resuming it (`Shuttle.SessionResume`; forwarded to
      `POST /api/v1/sessions/resume` when that host is remote), then the tab
      attaches to it as it would to a worker.

  Unlike the kanban write-plane this is **not** owner-routed: the terminal must
  open on the machine serving the UI (where the human is), so the receiving
  daemon always opens the tab locally — for a remote host it opens a local
  kitty tab that `ssh`es there (see `Shuttle.Kitty`).

  `shuttle_host` is optional; absent/own-host → local. Returns 200
  `{ "attached": true, "session": <tmux session> }` on success, 400 for a
  missing or malformed session or a non-string host, 409 when the session is
  that host's running worker (attach to its tmux instead), 422 when the host
  cannot resume it or is unknown, 502 when kitty or the remote can't be reached
  (or the remote's daemon predates the resume route).
  """

  use Phoenix.Controller, formats: [:json]

  import Plug.Conn

  alias Shuttle.{OriginRouter, Remote, SessionResume, Transcript}
  alias ShuttleWeb.SessionResumeController

  def create(conn, %{"shuttle_host" => host}) when not (is_binary(host) or is_nil(host)) do
    conn |> put_status(400) |> json(%{error: "shuttle_host must be a string"})
  end

  def create(conn, %{"tmux_session" => session} = params) when is_binary(session) do
    attach(conn, session, Map.get(params, "shuttle_host"))
  end

  def create(conn, %{"session" => session} = params) when is_binary(session) do
    host = Map.get(params, "shuttle_host")

    if Transcript.valid_session?(session) do
      case prepare(session, host) do
        {:ok, tmux} -> attach(conn, tmux, host)
        {:error, status, reason} -> conn |> put_status(status) |> json(%{error: reason})
      end
    else
      conn |> put_status(400) |> json(%{error: "session must be a UUID"})
    end
  end

  def create(conn, _params) do
    conn |> put_status(400) |> json(%{error: "tmux_session or session is required"})
  end

  defp attach(conn, tmux, host) do
    case kitty().open(tmux, host) do
      :ok ->
        json(conn, %{attached: true, session: tmux})

      {:error, reason} ->
        conn |> put_status(502) |> json(%{error: reason})
    end
  end

  # The resume is started where the transcript is: here, or on the remote.
  defp prepare(session, host) do
    case OriginRouter.route_host(host) do
      :local ->
        case SessionResume.prepare(session, SessionResumeController.prepare_opts()) do
          {:ok, %{tmux_session: tmux}} -> {:ok, tmux}
          {:error, {:live, reason}} -> {:error, 409, reason}
          {:error, reason} -> {:error, 422, reason}
        end

      {:remote, %Remote{} = remote} ->
        case OriginRouter.forward(remote, "/api/v1/sessions/resume", %{"session" => session}) do
          {:forwarded, 200, body} ->
            case Jason.decode(body) do
              {:ok, %{"tmux_session" => tmux}} when is_binary(tmux) ->
                if tmux == SessionResume.tmux_name(session),
                  do: {:ok, tmux},
                  else: {:error, 502, "#{remote.name} answered an unexpected tmux session"}

              _ ->
                {:error, 502, "#{remote.name} answered the resume with no tmux session"}
            end

          {:forwarded, 404, _body} ->
            {:error, 502,
             "#{remote.name}'s daemon has no /api/v1/sessions/resume route — deploy the " <>
               "current build there to resume its sessions"}

          {:forwarded, status, body} ->
            {:error, if(status in 400..499, do: status, else: 502), remote_error(body, remote)}

          {:error, _reason} ->
            {:error, 502, "#{remote.name} could not be reached to resume the session"}
        end

      {:error, {:unknown_origin, origin}} ->
        {:error, 422, OriginRouter.unknown_origin_message(origin)}
    end
  end

  defp remote_error(body, remote) do
    case Jason.decode(body) do
      {:ok, %{"error" => message}} when is_binary(message) -> "#{remote.name}: #{message}"
      _ -> "#{remote.name} refused the resume"
    end
  end

  defp kitty, do: Application.get_env(:shuttle, :kitty_impl, Shuttle.Kitty)
end
