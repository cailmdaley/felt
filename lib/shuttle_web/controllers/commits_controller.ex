defmodule ShuttleWeb.CommitsController do
  @moduledoc """
  This host's commit ledger: `GET /api/v1/commits?since_ms=<int>&until_ms=<int>`.

      {"host": "dapmcw68",
       "records": [{"at": 1786203000000, "kind": "commit", "sha": "79def80…",
                    "subject": "desk: cycle lens", "repo": "/Users/me/dev/felt",
                    "files": 3, "insertions": 42, "deletions": 7,
                    "session": "0883ade1-…", "tmux": "edits-01KTS…-shuttle",
                    "cwd": "/Users/me/dev/felt"}]}

  `Shuttle.CommitLedger` does the reading; this controller parses the bounds and
  stamps the host. Records come back oldest-first.

  Both bounds are optional: absent `since_ms` is the whole ledger, absent
  `until_ms` is open-ended. A bound that is present but not an integer is a 400
  — the alternative is silently serving a different window than the caller
  asked for.

  **Host-scoped, not owner-routed**, like `/sessions` and `/activity`: the
  ledger records the commits made *on this machine*. A cross-host view fans out
  and merges on the `host` stamp the composite adds.
  """

  use Phoenix.Controller, formats: [:json]

  import ShuttleWeb.RelayHelpers,
    only: [integer_param: 3, json_with_validator: 3, file_token: 1]

  alias Shuttle.{CommitLedger, Poller}
  alias ShuttleWeb.TemporalComposite, as: Composite

  def show(conn, params) do
    with {:ok, since_ms} <- integer_param(params, "since_ms", default: 0),
         {:ok, until_ms} <- integer_param(params, "until_ms", default: nil) do
      # The ledger is append-only, so `{mtime, size}` plus the bounds decides
      # the response byte-for-byte; a hub polling this over a tunnel 304s until
      # a commit is actually made.
      validator = {since_ms, until_ms, file_token(CommitLedger.default_path())}

      json_with_validator(conn, validator, fn ->
        %{
          host: Poller.own_host_id(),
          records: CommitLedger.read_between(since_ms, until_ms)
        }
      end)
    else
      {:error, {:bad_param, key}} -> bad_param(conn, key)
    end
  end

  @doc """
  `GET /api/v1/commits/composite?since_ms=…&until_ms=…` — every host's commits,
  merged.

  Local records are stamped with this host's id; remote records come from
  `Shuttle.RemoteTemporalRegistry`'s cache already stamped with the origin they
  were fetched from, and the requested window is applied here. A remote that is
  unreachable keeps contributing its last-good commits, marked stale in
  `origins`.
  """
  def composite(conn, params) do
    with {:ok, since_ms} <- integer_param(params, "since_ms", default: 0),
         {:ok, until_ms} <- integer_param(params, "until_ms", default: nil) do
      entries = Composite.remote_entries()
      own = Composite.own_host()

      records =
        (CommitLedger.read_between(since_ms, until_ms)
         |> Enum.map(&Composite.stamp(&1, own))) ++
          Enum.flat_map(entries, fn {name, entry} ->
            entry.commits
            |> Composite.in_window(:at, since_ms, until_ms || max_ms())
            |> Enum.map(&Composite.stamp(&1, name))
          end)

      json(conn, %{
        host: own,
        records: Enum.sort_by(records, &(Composite.item_ms(&1, :at) || 0)),
        origins: Composite.origins(entries)
      })
    else
      {:error, {:bad_param, key}} -> bad_param(conn, key)
    end
  end

  # `in_window/4` is inclusive on both sides and an absent `until_ms` is
  # open-ended, so the upper bound becomes "any time a record could carry".
  defp max_ms, do: 253_402_300_799_000

  defp bad_param(conn, key) do
    conn |> put_status(400) |> json(%{error: "#{key} must be an integer (epoch ms)"})
  end
end
