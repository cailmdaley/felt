defmodule ShuttleWeb.ErrorJSON do
  @moduledoc """
  Renders error responses as JSON.

  The daemon is a JSON API + SPA host (no server-rendered HTML), so every error
  path — a 404 on an unknown route, a 500 from a crashing plug — should surface
  as `{"errors": {"detail": "<status message>"}}`, not a render crash. Wired in
  via the endpoint's `render_errors` config (`config/config.exs`); without it
  Phoenix falls back to a non-existent `ShuttleWeb.ErrorView` and the error
  render itself raises, masking the real status behind an opaque 500.
  """

  # By default render/2 turns the template name into the status message:
  #   "404.json" -> "Not Found", "500.json" -> "Internal Server Error".
  def render(template, _assigns) do
    %{errors: %{detail: Phoenix.Controller.status_message_from_template(template)}}
  end
end
