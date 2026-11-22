defmodule ShuttleWeb.GoController do
  @moduledoc """
  `POST /api/v1/go {fiber_id, origin}`: move the Mac's Rex app to the fiber's
  live worker (`Shuttle.Go`). Owner-routed like `/transition`.

  200 `{went, place}`: `place` is `"live"` for a live worker, `"view"` for a
  view-only Rex place (including resting, draft, tempered, or discarded fibers
  when pages are enabled), or `"none"` when pages are disabled and no worker is
  live; `went: false` with `"live"` or `"view"` means Rex could not show it.
  400 for a missing `fiber_id` or an unknown origin, 404 for an unknown fiber,
  502 when Rex or the owner cannot be reached. An owner's refusal is relayed
  verbatim.
  """

  use Phoenix.Controller, formats: [:json]

  import ShuttleWeb.RelayHelpers, only: [relay_json: 3]

  def create(conn, %{"target" => target}) when target in ["desk", "map"] do
    result = if target == "desk", do: Shuttle.Go.desk(), else: Shuttle.Go.map()

    case result do
      {:ok, answer} ->
        json(conn, answer)

      {:error, reason} ->
        {status, error} = Shuttle.Go.http_error(reason)
        conn |> put_status(status) |> json(%{went: false, error: error})
    end
  end

  def create(conn, %{"fiber_id" => fiber_id} = params)
      when is_binary(fiber_id) and fiber_id != "" do
    case Shuttle.Go.go(fiber_id, params["origin"], forwarded: params["forwarded"] == true) do
      {:ok, answer} ->
        json(conn, answer)

      {:forwarded, _, _} = refused ->
        relay_json(conn, refused, fn _, _ -> %{} end)

      {:error, reason} ->
        {status, error} = Shuttle.Go.http_error(reason)
        conn |> put_status(status) |> json(%{went: false, error: error})
    end
  end

  def create(conn, _params), do: conn |> put_status(400) |> json(%{error: "fiber_id is required"})
end
