defmodule ShuttleWeb.SentFilesController do
  @moduledoc """
  The sent-files trail for a fiber: `GET /api/v1/sent-files?uid=…&origin=…`.

  Returns `{"files": [{"fullPath", "basename", "timestamp", "sessionId"}]}` —
  newest-first, deduped by `fullPath`, capped — the artifacts a worker pushed
  with `SendUserFile` on the card whose fiber id is `uid`. Source is the owning
  host's `events.jsonl` hook stream (`Shuttle.SentFiles`), the always-fresh
  ground truth that replaces Portolan's retired `:4004` `/sent-files` (see
  finding 01KVC1N5XMAAMYXDAGR4V6QA9G).

  **Owner-routed via `Shuttle.OriginRouter`, exactly like `/file`.** The composite
  board stamps each fiber with its `origin`; the panel carries that origin back. A
  local-owned fiber's trail is read here from this host's events.jsonl; a
  remote-owned fiber forwards to the owning daemon's identical `/sent-files`
  (origin stripped) over the SSH tunnel — only that daemon tails its own host's
  events.jsonl — and relays its JSON verbatim (`OriginRouter.forward_get/4`).

  A missing `uid` is a 400; a missing/empty events file yields `{"files": []}`,
  not a 500.
  """

  use Phoenix.Controller, formats: [:json]
  import ShuttleWeb.RelayHelpers,
    only: [relay_bytes: 2, integer_param: 3, json_with_validator: 3, file_token: 1]

  alias Shuttle.{OriginRouter, Poller, SentFiles, WaitingTracker}
  alias ShuttleWeb.TemporalComposite, as: Composite

  def show(conn, %{"uid" => uid} = params) when is_binary(uid) and uid != "" do
    case OriginRouter.route(Map.get(params, "origin")) do
      {:remote, remote} ->
        relay_bytes(conn, OriginRouter.forward_get(remote, "/api/v1/sent-files", %{"uid" => uid}))

      :local ->
        json(conn, %{files: SentFiles.for_uid(uid)})
    end
  end

  def show(conn, _params) do
    conn |> put_status(400) |> json(%{error: "uid is required"})
  end

  @doc """
  This host's global sent-files feed: `GET /api/v1/sent-files/all?since_ms=<int>`.

      {"host": "hub-mac",
       "files": [{"fullPath": "…", "basename": "…", "timestamp": 1786203000000,
                  "sessionId": "…", "uid": "01KTS261GJMMRDRHS2QDMEFV3K"}]}

  `Shuttle.SentFiles.all_since/2` does the reading; this controller parses the
  bound and stamps the host. Unlike the uid-scoped `show/2` above, this is
  **host-scoped, not owner-routed** — like `/commits` and `/sessions` — every
  fiber's sends recorded on THIS host's events.jsonl, no uid filter. A caller
  building a cross-fiber panel groups by the `uid` each entry carries.
  """
  def show_all(conn, params) do
    with {:ok, since_ms} <- integer_param(params, "since_ms", default: 0) do
      validator = {since_ms, file_token(WaitingTracker.default_events_file())}

      json_with_validator(conn, validator, fn ->
        %{host: Poller.own_host_id(), files: SentFiles.all_since(since_ms)}
      end)
    else
      {:error, {:bad_param, key}} -> bad_param(conn, key)
    end
  end

  @doc """
  `GET /api/v1/sent-files/all/composite?since_ms=…` — every host's sent-files,
  merged.

  Local entries are stamped with this host's id; remote entries come from
  `Shuttle.RemoteTemporalRegistry`'s cache already stamped with the origin they
  were fetched from, and the requested window is applied here — same shape as
  `CommitsController.composite/2`.
  """
  def composite_all(conn, params) do
    with {:ok, since_ms} <- integer_param(params, "since_ms", default: 0) do
      entries = Composite.remote_entries()
      own = Composite.own_host()

      files =
        (SentFiles.all_since(since_ms)
         |> Enum.map(&Composite.stamp(&1, own))) ++
          Enum.flat_map(entries, fn {name, entry} ->
            entry.sent_files
            |> Composite.in_window(:timestamp, since_ms, max_ms())
            |> Enum.map(&Composite.stamp(&1, name))
          end)

      json(conn, %{
        host: own,
        files: Enum.sort_by(files, &(Composite.item_ms(&1, :timestamp) || 0)),
        origins: Composite.origins(entries)
      })
    else
      {:error, {:bad_param, key}} -> bad_param(conn, key)
    end
  end

  # `in_window/4` is inclusive on both sides and this endpoint has no upper
  # bound param, so it becomes "any time an entry could carry".
  defp max_ms, do: 253_402_300_799_000

  defp bad_param(conn, key) do
    conn |> put_status(400) |> json(%{error: "#{key} must be an integer (epoch ms)"})
  end
end
