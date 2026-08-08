defmodule ShuttleWeb.SessionsController do
  @moduledoc """
  This host's session ledger: `GET /api/v1/sessions?since_ms=<int>`.

      {"host": "dapmcw68",
       "records": [{"fiber": "work/paper/edits", "uid": "01KTS…",
                    "session": "0883ade1-…", "harness": "claude-code",
                    "host": "dapmcw68", "tmux": "edits-01KTS…-shuttle",
                    "at": 1786203000000, "kind": "dispatch"}]}

  `Shuttle.SessionLedger` does the reading; this controller parses the bound
  and stamps the host. Records come back oldest-first.

  `since_ms` is optional and defaults to the whole ledger. Unlike `/activity`
  there is no width cap, because the file holds one line per *session* rather
  than one per hook event — the whole history is smaller than a single busy
  hour of activity. A `since_ms` that is present but not an integer is a 400;
  the alternative is silently serving a different window than the caller asked
  for.

  **Host-scoped, not owner-routed**, like `/activity` and `/narration`: the
  ledger records the sessions THIS daemon paired. A cross-host view fans out
  and merges on the `host` stamp each record already carries.
  """

  use Phoenix.Controller, formats: [:json]

  alias Shuttle.{Poller, SessionLedger}

  def show(conn, params) do
    case since_ms(params) do
      {:ok, since_ms} ->
        json(conn, %{
          host: Poller.own_host_id(),
          records: SessionLedger.read_since(since_ms)
        })

      :error ->
        conn
        |> put_status(400)
        |> json(%{error: "since_ms must be an integer (epoch ms)"})
    end
  end

  defp since_ms(params) do
    case Map.get(params, "since_ms") do
      nil ->
        {:ok, 0}

      value when is_binary(value) ->
        case Integer.parse(value) do
          {int, ""} -> {:ok, int}
          _ -> :error
        end

      _ ->
        :error
    end
  end
end
