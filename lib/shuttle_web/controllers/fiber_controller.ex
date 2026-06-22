defmodule ShuttleWeb.FiberController do
  @moduledoc """
  Agent-API endpoint for fiber creation, owner-routed.

  A create targets the daemon owning the destination project. The caller stamps
  the destination's `origin` (the same key the composite feed carries); this
  controller either writes locally (origin is itself / absent) or forwards the
  POST to the owning remote's identical `/api/v1/fiber/create` over the tunnel
  (`Shuttle.OriginRouter`, the one forwarder behind every write endpoint) — the
  file must be written where the project lives, since `felt add` and the
  `project_dir` existence check resolve against that host's filesystem. The
  owner runs the forwarded request as local (origin stripped) and auto-stamps
  its own `shuttle.host`, so a remote stash is born owned by the right daemon.

  Placement and identity belong to felt, not to this controller. The local write
  shells out to `felt add ... --top-level`, which mints the intrinsic ULID, owns
  the on-disk layout, and rejects duplicates. The controller then reads felt's
  carried `path` back via `felt show -j` and splices the non-native frontmatter
  (the `shuttle:` block and any other custom keys) into the file felt wrote —
  exactly the read-then-edit-the-markdown flow felt prescribes for non-native
  frontmatter. There is no hand-built path and no reverse-derivation of layout.
  """

  use Phoenix.Controller, formats: [:json]
  import ShuttleWeb.RelayHelpers, only: [relay_json: 3]

  alias Shuttle.{FeltStores, FrontmatterEdit, OriginRouter}

  # Frontmatter keys felt owns natively and writes itself on `felt add`. Anything
  # the caller supplies outside this set is non-native and gets spliced into the
  # file after felt creates it. (`id`/`created-at` are felt-minted, never caller-
  # supplied; they round out the set of keys we must not re-inject.)
  @felt_native_keys ~w(id name status tags outcome due created-at)

  def create(conn, params) do
    case OriginRouter.route(Map.get(params, "origin")) do
      {:remote, remote} ->
        relay_json(conn, OriginRouter.forward(remote, "/api/v1/fiber/create", conn.body_params), &forward_failed/2)

      :local ->
        create_local(conn, params)
    end
  end

  defp create_local(conn, params) do
    with {:ok, fiber_id} <- required_string(params, "id"),
         {:ok, name} <- required_string(params, "name"),
         {:ok, body} <- optional_string(params, "body", ""),
         {:ok, frontmatter} <- normalize_frontmatter(params, name),
         {:ok, frontmatter} <- normalize_shuttle_host(frontmatter),
         :ok <- validate_shuttle(frontmatter["shuttle"], frontmatter["status"]),
         :ok <- validate_fiber_id(fiber_id),
         {:ok, path} <- felt_add(fiber_id, name, body, frontmatter),
         :ok <- inject_non_native_frontmatter(path, frontmatter) do
      json(conn, %{id: fiber_id, path: path})
    else
      {:error, reason} ->
        conn
        |> put_status(400)
        |> json(%{error: reason})
    end
  end

  # The tunnel-failure body for a forwarded create (its own shape: a flat
  # `error`/`origin`/`detail`, not the `*: false` envelope the spawn endpoints use).
  defp forward_failed(name, reason),
    do: %{error: "forward_failed", origin: name, detail: inspect(reason)}

  defp normalize_frontmatter(params, name) do
    case Map.get(params, "frontmatter", %{}) do
      frontmatter when is_map(frontmatter) ->
        {:ok,
         frontmatter
         |> stringify_keys()
         |> Map.put_new("name", name)
         |> Map.put_new("status", "active")}

      _ ->
        {:error, "frontmatter must be an object"}
    end
  end

  # Auto-stamp `host:` on new fibers with a shuttle block. Cross-host
  # blocks (an explicit `host:` that doesn't equal this daemon's identity)
  # are refused — the caller is asking the wrong daemon to write a file
  # for someone else's machine. See Shuttle.Poller.own_host_id/0 for the
  # resolution chain.
  defp normalize_shuttle_host(%{"shuttle" => shuttle} = frontmatter) when is_map(shuttle) do
    own_host = Shuttle.Poller.own_host_id()
    shuttle = stringify_keys(shuttle)

    case Map.get(shuttle, "host") do
      nil ->
        {:ok, %{frontmatter | "shuttle" => Map.put(shuttle, "host", own_host)}}

      "" ->
        {:ok, %{frontmatter | "shuttle" => Map.put(shuttle, "host", own_host)}}

      ^own_host ->
        {:ok, %{frontmatter | "shuttle" => shuttle}}

      other ->
        {:error,
         "shuttle.host #{inspect(other)} does not match this daemon host #{inspect(own_host)}"}
    end
  end

  defp normalize_shuttle_host(frontmatter), do: {:ok, frontmatter}

  defp validate_shuttle(nil, _status), do: :ok

  # An armed shuttle fiber (status: active — the sole dispatch gate, slice 5)
  # must declare a project_dir that exists on this host; the worker starts there
  # rather than falling back to the felt store. A draft (status: open) carries
  # no such requirement.
  defp validate_shuttle(shuttle, status) when is_map(shuttle) do
    cond do
      status != "active" ->
        :ok

      not is_binary(Map.get(shuttle, "project_dir")) or Map.get(shuttle, "project_dir") == "" ->
        {:error, "shuttle.project_dir is required when status: active"}

      not File.dir?(Path.expand(Map.fetch!(shuttle, "project_dir"))) ->
        {:error, "shuttle.project_dir does not exist on this host"}

      true ->
        :ok
    end
  end

  defp validate_shuttle(_, _), do: {:error, "shuttle must be an object"}

  # Let felt own placement, identity, and duplicate-rejection. `--top-level`
  # disables felt's leading-segment slug resolution so the fiber lands at the
  # exact id the caller asked for instead of being relocated under a matching
  # parent — preserving the daemon-local create contract (id in, id out).
  # felt mints the ULID into frontmatter (`id:`), so POST-created fibers are
  # born with a real intrinsic identity. We read the carried `path` straight
  # back from felt rather than reconstructing it.
  defp felt_add(fiber_id, name, body, frontmatter) do
    root = felt_root(frontmatter)

    args =
      ["-C", root, "add", fiber_id, name, "--top-level", "-s", status_of(frontmatter)] ++
        body_args(body) ++ tag_args(frontmatter)

    with :ok <- ensure_felt_repo(root),
         {_output, 0} <- System.cmd("felt", args, stderr_to_stdout: true) do
      felt_path(root, fiber_id)
    else
      {:error, reason} -> {:error, reason}
      {output, _status} -> {:error, "felt add failed: #{String.trim(output)}"}
    end
  rescue
    error -> {:error, "felt add failed: #{Exception.message(error)}"}
  end

  # Keep the endpoint self-sufficient the way the old raw-write was: a daemon
  # store is normally already a felt repo, but `project_dir` may be a fresh
  # checkout. `felt init` is idempotent ("creates or repairs"), so this is a
  # no-op on existing stores and the missing-repo fix on new ones. felt's
  # `init` ignores `-C` for placement and writes `.felt/` at its working
  # directory, so we drive it with `cd:` rather than `-C`.
  defp ensure_felt_repo(root) do
    File.mkdir_p!(root)

    case System.cmd("felt", ["init"], cd: root, stderr_to_stdout: true) do
      {_output, 0} -> :ok
      {output, _status} -> {:error, "felt init failed: #{String.trim(output)}"}
    end
  end

  defp felt_path(root, fiber_id) do
    case System.cmd("felt", ["-C", root, "show", fiber_id, "-j"], stderr_to_stdout: false) do
      {output, 0} ->
        case Jason.decode(output) do
          {:ok, %{"path" => path}} when is_binary(path) and path != "" -> {:ok, path}
          _ -> {:error, "felt show returned no path for #{fiber_id}"}
        end

      {_output, _status} ->
        {:error, "felt show could not locate #{fiber_id} after create"}
    end
  rescue
    error -> {:error, "felt show failed: #{Exception.message(error)}"}
  end

  defp status_of(frontmatter), do: Map.get(frontmatter, "status", "active")

  defp body_args(""), do: []
  defp body_args(body) when is_binary(body), do: ["-b", body]

  defp tag_args(%{"tags" => tags}) when is_list(tags) do
    tags
    |> Enum.filter(&is_binary/1)
    |> Enum.flat_map(&["-t", &1])
  end

  defp tag_args(_frontmatter), do: []

  defp validate_fiber_id(fiber_id) do
    segments = String.split(fiber_id, "/")

    cond do
      fiber_id == "" ->
        {:error, "id is required"}

      String.starts_with?(fiber_id, "/") ->
        {:error, "id must be relative"}

      Enum.any?(segments, &(&1 in ["", ".", ".."])) ->
        {:error, "id contains an invalid path segment"}

      true ->
        :ok
    end
  end

  # Splice the caller's non-native frontmatter (the `shuttle:` block and any
  # other custom keys felt does not own) into the file felt just wrote, leaving
  # felt's native frontmatter — including the minted `id:` — byte-for-byte
  # intact. New keys are inserted immediately before the closing `---`.
  defp inject_non_native_frontmatter(path, frontmatter) do
    extra = Map.drop(frontmatter, @felt_native_keys)

    if extra == %{} do
      :ok
    else
      case File.read(path) do
        {:ok, content} -> splice(path, content, extra)
        {:error, reason} -> {:error, "reading created fiber: #{:file.format_error(reason)}"}
      end
    end
  end

  defp splice(path, content, extra) do
    case String.split(content, "---\n", parts: 3) do
      ["", frontmatter, rest] ->
        rendered = FrontmatterEdit.render(extra)
        payload = ["---\n", frontmatter, rendered, "---\n", rest]
        atomic_write(path, payload)

      _ ->
        {:error, "created fiber has unexpected frontmatter layout"}
    end
  end

  defp atomic_write(path, payload) do
    tmp = path <> ".tmp"

    with :ok <- File.write(tmp, payload),
         :ok <- File.rename(tmp, path) do
      :ok
    else
      {:error, reason} -> {:error, "writing fiber: #{:file.format_error(reason)}"}
    end
  end

  defp felt_root(%{"shuttle" => %{"project_dir" => project_dir}})
       when is_binary(project_dir) and project_dir != "" do
    Path.expand(project_dir)
  end

  defp felt_root(_frontmatter) do
    FeltStores.configured_hosts()
    |> List.first()
  end

  defp required_string(params, key) do
    case Map.get(params, key) do
      value when is_binary(value) and value != "" -> {:ok, value}
      _ -> {:error, "#{key} is required"}
    end
  end

  defp optional_string(params, key, default) do
    case Map.get(params, key, default) do
      value when is_binary(value) -> {:ok, value}
      _ -> {:error, "#{key} must be a string"}
    end
  end

  defp stringify_keys(map) do
    Map.new(map, fn {key, value} -> {to_string(key), stringify_value(value)} end)
  end

  defp stringify_value(value) when is_map(value), do: stringify_keys(value)
  defp stringify_value(value) when is_list(value), do: Enum.map(value, &stringify_value/1)
  defp stringify_value(value), do: value
end
