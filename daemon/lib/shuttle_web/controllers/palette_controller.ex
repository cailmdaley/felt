defmodule ShuttleWeb.PaletteController do
  @moduledoc """
  `GET /api/v1/palette`: fleet-wide items for Rex's native `rex.ui.pick` palette.

  Accepts optional `session_id`, `window_id`, `block_id`, or `fiber_id` query
  parameters to identify the currently focused thread and include quick
  lifecycle actions (Temper, To review, Rest, Discard, New session) for it.
  """

  use Phoenix.Controller, formats: [:json]

  def show(conn, params) do
    json(conn, Shuttle.Palette.fetch(params))
  end
end
