defmodule ShuttleWeb.SessionLinkController do
  @moduledoc """
  Where a session can be opened from a phone:
  `GET /api/v1/session-link?session=…&host=…`.

      {"host": "hub-mac", "url": "https://claude.ai/code/session_01…"}
      {"host": "hub-mac", "url": null}

  `Shuttle.SessionLink` does the reading; this controller decides whose disk
  the transcript is on and stamps the host. **Host-routed exactly like
  `/moment`**: an explicit `host` that is not this daemon forwards to that
  daemon's identical endpoint; with no `host` the session ledger names the
  host; anything else reads locally. A stale or unreachable remote answers
  `url: null` with a 200 — a missing link is the honest answer to "where do I
  open this", not a 500. Only a missing `session` is a 400.
  """

  use Phoenix.Controller, formats: [:json]

  import ShuttleWeb.RelayHelpers, only: [present?: 1]

  alias Shuttle.{OriginRouter, Poller, Remote, SessionLedger, SessionLink}

  def show(conn, params) do
    session = Map.get(params, "session")

    if present?(session) do
      serve(conn, session, target_host(params, session))
    else
      conn |> put_status(400) |> json(%{error: "session is required"})
    end
  end

  defp serve(conn, session, nil) do
    json(conn, %{host: Poller.own_host_id(), url: SessionLink.remote_url(session)})
  end

  defp serve(conn, session, %Remote{} = remote) do
    # `host=local` so the owner serves this as its own read and the hop
    # terminates by construction (see MomentController).
    query = %{"session" => session, "host" => "local"}

    case OriginRouter.forward_get(remote, "/api/v1/session-link", query) do
      {:forwarded, 200, content_type, body} ->
        conn |> put_resp_content_type(content_type, nil) |> send_resp(200, body)

      _ ->
        json(conn, %{host: remote.name, url: nil, note: "transcript lives on #{remote.name}"})
    end
  end

  defp target_host(params, session) do
    name = Map.get(params, "host")
    name = if present?(name), do: name, else: SessionLedger.host_for_session(session)

    case OriginRouter.route(name) do
      {:remote, remote} -> remote
      :local -> nil
    end
  end
end
