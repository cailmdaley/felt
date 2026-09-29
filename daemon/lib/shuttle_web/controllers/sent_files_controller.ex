defmodule ShuttleWeb.SentFilesController do
  @moduledoc """
  The sent-files trail for a fiber: `GET /api/v1/sent-files?uid=…&origin=…`.

  Returns `{"files": [{"fullPath", "basename", "timestamp", "sessionId"}]}` —
  newest-first, deduped by `fullPath`, capped — the artifacts a worker pushed
  with `SendUserFile` on the card whose fiber id is `uid`. Source is the owning
  host's `events.jsonl` hook stream (`Shuttle.SentFiles`), the always-fresh
  ground truth (see finding 01KVC1N5XMAAMYXDAGR4V6QA9G).

  **Owner-routed via `Shuttle.OriginRouter`, exactly like `/file`.** The composite
  board stamps each fiber with its `origin`; the panel carries that origin back. A
  local-owned fiber's trail is read here from this host's events.jsonl; a
  remote-owned fiber forwards to the owning daemon's identical `/sent-files`
  (origin stripped) over the SSH tunnel — only that daemon tails its own host's
  events.jsonl — and relays its JSON verbatim (`OriginRouter.forward_get/4`).

  A missing `uid` is a 400; a missing/empty events file yields `{"files": []}`,
  not a 500.

  **Neither leg rescans the stream.** `Shuttle.SentFiles` reads an in-memory
  projection kept by `Shuttle.EventStream`, which seeds once at boot and then
  reads only appended bytes. That, not the ETag below, is what makes the
  detail panel's poll and the unconditional remote leg affordable.

  **The local leg carries a weak `ETag`** over the request and both sources'
  change tokens: the `events.jsonl` pair and the session ledger. The ledger
  matters for native sessions whose event predates the fiber↔session claim.
  Each source's rotated sibling is included because the reader reads it. The
  detail panel's live poll therefore re-reads the trail whenever either source
  changes. The REMOTE leg stays unconditional: `OriginRouter.forward_get/4`
  forwards no request headers and drops response headers, so a client's
  `If-None-Match` never reaches the owning daemon and its `ETag` never comes
  back — which is exactly why the reader itself, not the conditional request,
  has to be the cheap thing. `events.jsonl` is the live hook stream for every
  session on the host, so its token moves every few seconds and a 304 could
  never have defended this endpoint anyway.
  """

  use Phoenix.Controller, formats: [:json]

  import ShuttleWeb.RelayHelpers,
    only: [
      relay_bytes: 2,
      integer_param: 3,
      json_with_validator: 3,
      rotating_file_tokens: 1,
      bad_param: 2
    ]

  alias Shuttle.{EventStream, OriginRouter, Poller, SentFiles, SessionLedger}
  alias ShuttleWeb.TemporalComposite, as: Composite

  def show(conn, %{"uid" => uid} = params) when is_binary(uid) and uid != "" do
    case OriginRouter.route(Map.get(params, "origin")) do
      {:remote, remote} ->
        relay_bytes(conn, OriginRouter.forward_get(remote, "/api/v1/sent-files", %{"uid" => uid}))

      :local ->
        validator = {uid, sent_files_tokens()}

        json_with_validator(conn, validator, fn -> %{files: SentFiles.for_uid(uid)} end)
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
      validator = {since_ms, sent_files_tokens()}

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
  `Shuttle.RemoteTemporalRegistry`, stamped with the origin they were fetched
  from, and the requested window is applied here — same shape as
  `CommitsController.composite/2`.
  """
  def composite_all(conn, params) do
    with {:ok, since_ms} <- integer_param(params, "since_ms", default: 0) do
      entries = Composite.remote_entries(:sent_files)
      validator = Composite.validator({since_ms, sent_files_tokens()}, entries)

      json_with_validator(conn, validator, fn ->
        own = Composite.own_host()

        files =
          Enum.map(SentFiles.all_since(since_ms), &Composite.stamp(&1, own)) ++
            Composite.remote_items(entries, :timestamp, since_ms, nil)

        %{
          host: own,
          files: Enum.sort_by(files, &(Composite.item_ms(&1, :timestamp) || 0)),
          origins: Composite.origins(entries)
        }
      end)
    else
      {:error, {:bad_param, key}} -> bad_param(conn, key)
    end
  end

  # The reader joins event rows to the session ledger, so either source can
  # change the response while the other stays untouched. Both readers include
  # their rotated sibling, so its token is included too and a rotation cannot
  # leave a stale 304 behind.
  defp sent_files_tokens do
    %{
      events: rotating_file_tokens(EventStream.default_events_file()),
      ledger: rotating_file_tokens(SessionLedger.default_path())
    }
  end
end
