defmodule ShuttleWeb.FeltEditController do
  @moduledoc """
  Felt-document surface edits (tags, opaque scalar frontmatter, native `due:`)
  for kanban cards — tag/horizon writes the kanban posts directly to Shuttle.

  Owner-routed via `Shuttle.OriginRouter`: the request carries the `origin` the
  composite board stamped. A local-owned card is edited here; a remote-owned
  card is forwarded to the owning daemon's identical `/felt-edit` over the SSH
  tunnel (origin stripped, so the owner edits its own loom mirror), and its
  response is relayed verbatim. Single-writer at the document holds — the owner
  daemon is the lone writer of a fiber it owns, and `felt edit` is the single
  felt-native writer (the same CLI Portolan shells for local cards).

  `POST /api/v1/felt-edit` body: `{ "fiber_id": "...", "origin": "...",
  "add": [...], "remove": [...], "set": {"key": scalar, ...}, "unset": [...],
  "due": "..." }`.

    * `add` / `remove` — tag diff (`felt edit --tag/--untag`).
    * `set` — opaque top-level scalar frontmatter (`felt edit --set key=value`);
      the felt CLI reads each value as a YAML scalar so booleans/numbers keep
      their type. Used by the cross-host kanban horizon edit (`horizon`/`cold`).
    * `unset` — remove opaque top-level keys (`felt edit --unset key`).
    * `due` — the native date. Absent leaves it; `null` clears it
      (`--due ""`); a string sets it (`--due <value>`).

  felt itself owns the validation (native-key guard, scalar-only, structured
  clobber refusal) and surfaces a loud non-zero exit, so the daemon does not
  re-implement those rails. An empty diff (no tags, no set/unset, no `due` key)
  is a 200 no-op.
  """

  use Phoenix.Controller, formats: [:json]
  import ShuttleWeb.RelayHelpers, only: [relay_text: 2]

  alias Shuttle.{Felt, FeltStores, OriginRouter, Poller, RemoteFiberRegistry}

  def create(conn, %{"fiber_id" => fiber_id} = params) when is_binary(fiber_id) do
    case OriginRouter.route(Map.get(params, "origin")) do
      {:remote, remote} ->
        result = OriginRouter.forward(remote, "/api/v1/felt-edit", conn.body_params)
        # The forwarded edit mutated the remote's loom mirror; invalidate the
        # RemoteFiberRegistry feed cache so the board reflects it before the next
        # remote poll. Mirrors Shuttle.Transition's refresh_remote_feed.
        refresh_remote_feed(remote.name, result)
        relay_text(conn, result)

      :local ->
        create_local(conn, fiber_id, params)
    end
  end

  def create(conn, _params) do
    conn
    |> put_resp_content_type("text/plain")
    |> send_resp(400, "fiber_id is required")
  end

  defp create_local(conn, fiber_id, params) do
    add = string_list(params["add"])
    remove = string_list(params["remove"])
    unset = string_list(params["unset"])

    with {:ok, set_pairs} <- set_pairs(params["set"]),
         {:ok, due_args} <- due_args(params),
         {:ok, host, address} <- host_for_fiber(fiber_id),
         {:ok, output} <- run(host, address, add, remove, unset, set_pairs, due_args) do
      # The edit mutated the felt doc (tags / horizon / due); re-read it into the
      # document cache NOW so the kanban's post-edit refetch reflects the change
      # instead of snapping the card back until the next poll.
      Poller.refresh_document(address)

      conn
      |> put_resp_content_type("text/plain")
      |> send_resp(200, output)
    else
      {:error, reason} when is_binary(reason) ->
        conn
        |> put_resp_content_type("text/plain")
        |> send_resp(400, reason)

      {:command_error, status, output} ->
        conn
        |> put_resp_content_type("text/plain")
        |> send_resp(422, "felt exited #{status}: #{output}")

      {:error, :timeout, reason} ->
        conn
        |> put_resp_content_type("text/plain")
        |> send_resp(503, reason)
    end
  end

  defp host_for_fiber(fiber_id) do
    case FeltStores.resolve_fiber(fiber_id) do
      {:ok, %{host: host, fiber_id: address}} -> {:ok, host, address}
      {:error, :not_found} -> {:error, "fiber not found: #{fiber_id}"}
      {:error, :timeout} -> {:error, :timeout, "felt timed out resolving #{fiber_id}"}
    end
  end

  # An empty diff is a no-op, mirroring Portolan's local felt-edit path.
  defp run(_host, _fiber_id, [], [], [], [], []), do: {:ok, ""}

  defp run(host, fiber_id, add, remove, unset, set_pairs, due_args) do
    args = ["-C", host, "edit", fiber_id]
    args = Enum.reduce(remove, args, fn tag, acc -> acc ++ ["--untag", tag] end)
    args = Enum.reduce(add, args, fn tag, acc -> acc ++ ["--tag", tag] end)
    args = Enum.reduce(unset, args, fn key, acc -> acc ++ ["--unset", key] end)
    args = Enum.reduce(set_pairs, args, fn pair, acc -> acc ++ ["--set", pair] end)
    args = args ++ due_args

    Felt.run(args)
  end

  # `set` is a map of opaque scalar frontmatter. Render each entry as the
  # `key=value` argument `felt edit --set` expects; felt re-parses the value as
  # a YAML scalar (so a JSON boolean `true` lands as the YAML boolean `true`).
  # Non-scalar values are refused here with a 400 rather than handed to felt.
  defp set_pairs(nil), do: {:ok, []}

  defp set_pairs(map) when is_map(map) do
    Enum.reduce_while(map, {:ok, []}, fn {key, value}, {:ok, acc} ->
      case scalar_string(value) do
        {:ok, encoded} -> {:cont, {:ok, acc ++ ["#{key}=#{encoded}"]}}
        :error -> {:halt, {:error, "set value for #{key} must be a scalar"}}
      end
    end)
  end

  defp set_pairs(_), do: {:error, "set must be an object of key/value pairs"}

  defp scalar_string(value) when is_binary(value), do: {:ok, value}
  defp scalar_string(value) when is_boolean(value), do: {:ok, to_string(value)}
  defp scalar_string(value) when is_number(value), do: {:ok, to_string(value)}
  defp scalar_string(_), do: :error

  # `due`: absent leaves the date untouched, `null` clears it (`--due ""`), a
  # string sets it. felt validates the date format and rejects loudly.
  defp due_args(params) do
    case Map.fetch(params, "due") do
      :error -> {:ok, []}
      {:ok, nil} -> {:ok, ["--due", ""]}
      {:ok, value} when is_binary(value) -> {:ok, ["--due", value]}
      {:ok, _} -> {:error, "due must be a string or null"}
    end
  end

  defp string_list(values) when is_list(values) do
    values
    |> Enum.filter(&is_binary/1)
    |> Enum.map(&String.trim/1)
    |> Enum.reject(&(&1 == ""))
  end

  defp string_list(_), do: []

  # Best-effort remote feed invalidation after a successful forward, mirroring
  # Shuttle.Transition.refresh_remote_feed: only on a 2xx, and a refresh failure
  # (or a dead registry) must never fail the request.
  defp refresh_remote_feed(name, {:forwarded, status, _body}) when status in 200..299 do
    RemoteFiberRegistry.refresh(name)
    :ok
  catch
    :exit, _reason -> :ok
  end

  defp refresh_remote_feed(_name, _result), do: :ok
end
