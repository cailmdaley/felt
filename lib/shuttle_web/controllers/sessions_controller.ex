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

  import ShuttleWeb.RelayHelpers,
    only: [integer_param: 3, json_with_validator: 3, file_token: 1]

  alias Shuttle.{Poller, SessionLedger}
  alias ShuttleWeb.TemporalComposite, as: Composite

  # Absent means "the whole ledger", so the bound defaults to 0 rather than
  # 400ing the way the required `/activity` bounds do. That is also why the 400
  # copy is this endpoint's own: `epoch_ms_message/1` says "is required", and
  # `since_ms` is not.
  def show(conn, params) do
    case integer_param(params, "since_ms", default: 0) do
      {:ok, since_ms} ->
        # The ledger is append-only, so `{mtime, size}` plus the bound decides
        # the response byte-for-byte; a hub polling this over a tunnel 304s
        # until a session is actually paired.
        validator = {since_ms, file_token(SessionLedger.default_path())}

        json_with_validator(conn, validator, fn ->
          %{
            host: Poller.own_host_id(),
            records: SessionLedger.read_since(since_ms)
          }
        end)

      {:error, {:bad_param, key}} ->
        bad_param(conn, key)
    end
  end

  @doc """
  `GET /api/v1/sessions/composite?since_ms=…` — every host's pairings, merged.

  Records already carry their own `host`, so this is a concatenation sorted by
  `at` (oldest first, like the single-host endpoint) rather than a stamping
  exercise. Remote records come from `Shuttle.RemoteTemporalRegistry`, which
  caches each remote's whole ledger; the `since_ms` bound is applied here.
  """
  def composite(conn, params) do
    case integer_param(params, "since_ms", default: 0) do
      {:ok, since_ms} ->
        entries = Composite.remote_entries()

        records =
          (SessionLedger.read_since(since_ms) ++
             Enum.flat_map(entries, fn {_name, entry} ->
               Composite.in_window(entry.sessions, :at, since_ms, max_ms())
             end))
          |> Enum.sort_by(&(Composite.item_ms(&1, :at) || 0))

        json(conn, %{
          host: Composite.own_host(),
          records: records,
          origins: Composite.origins(entries)
        })

      {:error, {:bad_param, key}} ->
        bad_param(conn, key)
    end
  end

  # `in_window/4` is inclusive on both sides and this endpoint is open-ended, so
  # the upper bound is "any time a record could carry".
  defp max_ms, do: 253_402_300_799_000

  defp bad_param(conn, key) do
    conn |> put_status(400) |> json(%{error: "#{key} must be an integer (epoch ms)"})
  end
end
