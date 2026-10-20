defmodule ShuttleWeb.RolesController do
  @moduledoc """
  Lists shared role charters through `shuttle roles --json` in the configured
  stores. Roles are synchronized documents, so this read is local, not
  owner-routed. An unavailable or malformed CLI response contributes no roles.
  """
  use Phoenix.Controller, formats: [:json]

  require Logger

  def index(conn, _params) do
    roles =
      Shuttle.FeltStores.configured_stores()
      |> Enum.flat_map(&list_roles/1)
      |> Enum.uniq_by(& &1["slug"])
      |> Enum.sort_by(& &1["slug"])

    json(conn, roles)
  end

  defp list_roles(store) do
    with {:ok, output} <- Shuttle.CLI.run_in_store(store, ["roles", "--json"]),
         {:ok, records} when is_list(records) <- Jason.decode(output) do
      Enum.filter(records, fn
        %{"slug" => slug, "name" => name, "outcome" => outcome}
        when is_binary(slug) and is_binary(name) and is_binary(outcome) ->
          true

        _ ->
          false
      end)
    else
      error ->
        Logger.warning("GET /api/v1/roles: shuttle roles failed: #{inspect(error)}")
        []
    end
  end
end
