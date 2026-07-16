defmodule ShuttleWeb.FileController do
  @moduledoc """
  Serve file/asset bytes by absolute path: `GET /api/v1/file?path=…&origin=…`.

  The one genuine backend addition the standalone Shuttle UI needs. The fiber
  detail panel renders the daemon's raw markdown lean (`marked`), but a
  `:::{embed}` artifact and a relative image are file *bytes*, not markdown —
  this route delivers them. It is also what lets a remote-owned fiber's body and
  assets render: only the owning daemon can read its own host's filesystem.

  **Owner-routed via `Shuttle.OriginRouter`, exactly like `/kill` and
  `/felt-edit`.** The composite board stamps each fiber with its `origin`; the
  panel carries that origin back. A local-owned path is read here; a
  remote-owned path forwards to the owning daemon's identical `/file` (origin
  stripped) over the SSH tunnel and relays its bytes + content-type verbatim
  (`OriginRouter.forward_get/4`).

  **Path contract.** `path` must be ABSOLUTE — the panel resolves a fiber's
  `:::{embed} <rel>` against the fiber's own directory client-side before
  calling, and an absolute embed (a paper build outside `.felt/`) is passed
  through as-is. There is deliberately no felt-store sandbox: the constitution
  wants paper builds outside any store to render, and the trust model is the
  localhost/trusted-cluster daemon the rest of the API already assumes (it shells
  out to felt over arbitrary stores). A relative path is a 400; a missing file is
  a 404; neither 500s the panel.
  """

  use Phoenix.Controller, formats: [:json]
  import ShuttleWeb.RelayHelpers, only: [relay_bytes: 2]

  alias Shuttle.OriginRouter

  def show(conn, %{"path" => path} = params) when is_binary(path) and path != "" do
    case OriginRouter.route(Map.get(params, "origin")) do
      {:remote, remote} ->
        relay_bytes(conn, OriginRouter.forward_get(remote, "/api/v1/file", %{"path" => path}))

      :local ->
        serve_local(conn, path)
    end
  end

  def show(conn, _params) do
    conn |> put_status(400) |> json(%{error: "path is required"})
  end

  defp serve_local(conn, path) do
    cond do
      Path.type(path) != :absolute ->
        conn |> put_status(400) |> json(%{error: "path must be absolute"})

      not File.regular?(path) ->
        conn |> put_status(404) |> json(%{error: "file not found"})

      true ->
        conn
        |> put_resp_content_type(MIME.from_path(path))
        |> send_file(200, path)
    end
  end
end
