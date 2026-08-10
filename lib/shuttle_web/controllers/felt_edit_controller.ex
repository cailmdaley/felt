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
  "due": "...", "name": "...", "body": "..." }`.

    * `add` / `remove` — tag diff (`felt edit --tag/--untag`).
    * `set` — opaque top-level scalar frontmatter (`felt edit --set key=value`);
      the felt CLI reads each value as a YAML scalar so booleans/numbers keep
      their type. Used by the cross-host kanban horizon edit (`horizon`/`cold`).
    * `unset` — remove opaque top-level keys (`felt edit --unset key`).
    * `due` — the native date. Absent leaves it; `null` clears it
      (`--due ""`); a string sets it (`--due <value>`).
    * `name` — the fiber's name (`felt edit --name`). Native, so it has a
      dedicated key rather than riding `set`, which felt refuses for native
      keys. A blank name is refused here: renaming to nothing is not a rename.
    * `body` — the full body text (`felt edit --body`), a DESTRUCTIVE overwrite
      of everything below the frontmatter, which is felt's own semantics for
      the flag. The caller is expected to have the current body in hand and to
      be sending the whole of it back; `""` empties the body. There is no
      append. The chronicle's era face writes an intention through this.

  felt itself owns the validation (native-key guard, scalar-only, structured
  clobber refusal) and surfaces a loud non-zero exit, so the daemon does not
  re-implement those rails. An empty diff (no tags, no set/unset, no `due` key)
  is a 200 no-op.
  """

  use Phoenix.Controller, formats: [:json]
  import ShuttleWeb.RelayHelpers, only: [relay_text: 2, send_cli_result: 3, host_for_fiber: 1]

  alias Shuttle.{Felt, OriginRouter, Poller, RemoteFiberRegistry}

  def create(conn, %{"fiber_id" => fiber_id} = params) when is_binary(fiber_id) do
    case OriginRouter.route(Map.get(params, "origin")) do
      {:remote, remote} ->
        result = OriginRouter.forward(remote, "/api/v1/felt-edit", conn.body_params)
        # The forwarded edit mutated the remote's loom mirror; invalidate the
        # RemoteFiberRegistry feed cache so the board reflects it before the next
        # remote poll.
        RemoteFiberRegistry.refresh_after_forward(remote.name, result)
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
         {:ok, native_args} <- native_args(params),
         {:ok, host, address} <- host_for_fiber(fiber_id),
         {:ok, output} <-
           run(host, address, add, remove, unset, set_pairs, due_args ++ native_args) do
      # The edit mutated the felt doc (tags / horizon / due); re-read it into the
      # document cache NOW so the kanban's post-edit refetch reflects the change
      # instead of snapping the card back until the next poll.
      Poller.refresh_document(address)

      conn
      |> put_resp_content_type("text/plain")
      |> send_resp(200, output)
    else
      other -> send_cli_result(conn, "felt", other)
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

  # `name` and `body`: felt-native fields with dedicated flags. Absent leaves
  # each untouched. `name` must carry actual text — felt would take a blank one
  # and leave a fiber nothing answers to. `body` may be `""`, which empties the
  # body; that is a deliberate erasure, not a missing value, and only the
  # explicit key expresses it.
  defp native_args(params) do
    with {:ok, name} <- native_arg(params, "name", "--name", allow_blank: false),
         {:ok, body} <- native_arg(params, "body", "--body", allow_blank: true) do
      {:ok, name ++ body}
    end
  end

  defp native_arg(params, key, flag, opts) do
    case Map.fetch(params, key) do
      :error ->
        {:ok, []}

      {:ok, value} when is_binary(value) ->
        if String.trim(value) == "" and not Keyword.fetch!(opts, :allow_blank),
          do: {:error, "#{key} must not be blank"},
          else: {:ok, [flag, value]}

      {:ok, _} ->
        {:error, "#{key} must be a string"}
    end
  end

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
end
