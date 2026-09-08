defmodule ShuttleWeb.FeltStoresController do
  @moduledoc """
  Agent-API endpoints for Shuttle's registered felt-store list.

  GET returns the human-curated base registry, not the symlink-expanded daemon
  polling list. POST persists the local registry. An empty POST list clears the
  persisted file so the daemon has no configured stores unless `FELT_STORES` is
  set.

  Each remote's origin is read from `Shuttle.RemoteFiberRegistry`'s cached owner
  feed — every host carries its own registry as that feed's `stores` block — so
  a slow remote goes stale in the picker rather than dropping out of it.

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

  import ShuttleWeb.TemporalComposite, only: [render_error: 1]

  alias Shuttle.{FeltStores, FolderPicker, Poller, Projects, RegistryCommon, Remote}
  alias Shuttle.RemoteFiberRegistry

  def show(conn, _params) do
    own = Poller.own_host_id()

    # C6: the same fleet chokepoint `Shuttle.OriginRouter` and the two remote
    # registries use, so this endpoint's remote list can never drift from what
    # routing and polling consider "configured".
    #
    # A remote's block comes off `RemoteFiberRegistry`'s cached owner feed (each
    # host serves its own registry as the feed's `stores` block), never a live
    # GET: a loaded remote answering slowly must not drop out of the picker.
    feeds = RemoteFiberRegistry.feeds()

    origins =
      RegistryCommon.configured_remotes()
      |> Enum.reduce(%{own => local_origin(own)}, fn remote, acc ->
        Map.put(acc, remote.name, remote_origin(remote, Map.get(feeds, remote.name)))
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

  @doc """
  This host's store-registry origin block: its curated store list, the expanded
  poll list, the picker projects, and whether it can raise an OS folder dialog.

  Public because the owner fiber feed carries it too — that is how a viewer's
  `/api/v1/felt-stores` learns a remote's registry without fetching it live.
  """
  def local_origin(host) do
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

  # A remote's cached registry block, stamped with this fleet's presentation
  # label and the feed's own staleness. `display` is never an address — routing
  # keys off `name` alone. A feed that has not yet carried a `stores` block
  # (never polled, or an owner too old to serve one) reads as an empty stale
  # origin, exactly as an unreachable host did.
  defp remote_origin(%Remote{} = remote, %{stores: %{} = stores} = feed) do
    stores
    |> Map.drop(["expanded_felt_stores"])
    |> Map.merge(%{
      "kind" => "remote",
      "host" => remote.name,
      "display" => Remote.display_name(remote),
      "stale" => feed.stale,
      "last_error" => render_error(feed[:last_error])
    })
  end

  defp remote_origin(%Remote{name: name} = remote, feed) do
    %{
      "kind" => "remote",
      "host" => name,
      "display" => Remote.display_name(remote),
      "stale" => true,
      "felt_stores" => [],
      "last_error" => render_error(feed[:last_error])
    }
  end

  defp format_error(%{message: message}) when is_binary(message), do: message

  defp format_error({:file_error, reason}),
    do: :file.format_error(reason) |> IO.iodata_to_binary()

  defp format_error(reason), do: inspect(reason)
end
