defmodule ShuttleWeb.SessionLinksController do
  @moduledoc """
  What the host that ran a batch of sessions knows about them:
  `GET /api/v1/sessions/links?sessions=<uuid>,…&host=<name>` — whether each
  transcript is there, its harness, and a bridged Claude session's claude.ai URL.

      {"host": "hub-mac",
       "links": [{"session": "0883ade1-…", "availability": "available_local",
                  "harness": "claude-code",
                  "url": "https://claude.ai/code/session_01…"},
                 {"session": "01a0b39f-…", "availability": "available_local",
                  "harness": "codex", "url": null}]}

  One entry per requested session, in request order, resolved by
  `Shuttle.SessionLink.resolve/2` on the host that ran them — a transcript
  lives on that machine, so `host` names it (absent, `local` or this host's id
  means here) and a remote host is asked over the same forwarding as other
  host-local reads. A remote that cannot be reached answers every session
  `host_unreachable` with no link; a link is never inferred from the ledger,
  and a remote's answer is re-checked here — only the sessions asked for, and
  only a `https://claude.ai/` URL.

  A sibling of `/api/v1/transcript` rather than a field on its receipt: the
  receipt hashes the whole transcript, which is the wrong price for a list of
  sessions, and this route answers a batch in one hop per host.

  At most 50 sessions per request; the board asks for the ones it shows.
  """

  use Phoenix.Controller, formats: [:json]

  import Plug.Conn
  import ShuttleWeb.RelayHelpers, only: [present?: 1]

  alias Shuttle.{OriginRouter, Poller, Remote, SessionLink, Transcript}

  @max_sessions 50

  def show(conn, params) do
    with {:ok, sessions} <- sessions_param(params) do
      host = Map.get(params, "host")

      case OriginRouter.route_host(if(present?(host), do: host)) do
        :local -> json(conn, local(sessions))
        {:remote, %Remote{} = remote} -> json(conn, remote(sessions, remote))
        {:error, _unknown} -> json(conn, unreachable(sessions, host))
      end
    else
      {:error, message} -> conn |> put_status(400) |> json(%{error: message})
    end
  end

  defp local(sessions) do
    %{
      host: Poller.own_host_id(),
      links:
        Enum.map(sessions, fn session ->
          session |> SessionLink.resolve() |> Map.update!(:availability, &Atom.to_string/1)
        end)
    }
  end

  # The remote answers for its own disk, but what it relays is re-checked
  # here: one entry per REQUESTED session, in request order, and only a link
  # of the shape this daemon would itself have produced for that session.
  defp remote(sessions, %Remote{} = remote) do
    query = %{"sessions" => Enum.join(sessions, ","), "host" => "local"}

    with {:forwarded, 200, _type, body} <-
           OriginRouter.forward_get(remote, "/api/v1/sessions/links", query),
         {:ok, %{"links" => links}} when is_list(links) <- Jason.decode(body) do
      relayed = for %{"session" => id} = entry <- links, into: %{}, do: {id, entry}

      %{
        host: remote.name,
        links:
          Enum.map(sessions, fn session ->
            case Map.get(relayed, session) do
              nil -> unreachable_entry(session)
              entry -> relayed_entry(session, entry)
            end
          end)
      }
    else
      _ -> unreachable(sessions, remote.name)
    end
  end

  defp relayed_entry(session, entry) do
    url = entry["url"]
    availability = entry["availability"]
    harness = entry["harness"]

    %{
      session: session,
      availability:
        if(availability in ["available_local", "transcript_missing"],
          do: availability,
          else: "transcript_missing"
        ),
      harness: if(is_binary(harness), do: harness),
      url: if(SessionLink.claude_url?(url), do: url)
    }
  end

  defp unreachable(sessions, host),
    do: %{host: host, links: Enum.map(sessions, &unreachable_entry/1)}

  defp unreachable_entry(session) do
    %{
      session: session,
      availability: "host_unreachable",
      harness: nil,
      url: nil
    }
  end

  defp sessions_param(params) do
    case Map.get(params, "sessions") do
      raw when is_binary(raw) and raw != "" ->
        sessions = raw |> String.split(",", trim: true) |> Enum.uniq()

        cond do
          not Enum.all?(sessions, &Transcript.valid_session?/1) ->
            {:error, "sessions must be comma-separated UUIDs"}

          length(sessions) > @max_sessions ->
            {:error, "at most #{@max_sessions} sessions per request"}

          true ->
            {:ok, sessions}
        end

      _ ->
        {:error, "sessions is required"}
    end
  end
end
