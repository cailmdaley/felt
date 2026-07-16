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
  import ShuttleWeb.RelayHelpers, only: [relay_bytes: 2]

  alias Shuttle.{OriginRouter, SentFiles}

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
end
