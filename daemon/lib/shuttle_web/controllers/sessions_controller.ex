defmodule ShuttleWeb.SessionsController do
  @moduledoc """
  This host's session ledger: `GET /api/v1/sessions?since_ms=<int>`.

      {"host": "hub-mac",
       "records": [{"fiber": "work/paper/edits", "uid": "01KTS…",
                    "session": "0883ade1-…", "harness": "claude-code",
                    "host": "hub-mac", "tmux": "edits-01KTS…-shuttle",
                    "at": 1786203000000, "kind": "dispatch"}]}

  `Shuttle.SessionLedger` does the reading; this controller parses the bound
  and stamps the host. Records come back oldest-first.

  `since_ms` is optional and defaults to the whole ledger. `uid` is optional
  too and narrows the records to one fiber's pairings (both here and on the
  composite). Unlike `/activity`
  there is no width cap, because the file holds one line per *session* rather
  than one per hook event — the whole history is smaller than a single busy
  hour of activity. A `since_ms` that is present but not an integer is a 400;
  the alternative is silently serving a different window than the caller asked
  for.

  **Host-scoped, not owner-routed**, like `/activity` and `/commits`: the
  ledger records the sessions THIS daemon paired. A cross-host view fans out
  and merges on the `host` stamp each record already carries.
  """

  use Phoenix.Controller, formats: [:json]

  import ShuttleWeb.RelayHelpers,
    only: [integer_param: 3, json_with_validator: 3, rotating_file_tokens: 1, bad_param: 2]

  alias Shuttle.{Poller, SessionLedger}
  alias ShuttleWeb.TemporalComposite, as: Composite

  # Absent means "the whole ledger", so the bound defaults to 0 rather than
  # 400ing the way the required `/activity` bounds do. That is also why the 400
  # renders through `bad_param/2` and not `epoch_ms_message/1`: the latter says
  # "is required", and `since_ms` is not.
  def show(conn, params) do
    case integer_param(params, "since_ms", default: 0) do
      {:ok, since_ms} ->
        # The ledger is append-only and rotates by rename, so both files'
        # `{mtime, size}` plus the params decide the response byte-for-byte; a
        # hub asking over a tunnel 304s until a session is actually paired.
        uid = uid_param(params)
        validator = {since_ms, uid, ledger_tokens()}

        json_with_validator(conn, validator, fn ->
          %{
            host: Poller.own_host_id(),
            records: since_ms |> SessionLedger.read_since() |> for_uid(uid)
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
  holds each remote's whole ledger; the `since_ms` bound is applied here.
  """
  def composite(conn, params) do
    case integer_param(params, "since_ms", default: 0) do
      {:ok, since_ms} ->
        entries = Composite.remote_entries(:sessions)
        uid = uid_param(params)
        validator = Composite.validator({since_ms, uid, ledger_tokens()}, entries)

        json_with_validator(conn, validator, fn ->
          records =
            (SessionLedger.read_since(since_ms) ++
               Enum.flat_map(entries, fn {_name, entry} ->
                 Composite.in_window(entry.items, :at, since_ms, nil)
               end))
            |> for_uid(uid)
            |> Enum.sort_by(&(Composite.item_ms(&1, :at) || 0))

          %{host: Composite.own_host(), records: records, origins: Composite.origins(entries)}
        end)

      {:error, {:bad_param, key}} ->
        bad_param(conn, key)
    end
  end

  defp ledger_tokens, do: rotating_file_tokens(SessionLedger.default_path())

  # `uid=` narrows either read to one fiber's pairings — what a card asks for.
  defp uid_param(params) do
    case Map.get(params, "uid") do
      uid when is_binary(uid) and uid != "" -> uid
      _ -> nil
    end
  end

  defp for_uid(records, nil), do: records
  defp for_uid(records, uid), do: Enum.filter(records, &(record_uid(&1) == uid))

  defp record_uid(%{"uid" => uid}), do: uid
  defp record_uid(%{uid: uid}), do: uid
  defp record_uid(_), do: nil
end
