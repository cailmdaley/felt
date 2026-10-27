defmodule ShuttleWeb.SentFilesController do
  @moduledoc """
  The sent-files trail for a fiber: `GET /api/v1/sent-files?uid=…&origin=…`.
  An optional `session` query parameter returns every send from that native
  conversation, including repeated paths.

  Returns `{"files": [{"fullPath", "basename", "timestamp", "sessionId"}]}` —
  newest-first and capped — the artifacts a worker pushed with `SendUserFile`
  on the card whose fiber id is `uid`. Without `session`, entries are deduped
  by `fullPath`; a session-scoped response preserves repeated sends. Source is the owning
  host's `events.jsonl` hook stream (`Shuttle.SentFiles`), the always-fresh
  ground truth (see finding 01KVC1N5XMAAMYXDAGR4V6QA9G).

  **Owner-routed via `Shuttle.OriginRouter`, exactly like `/file`.** The composite
  board stamps each fiber with its `origin`; the document workspace carries that
  origin back. A local-owned fiber's trail is read here from this host's
  `events.jsonl`; a remote-owned fiber forwards to the owning daemon's identical
  `/sent-files` (origin stripped) over the SSH tunnel — only that daemon tails
  its own host's `events.jsonl` — and relays its JSON verbatim
  (`OriginRouter.forward_file_get/4`).

  A missing `uid` is a 400; a missing/empty events file yields `{"files": []}`,
  not a 500.

  **Neither leg rescans the stream.** `Shuttle.SentFiles` reads an in-memory
  projection kept by `Shuttle.EventStream`, which seeds once at boot and then
  reads only appended bytes. That, not the ETag below, keeps reader polls and
  unconditional remote requests affordable.

  Both legs preserve conditional requests and weak ETags over the request and
  the event stream and session ledger change tokens.
  """

  use Phoenix.Controller, formats: [:json]

  import ShuttleWeb.RelayHelpers,
    only: [
      relay_file_bytes: 2,
      relay_json: 2,
      integer_param: 3,
      json_with_validator: 3,
      rotating_file_tokens: 1,
      bad_param: 2
    ]

  alias Shuttle.{
    CLI,
    EventStream,
    OriginRouter,
    Poller,
    RemoteTemporalRegistry,
    SentFiles,
    SessionLedger,
    ULID
  }

  alias ShuttleWeb.TemporalComposite, as: Composite

  def show_session(conn, %{"session" => session} = params)
      when is_binary(session) and session != "",
      do: show(conn, params)

  def show_session(conn, _params), do: bad_param(conn, "session")

  def show(conn, %{"uid" => uid} = params) when is_binary(uid) and uid != "" do
    session_id = params["session"]

    if Map.has_key?(params, "session") and (not is_binary(session_id) or session_id == "") do
      bad_param(conn, "session")
    else
      case OriginRouter.route(Map.get(params, "origin")) do
        {:error, {:unknown_origin, origin}} ->
          ShuttleWeb.RelayHelpers.unknown_origin(conn, origin)

        {:remote, remote} ->
          query =
            if is_binary(session_id),
              do: %{"uid" => uid, "session" => session_id},
              else: %{"uid" => uid}

          headers = Enum.map(get_req_header(conn, "if-none-match"), &{"if-none-match", &1})

          relay_file_bytes(
            conn,
            OriginRouter.forward_file_get(remote, "/api/v1/sent-files", query, headers)
          )

        :local ->
          validator = {uid, session_id, sent_files_tokens()}

          json_with_validator(conn, validator, fn ->
            %{files: SentFiles.for_uid(uid, session_id: session_id)}
          end)
      end
    end
  end

  def show(conn, _params) do
    conn |> put_status(400) |> json(%{error: "uid is required"})
  end

  @doc """
  `POST /api/v1/sent-files/clear` with `{uid, origin, path?}` records a cutoff on
  the selected stream host. Bytes on disk and body embeds are untouched.
  Unknown origins are refused: a synchronized fiber may exist here while its
  send history belongs to another host.
  """
  def clear(conn, %{"uid" => uid} = params) do
    cond do
      not ULID.valid?(uid) ->
        conn |> put_status(400) |> json(%{ok: false, error: "uid must be a fiber ULID"})

      Map.has_key?(params, "path") and not valid_clear_path?(params["path"]) ->
        conn
        |> put_status(400)
        |> json(%{ok: false, error: "path must be a nonempty absolute path"})

      true ->
        case OriginRouter.route_host(Map.get(params, "origin")) do
          {:remote, remote} ->
            result =
              OriginRouter.forward(
                remote,
                "/api/v1/sent-files/clear",
                Map.take(params, ["uid", "path"])
              )

            case result do
              {:forwarded, status, _body} when status in 200..299 ->
                RemoteTemporalRegistry.invalidate(remote.name, :sent_files)

              _ ->
                :ok
            end

            relay_json(conn, result)

          :local ->
            path_args = if Map.has_key?(params, "path"), do: ["--path", params["path"]], else: []

            case CLI.run(["sent-files", "clear", uid, "--uid", "--local"] ++ path_args) do
              {:ok, _output} ->
                json(conn, %{ok: true})

              {:command_error, status, output} when status in [:timeout, 127] ->
                conn |> put_status(503) |> json(%{ok: false, error: output})

              {:command_error, _status, output} ->
                conn |> put_status(422) |> json(%{ok: false, error: output})

              {:error, reason} ->
                conn |> put_status(503) |> json(%{ok: false, error: reason})
            end

          {:error, {:unknown_origin, origin}} ->
            conn
            |> put_status(400)
            |> json(%{ok: false, error: OriginRouter.unknown_origin_message(origin)})
        end
    end
  end

  def clear(conn, _params) do
    conn |> put_status(400) |> json(%{ok: false, error: "uid is required"})
  end

  defp valid_clear_path?(path) when is_binary(path) and path != "",
    do: Path.type(path) == :absolute

  defp valid_clear_path?(_path), do: false

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
