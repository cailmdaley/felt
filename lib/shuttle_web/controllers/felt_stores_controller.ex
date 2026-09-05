defmodule ShuttleWeb.FeltStoresController do
  @moduledoc """
  Agent-API endpoints for Shuttle's registered felt-store list.

  GET returns the human-curated base registry, not the symlink-expanded daemon
  polling list. POST persists the local registry. An empty POST list clears the
  persisted file so the daemon has no configured stores unless `FELT_STORES` is
  set.

  The origin map is also what the Stash/Capture forms' HOST picker offers, and
  each origin carries `native_folder_picker` — true when that host can raise an
  OS folder dialog (`POST /api/v1/choose-folder`), which is how the board
  decides between the native picker and asking for a typed absolute path.

  POST body: %{"felt_stores" => [string]}

  Returns:
    200  %{ok: true, felt_stores: [string], persisted_at: iso8601}
    400  %{error: string}
    500  %{error: string}
  """

  use Phoenix.Controller, formats: [:json]

  alias Shuttle.{FeltStores, FolderPicker, OriginRouter, Poller, Projects, RegistryCommon, Remote}

  @remote_timeout_ms 8_000

  def show(conn, _params) do
    own = Poller.own_host_id()
    local = local_origin(own)

    # C6: the same fleet chokepoint `Shuttle.OriginRouter` and the two remote
    # registries use, so this endpoint's remote list can never drift from what
    # routing and polling consider "configured".
    origins =
      RegistryCommon.configured_remotes()
      |> Enum.reduce(%{own => local}, fn remote, acc ->
        Map.put(acc, remote.name, remote_origin(remote))
      end)

    json(conn, %{
      host: own,
      origins: origins
    })
  end

  def create(conn, %{"felt_stores" => hosts}) when is_list(hosts) do
    case FeltStores.save(hosts) do
      {:ok, normalized} ->
        json(conn, %{
          ok: true,
          felt_stores: normalized,
          persisted_at: DateTime.to_iso8601(DateTime.utc_now())
        })

      {:error, reason} ->
        conn
        |> put_status(500)
        |> json(%{error: "failed to persist felt stores: #{format_error(reason)}"})
    end
  end

  def create(conn, _params) do
    conn
    |> put_status(400)
    |> json(%{error: "felt_stores must be an array of host paths"})
  end

  defp local_origin(host) do
    %{
      kind: "local",
      stale: false,
      felt_stores: FeltStores.configured_base_hosts(),
      expanded_felt_stores: FeltStores.configured_hosts(),
      # The curated picker-project list (Stash/Capture cities), separate from the
      # TCC-scoped poll-store list above. Absent/empty → the forms fall back to
      # store-registry + current-cards derivation, so this is purely additive.
      projects: Projects.configured_projects(),
      # Whether this host can raise its own OS folder dialog
      # (`POST /api/v1/choose-folder`). The pickers' "+ Add project…" needs to
      # know BEFORE the human clicks which affordance to offer, and the origin
      # payload is already the one thing both forms load; a remote's flag rides
      # in on its relayed origin, describing that remote's desktop, not ours.
      native_folder_picker: FolderPicker.available?()
    }
    |> Map.put(:host, host)
  end

  defp remote_origin(%Remote{} = remote) do
    url = Remote.felt_stores_url(remote)
    timeout = remote.request_timeout_ms || @remote_timeout_ms

    with {:ok, body} <- fetch_remote_registry(url, timeout),
         {:ok, decoded} <- Jason.decode(body),
         %{} = origin <- origin_for_remote(decoded) do
      origin
      |> Map.put("kind", "remote")
      |> Map.put("stale", false)
      # Presentation label, carried so the board can title an origin without
      # inventing its own name mapping. Never an address — routing keys off
      # `name` alone.
      |> Map.put("display", Remote.display_name(remote))
      |> Map.delete("expanded_felt_stores")
    else
      {:error, reason} -> remote_error(remote, reason)
      _ -> remote_error(remote, :malformed_response)
    end
  end

  defp origin_for_remote(%{"origins" => origins, "host" => host})
       when is_map(origins) and is_binary(host) do
    Map.get(origins, host)
  end

  defp origin_for_remote(%{"felt_stores" => stores} = decoded) when is_list(stores),
    do: decoded

  defp origin_for_remote(_), do: nil

  defp remote_error(%Remote{name: name} = remote, reason) do
    %{
      "kind" => "remote",
      "host" => name,
      "display" => Remote.display_name(remote),
      "stale" => true,
      "felt_stores" => [],
      "last_error" => format_error(reason)
    }
  end

  # Transport comes from the same chokepoint as the write plane — see
  # `OriginRouter.forward_client/0`. This is a read, not a forward, but it is the
  # same config key and the same client behaviour, so a test that stubs the
  # forward plane stubs this too.
  defp fetch_remote_registry(url, timeout) do
    OriginRouter.forward_client().get(url, timeout)
  rescue
    error -> {:error, error}
  catch
    kind, reason -> {:error, {kind, reason}}
  end

  defp format_error(%{message: message}) when is_binary(message), do: message

  defp format_error({:file_error, reason}),
    do: :file.format_error(reason) |> IO.iodata_to_binary()

  defp format_error(reason), do: inspect(reason)
end
