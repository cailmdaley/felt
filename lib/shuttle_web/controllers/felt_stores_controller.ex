defmodule ShuttleWeb.FeltStoresController do
  @moduledoc """
  Agent-API endpoints for Shuttle's registered felt-store list.

  GET returns the human-curated base registry, not the symlink-expanded daemon
  polling list. POST persists the local registry. An empty POST list clears the
  persisted file so the daemon has no configured stores unless `FELT_STORES` is
  set.

  POST body: %{"felt_stores" => [string]}

  Returns:
    200  %{ok: true, felt_stores: [string], persisted_at: iso8601}
    400  %{error: string}
    500  %{error: string}
  """

  use Phoenix.Controller, formats: [:json]

  alias Shuttle.{FeltStores, Poller, Remote}

  @remote_timeout_ms 2_000

  def show(conn, _params) do
    own = Poller.own_host_id()
    local = local_origin(own)

    origins =
      Application.get_env(:shuttle, :remotes, [])
      |> Remote.from_config_list()
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
      expanded_felt_stores: FeltStores.configured_hosts()
    }
    |> Map.put(:host, host)
  end

  defp remote_origin(%Remote{} = remote) do
    url = Remote.felt_stores_url(remote)
    timeout = min(remote.request_timeout_ms || @remote_timeout_ms, @remote_timeout_ms)

    with {:ok, body} <- fetch_remote_registry(url, timeout),
         {:ok, decoded} <- Jason.decode(body),
         %{} = origin <- origin_for_remote(decoded, remote.name) do
      origin
      |> Map.put("kind", "remote")
      |> Map.put("stale", false)
      |> Map.delete("expanded_felt_stores")
    else
      {:error, reason} -> remote_error(remote, reason)
      _ -> remote_error(remote, :malformed_response)
    end
  end

  defp origin_for_remote(%{"origins" => origins, "host" => host}, _name)
       when is_map(origins) and is_binary(host) do
    Map.get(origins, host)
  end

  defp origin_for_remote(%{"felt_stores" => stores} = decoded, _name) when is_list(stores),
    do: decoded

  defp origin_for_remote(_, _name), do: nil

  defp remote_error(%Remote{name: name}, reason) do
    %{
      "kind" => "remote",
      "host" => name,
      "stale" => true,
      "felt_stores" => [],
      "last_error" => format_error(reason)
    }
  end

  defp remote_client do
    Application.get_env(:shuttle, :write_forward_client, Shuttle.RemoteRegistry.Client.Default)
  end

  defp fetch_remote_registry(url, timeout) do
    remote_client().get(url, timeout)
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
