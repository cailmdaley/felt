defmodule ShuttleWeb.AttachController do
  @moduledoc """
  Open a conversation in this host's terminal display: `POST /api/v1/attach`.

  Two bodies:

    * `{ "tmux_session": "...", "shuttle_host": "..." }` — a live worker's
      session, from the ▸ aloft / ☞ needs-you-now pill or a History row marked
      live.
    * `{ "session": "<uuid>", "shuttle_host": "..." }` — a past harness session,
      from a History row. The host that ran it first starts (or finds) the
      terminal resuming it (`Shuttle.SessionResume`; forwarded to
      `POST /api/v1/sessions/resume` when that host is remote), then the tab
      attaches to it as it would to a worker.

  Unlike the kanban write-plane this is **not** owner-routed: the terminal must
  open on the machine serving the UI (where the human is), so the receiving
  daemon opens the viewer locally. `Shuttle.Opener` selects Rex or kitty for
  this host's display, uses SSH for remote tmux terminals, and asks a remote Rex
  owner to select its worker in the attached app client.

  With `"select_only": true` the request is a click's: the display moves to the
  conversation's window, a hidden worker's put back, and nothing else happens
  (`Shuttle.Opener.select/2`). No terminal is created, no app launched or
  brought forward, and a past session is never resumed. It answers 200
  `{ "moved": <bool>, "session": ... }`, where `moved` says whether the display
  now shows the conversation.

  `shuttle_host` is optional; absent/own-host → local. Returns 200
  `{ "attached": true, "session": <tmux session> }` on success, 400 for a
  missing or malformed session or a non-string host, 409 when the session is
  that host's running worker (attach to its terminal instead), 422 when the host
  cannot resume it or is unknown, 502 when the display or remote can't be reached
  (or the remote's daemon predates the resume route).
  """

  use Phoenix.Controller, formats: [:json]

  import Plug.Conn

  alias Shuttle.{OpenTrace, OriginRouter, Remote, SessionResume, Transcript}
  alias ShuttleWeb.SessionResumeController

  def reveal(conn, %{"name" => name} = params) when is_binary(name) and name != "" do
    case Shuttle.Opener.reveal_owned_rex(name, select_only: params["select_only"] == true) do
      :ok ->
        json(conn, %{revealed: true})

      {:ok, moved} ->
        json(conn, %{revealed: moved})

      {:error, :no_app_client} ->
        conn
        |> put_status(422)
        |> json(%{code: "no_app_client", error: "No Rex app client is attached"})

      {:error, reason} ->
        conn |> put_status(422) |> json(%{error: reason})
    end
  end

  def reveal(conn, _), do: conn |> put_status(400) |> json(%{error: "name is required"})

  def create(conn, params) do
    OpenTrace.run(params["tmux_session"] || params["session"], params["shuttle_host"], fn ->
      create_traced(conn, params)
    end)
  end

  defp create_traced(conn, %{"shuttle_host" => host})
       when not (is_binary(host) or is_nil(host)) do
    conn |> put_status(400) |> json(%{error: "shuttle_host must be a string"})
  end

  defp create_traced(conn, %{"tmux_session" => session, "select_only" => true} = params)
       when is_binary(session) do
    case OpenTrace.step(:display, fn -> opener().select(session, params["shuttle_host"]) end) do
      {:ok, moved} -> json(conn, %{moved: moved, session: session})
      {:error, reason} -> conn |> put_status(502) |> json(%{error: format_error(reason)})
    end
  end

  defp create_traced(conn, %{"session" => session, "select_only" => true})
       when is_binary(session),
       do: json(conn, %{moved: false, session: session})

  defp create_traced(conn, %{"tmux_session" => session} = params) when is_binary(session) do
    attach(conn, session, Map.get(params, "shuttle_host"))
  end

  defp create_traced(conn, %{"session" => session} = params) when is_binary(session) do
    host = Map.get(params, "shuttle_host")

    if Transcript.valid_session?(session) do
      case OpenTrace.step(:resume, fn -> prepare(session, host) end) do
        {:ok, tmux} ->
          attach(conn, tmux, host)

        {:error, status, reason} ->
          conn |> put_status(status) |> json(%{error: format_error(reason)})
      end
    else
      conn |> put_status(400) |> json(%{error: "session must be a UUID"})
    end
  end

  defp create_traced(conn, _params) do
    conn |> put_status(400) |> json(%{error: "tmux_session or session is required"})
  end

  defp attach(conn, tmux, host) do
    case OpenTrace.step(:display, fn -> opener().open(tmux, host) end) do
      :ok ->
        json(conn, %{attached: true, session: tmux})

      {:error, reason} ->
        conn |> put_status(502) |> json(%{error: format_error(reason)})
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
                if tmux in [
                     SessionResume.tmux_name(session)
                   ],
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

  defp remote_error(body, remote, action \\ "resume the session") do
    case Jason.decode(body) do
      {:ok, %{"error" => message}} when is_binary(message) -> "#{remote.name}: #{message}"
      _ -> "#{remote.name} could not #{action}."
    end
  end

  defp format_error(reason) when is_binary(reason), do: reason

  defp format_error({:display_failed, reason}),
    do: "could not prepare the terminal: #{inspect(reason)}"

  defp format_error(reason), do: inspect(reason)

  defp opener, do: Shuttle.Env.app(:opener_impl, Shuttle.Opener)
end
