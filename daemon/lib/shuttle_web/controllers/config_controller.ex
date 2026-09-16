defmodule ShuttleWeb.ConfigController do
  @moduledoc """
  The operator files over HTTP, so the board's settings page can read and
  rewrite them on any host in the fleet.

      GET  /api/v1/config              every file: path, exists, size, mtime
      GET  /api/v1/config/:id          one file's bytes
      POST /api/v1/config/:id          replace one file's bytes, validated

  `:id` is `stores`, `projects`, `agents` or `remotes` — see
  `Shuttle.ConfigFiles`, which owns the paths, the validation, and the reason
  this is a text plane rather than a structured one.

  **Owner-routed via `Shuttle.OriginRouter`**, reads included. That is the
  unusual part and the point of the endpoint: a config file describes the host
  whose daemon reads it, and only that daemon can see it. Opening the settings
  page on a hub and choosing `some-remote` has to reach that remote's own
  `~/.config/felt/`, exactly as `/projects` reaches its filesystem to create a
  store. A read carries its origin as a query parameter (`?origin=…`); a write
  carries it in the body, which is where every other write endpoint puts it.

  Returns:
    200  GET  /config      %{host, files: [%{id, path, exists, size, updated_at}]}
    200  GET  /config/:id  %{host, id, path, exists, size, updated_at, text}
    200  POST /config/:id  %{ok: true, host, id, path, exists, size, updated_at, text}
    400  %{ok: false, error: string}   unknown id or host, missing text, a refused edit
    409  %{ok: false, error: string, conflict: true}
                                      the file moved since the caller read it
                                      (`expected_digest` disagrees) — the one
                                      refusal with a recovery move attached
    500  %{ok: false, error: string}   the write itself failed
    502  %{ok: false, error: string}   the forward to the owning daemon failed
    503  %{ok: false, error: string, unavailable: true}
                                      the validator could not be RUN — felt off
                                      this daemon's PATH, or wedged past its
                                      bound. Distinct from 400 on purpose: the
                                      caller's bytes may be perfectly good.

  A write may carry `expected_digest` — the `digest` the caller was served when
  it read the file, or `null` if there was none. When it is present and the
  file's current hash disagrees, the write is refused: the board is reachable
  from two hubs and a phone at once, so an editor left open while a CLI writes
  the same file would otherwise save its stale text back over the new one.
  Omitting the key keeps the old last-write-wins behaviour, which is what a
  script wants.

  A refused edit is a 400 carrying felt's own diagnostic verbatim — "remote
  \"hub-a\": port 4001 already used by \"hub-b\"" reaches the human's screen as
  the sentence the CLI would have printed, because no paraphrase of it is more
  useful than the original.
  """

  use Phoenix.Controller, formats: [:json]

  import ShuttleWeb.RelayHelpers, only: [relay_bytes: 2, relay_json: 3]

  alias Shuttle.{ConfigFiles, OriginRouter, Poller}

  def index(conn, params) do
    case OriginRouter.route_host(Map.get(params, "origin")) do
      {:remote, remote} ->
        relay_get(conn, remote, "/api/v1/config", params)

      :local ->
        json(conn, %{host: Poller.own_host_id(), files: ConfigFiles.index()})

      {:error, {:unknown_origin, origin}} ->
        bad_request(conn, OriginRouter.unknown_origin_message(origin))
    end
  end

  def show(conn, %{"id" => raw} = params) do
    with {:ok, id} <- parse_id(raw) do
      case OriginRouter.route_host(Map.get(params, "origin")) do
        {:remote, remote} ->
          relay_get(conn, remote, "/api/v1/config/#{id}", params)

        :local ->
          case ConfigFiles.read(id) do
            {:ok, file} -> json(conn, Map.merge(file, %{host: Poller.own_host_id()}))
            {:error, message} -> failed(conn, message)
          end

        {:error, {:unknown_origin, origin}} ->
          bad_request(conn, OriginRouter.unknown_origin_message(origin))
      end
    else
      {:error, :unknown_id} -> bad_request(conn, unknown_id_message(raw))
    end
  end

  def create(conn, %{"id" => raw, "text" => text} = params) when is_binary(text) do
    # The id is parsed BEFORE the route decision, so an unknown one is refused
    # here rather than after a round trip to another machine that will refuse
    # it identically.
    with {:ok, id} <- parse_id(raw) do
      case OriginRouter.route_host(Map.get(params, "origin")) do
        {:remote, remote} ->
          relay_json(conn, OriginRouter.forward(remote, "/api/v1/config/#{id}", params), fn name,
                                                                                           reason ->
            %{ok: false, error: "forward to #{name} failed: #{inspect(reason)}"}
          end)

        :local ->
          write_local(conn, id, text, params)

        {:error, {:unknown_origin, origin}} ->
          bad_request(conn, OriginRouter.unknown_origin_message(origin))
      end
    else
      {:error, :unknown_id} -> bad_request(conn, unknown_id_message(raw))
    end
  end

  def create(conn, %{"id" => _}) do
    bad_request(conn, "text is required — send the file's full contents as a string")
  end

  # ── Local branches ───────────────────────────────────────────────────────

  defp write_local(conn, id, text, params) do
    # An ABSENT key is `:any` — last-write-wins, which is what a script or an
    # older client gets. A PRESENT one, including an explicit null meaning "I
    # read no file", is a caller asking to be stopped if the bytes moved. The
    # distinction is read off the params this clause matched, not off
    # `conn.params`: the same map either way here, but the load-bearing
    # question deserves to be asked of the value the function was given.
    opts =
      if Map.has_key?(params, "expected_digest"),
        do: [expected_digest: Map.get(params, "expected_digest")],
        else: []

    case ConfigFiles.write(id, text, opts) do
      {:ok, file} ->
        json(conn, Map.merge(file, %{ok: true, host: Poller.own_host_id()}))

      # A refusal about the BYTES the caller sent — a parse error, a
      # validator's complaint. The request is what has to change: 400.
      {:error, message} ->
        bad_request(conn, message)

      # The file moved under the editor. A DIFFERENT kind from the above and it
      # gets its own status, because the client branches on it: a conflict is
      # the one refusal with a recovery move attached ("show me what it says
      # now"), and an affordance that keys off a status survives a rewording of
      # the sentence, which keying off the prose does not. The two whole-list
      # endpoints already answered 409; this one answered 400 and the button
      # that reads it was therefore dead.
      {:conflict, message} ->
        conn |> put_status(409) |> json(%{ok: false, error: message, conflict: true})

      # A refusal about this MACHINE — felt missing from the daemon's PATH, a
      # validator that never answered. Nothing the caller sent is wrong and
      # nothing they can retype will help, so it must not arrive in the box
      # that means "your JSON is bad".
      {:unavailable, message} ->
        conn |> put_status(503) |> json(%{ok: false, error: message, unavailable: true})
    end
  end

  defp parse_id(raw) do
    case ConfigFiles.parse_id(raw) do
      {:ok, id} -> {:ok, id}
      :error -> {:error, :unknown_id}
    end
  end

  defp unknown_id_message(raw) do
    known = ConfigFiles.ids() |> Enum.map_join(", ", &to_string/1)
    "unknown config file #{inspect(raw)} (known: #{known})"
  end

  # ── Forwarding a READ ────────────────────────────────────────────────────

  # `OriginRouter.forward/4` POSTs, which is right for the write plane and
  # wrong for a read: the owning daemon serves `index`/`show` as GETs. So the
  # read verbs go through `forward_get/4` — the same transport the file-bytes
  # route uses — and relay the owner's response verbatim, content type
  # included. The remote answers `application/json`, so what reaches the client
  # is the owner's own JSON, unparsed and unreshaped by this hop.
  defp relay_get(conn, remote, path, params) do
    relay_bytes(conn, OriginRouter.forward_get(remote, path, Map.drop(params, ["id"])))
  end

  # ── Rendering ────────────────────────────────────────────────────────────

  defp bad_request(conn, message) do
    conn |> put_status(400) |> json(%{ok: false, error: message})
  end

  defp failed(conn, message) do
    conn |> put_status(500) |> json(%{ok: false, error: message})
  end
end
