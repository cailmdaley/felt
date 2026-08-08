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

  import ShuttleWeb.RelayHelpers, only: [integer_param: 3]

  alias Shuttle.{Poller, SessionLedger}

  # Absent means "the whole ledger", so the bound defaults to 0 rather than
  # 400ing the way the required `/activity` bounds do. That is also why the 400
  # copy is this endpoint's own: `epoch_ms_message/1` says "is required", and
  # `since_ms` is not.
  def show(conn, params) do
    case integer_param(params, "since_ms", default: 0) do
      {:ok, since_ms} ->
        json(conn, %{
          host: Poller.own_host_id(),
          records: SessionLedger.read_since(since_ms)
        })

      {:error, {:bad_param, key}} ->
        conn
        |> put_status(400)
        |> json(%{error: "#{key} must be an integer (epoch ms)"})
    end
  end
end
