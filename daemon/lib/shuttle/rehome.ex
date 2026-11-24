defmodule Shuttle.Rehome do
  @moduledoc """
  Orchestrates moving a constitution from its current owning host to a new host.

  A fiber has one owning daemon (`shuttle.host`). Rehoming runs in two phases so
  a failure on the destination never leaves the source stopped and homeless:

    1. **Takeover on `target_host` (authoritative)**: optionally carries the
       freshest fiber document (exported best-effort from `origin`, falling back
       to this host's local store), adopts it if `target_host` does not already
       own it, and runs `shuttle set-host <fiber> <target_host> [--project-dir]`
       serialized inside `target_host`'s Poller. If `target_host` is unreachable
       or rejects `project_dir`, the move fails without touching `origin`.
    2. **Release on `origin` (best-effort)**: when `origin` is known and differs
       from `target_host`, tells `origin` to write `shuttle.host: target_host`,
       stop any live worker, and drop its Rex place. If `origin` is down or
       unreachable, takeover still succeeds and reports a non-fatal warning.
  """

  alias Shuttle.{
    CarriedDocument,
    FeltStores,
    FS,
    LifecycleService,
    OriginRouter,
    Poller,
    RemoteFiberRegistry
  }

  @export_timeout_ms 5_000
  @release_timeout_ms 8_000

  @doc "Execute a rehome request (orchestrated, or a single phase when forwarded)."
  def handle(%{"phase" => "export"} = params), do: handle_export(params)
  def handle(%{"phase" => "takeover"} = params), do: handle_takeover(params)
  def handle(%{"phase" => "release"} = params), do: handle_release(params)
  def handle(params), do: orchestrate(params)

  defp orchestrate(params) do
    fiber = trim(params["fiber"])
    target_host = trim(params["target_host"])
    origin = trim(params["origin"])
    project_dir = params["project_dir"]
    fiber_path = trim(params["fiber_path"])

    cond do
      fiber == nil ->
        {:error, 400, %{ok: false, error: "fiber is required"}}

      target_host == nil or String.match?(target_host, ~r/\s/) ->
        {:error, 400, %{ok: false, error: "target_host must be a non-empty host id"}}

      true ->
        case OriginRouter.route_host(target_host) do
          {:error, {:unknown_origin, unknown}} ->
            {:error, 400, %{ok: false, error: OriginRouter.unknown_origin_message(unknown)}}

          target_route ->
            if origin != nil and origin == target_host and not is_binary(project_dir) do
              {:ok, %{ok: true, fiber: fiber, host: target_host, unchanged: true}}
            else
              run_orchestrated(fiber, origin, target_host, target_route, project_dir, fiber_path)
            end
        end
    end
  end

  defp run_orchestrated(fiber, origin, target_host, target_route, project_dir, fiber_path) do
    {doc, exported_uid, exported_path} =
      best_effort_export(fiber, origin, fiber_path)

    effective_fiber = exported_uid || fiber
    effective_path = exported_path || fiber_path

    takeover_payload =
      %{
        "phase" => "takeover",
        "fiber" => effective_fiber,
        "target_host" => target_host
      }
      |> maybe_put("project_dir", project_dir)
      |> maybe_put("fiber_path", effective_path)
      |> maybe_put("document", doc)

    with {:ok, taken} <- dispatch_phase(target_route, takeover_payload, nil) do
      refresh_remote_cache(target_route)

      resolved_project_dir = taken["project_dir"] || trim(project_dir)
      resolved_uid = taken["uid"] || exported_uid
      resolved_fiber = taken["fiber"] || effective_fiber

      {released?, warning} =
        if origin != nil and origin != target_host do
          release_previous_host(
            origin,
            resolved_uid || resolved_fiber,
            target_host,
            resolved_project_dir,
            effective_path
          )
        else
          {true, nil}
        end

      body =
        %{
          ok: true,
          fiber: resolved_fiber,
          host: target_host,
          from_host: origin,
          previous_host_released: released?
        }
        |> maybe_put(:uid, resolved_uid)
        |> maybe_put(:project_dir, resolved_project_dir)
        |> maybe_put(:previous_host_warning, warning)

      {:ok, body}
    end
  end

  defp best_effort_export(fiber, origin, fiber_path) do
    from_origin =
      case origin && OriginRouter.route_host(origin) do
        :local ->
          read_local_document(fiber, fiber_path)

        {:remote, remote} ->
          payload =
            %{"phase" => "export", "fiber" => fiber}
            |> maybe_put("fiber_path", fiber_path)

          case OriginRouter.forward(remote, "/api/v1/rehome", payload,
                 forward_timeout_ms: @export_timeout_ms
               ) do
            {:forwarded, 200, body} ->
              case Jason.decode(body) do
                {:ok, %{"ok" => true, "document" => doc} = decoded} when is_binary(doc) ->
                  {doc, decoded["uid"], decoded["fiber_path"]}

                _ ->
                  nil
              end

            _ ->
              nil
          end

        _ ->
          nil
      end

    case from_origin do
      {doc, uid, path} when is_binary(doc) ->
        {doc, uid, path}

      _ ->
        # Origin was unreachable or lacked the file; fall back to this host's local store.
        read_local_document(fiber, fiber_path) || {nil, nil, nil}
    end
  end

  defp read_local_document(fiber, fiber_path) do
    with {:ok, %{path: path, uid: uid, fiber_id: fiber_id}} <-
           FeltStores.resolve_request(fiber, fiber_path),
         {:ok, content} <- FS.read(path) do
      {content, uid, fiber_id}
    else
      _ -> nil
    end
  end

  defp handle_export(params) do
    fiber = trim(params["fiber"])
    fiber_path = trim(params["fiber_path"])

    case fiber && read_local_document(fiber, fiber_path) do
      {content, uid, resolved_path} ->
        {:ok,
         %{
           ok: true,
           document: content,
           uid: uid,
           fiber_path: resolved_path
         }}

      _ ->
        {:error, 404, %{ok: false, error: "fiber not found on #{Poller.own_host_id()}"}}
    end
  end

  defp handle_takeover(params) do
    fiber = trim(params["fiber"])
    target_host = trim(params["target_host"]) || Poller.own_host_id()
    own = Poller.own_host_id()
    fiber_path = trim(params["fiber_path"])
    project_dir = params["project_dir"]

    cond do
      fiber == nil ->
        {:error, 400, %{ok: false, error: "fiber is required"}}

      target_host != own ->
        {:error, 400,
         %{ok: false, error: "takeover target_host #{target_host} does not match #{own}"}}

      true ->
        with {:ok, _carried} <- adopt_if_carried(params, fiber),
             {:ok, output} <-
               LifecycleService.transition(
                 :set_host,
                 fiber,
                 set_host_args(target_host, project_dir),
                 fiber_path
               ) do
          resolved = resolve_after_write(fiber, fiber_path)

          {:ok,
           %{
             "ok" => true,
             "host" => own,
             "fiber" => (resolved && resolved.fiber_id) || fiber,
             "uid" => resolved && resolved.uid,
             "project_dir" => parse_project_dir_from_output(output) || trim(project_dir),
             "output" => output
           }}
        else
          error -> format_cli_error(error, own)
        end
    end
  end

  defp handle_release(params) do
    fiber = trim(params["fiber"])
    target_host = trim(params["target_host"])
    fiber_path = trim(params["fiber_path"])
    project_dir = params["project_dir"]
    own = Poller.own_host_id()

    cond do
      fiber == nil or target_host == nil ->
        {:error, 400, %{ok: false, error: "fiber and target_host are required"}}

      target_host == own ->
        {:ok, %{"ok" => true, "released" => false}}

      true ->
        case LifecycleService.transition(
               :set_host,
               fiber,
               set_host_args(target_host, project_dir),
               fiber_path
             ) do
          {:ok, output} ->
            {:ok, %{"ok" => true, "released" => true, "output" => output}}

          {:error, :not_found, _reason} ->
            # Old host doesn't even have the fiber; nothing left to release.
            {:ok, %{"ok" => true, "released" => true}}

          error ->
            format_cli_error(error, own)
        end
    end
  end

  defp release_previous_host(origin, fiber, target_host, project_dir, fiber_path) do
    payload =
      %{
        "phase" => "release",
        "fiber" => fiber,
        "target_host" => target_host
      }
      |> maybe_put("project_dir", project_dir)
      |> maybe_put("fiber_path", fiber_path)

    case OriginRouter.route_host(origin) do
      {:error, {:unknown_origin, _}} ->
        {false,
         "#{origin} is not in this daemon's fleet; sync stores on #{origin} so it drops its stale copy."}

      route ->
        case dispatch_phase(route, payload, @release_timeout_ms) do
          {:ok, _} ->
            refresh_remote_cache(route)
            {true, nil}

          {:error, _status, _body} ->
            {false,
             "#{origin} was unreachable; sync stores when it returns so it drops its stale copy."}
        end
    end
  end

  defp dispatch_phase(:local, payload, _timeout_ms) do
    case handle(payload) do
      {:ok, body} -> {:ok, stringify_keys(body)}
      {:error, status, body} -> {:error, status, body}
    end
  end

  defp dispatch_phase({:remote, remote}, payload, timeout_ms) do
    opts = if timeout_ms, do: [forward_timeout_ms: timeout_ms], else: []

    case OriginRouter.forward(remote, "/api/v1/rehome", payload, opts) do
      {:forwarded, status, body} when status in 200..299 ->
        case Jason.decode(body) do
          {:ok, decoded} when is_map(decoded) -> {:ok, decoded}
          _ -> {:ok, %{"ok" => true}}
        end

      {:forwarded, status, body} ->
        case Jason.decode(body) do
          {:ok, decoded} when is_map(decoded) -> {:error, status, decoded}
          _ -> {:error, status, %{ok: false, error: String.trim(body)}}
        end

      {:error, {:forward_failed, name, reason}} ->
        {:error, 502,
         %{ok: false, error: "could not reach #{name}: #{inspect(reason)}", host: name}}

      {:error, reason} ->
        {:error, 502, %{ok: false, error: "could not reach #{remote.name}: #{inspect(reason)}"}}
    end
  end

  defp refresh_remote_cache({:remote, remote}) do
    RemoteFiberRegistry.refresh_after_forward(remote.name, {:forwarded, 200, ""})
  end

  defp refresh_remote_cache(_), do: :ok

  defp adopt_if_carried(%{"document" => doc} = params, fiber) when is_binary(doc) do
    case CarriedDocument.adopt(params, fiber) do
      {:ok, output} -> {:ok, output}
      {:error, :not_found, _} -> {:ok, ""}
      other -> other
    end
  end

  defp adopt_if_carried(_, _), do: {:ok, ""}

  defp set_host_args(target_host, project_dir) do
    if is_binary(project_dir) and String.trim(project_dir) != "" do
      [target_host, "--project-dir", String.trim(project_dir)]
    else
      [target_host]
    end
  end

  defp resolve_after_write(fiber, fiber_path) do
    case FeltStores.resolve_request(fiber, fiber_path) do
      {:ok, resolved} -> resolved
      _ -> nil
    end
  end

  defp parse_project_dir_from_output(output) when is_binary(output) do
    case Regex.run(~r/project_dir=(\S+)/, output) do
      [_, dir] -> dir
      _ -> nil
    end
  end

  defp parse_project_dir_from_output(_), do: nil

  defp format_cli_error({:error, :not_found, reason}, host) do
    {:error, 404, %{ok: false, error_code: "fiber_not_found", host: host, error: reason}}
  end

  defp format_cli_error({:error, :timeout, reason}, host) do
    {:error, 503, %{ok: false, host: host, error: reason, retryable: true}}
  end

  defp format_cli_error({:command_error, _status, output}, host) do
    msg = String.trim(to_string(output))

    if String.contains?(msg, "project_dir") or String.contains?(msg, "does not exist") or
         String.contains?(msg, "not a directory") do
      {:error, 422,
       %{
         ok: false,
         reason: "project_dir_invalid",
         needs: "project_dir",
         host: host,
         error: msg
       }}
    else
      {:error, 422, %{ok: false, host: host, error: msg}}
    end
  end

  defp format_cli_error({:error, reason}, host) do
    {:error, 500, %{ok: false, host: host, error: to_string(reason)}}
  end

  defp trim(val) when is_binary(val) do
    case String.trim(val) do
      "" -> nil
      s -> s
    end
  end

  defp trim(_), do: nil

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, _key, ""), do: map
  defp maybe_put(map, key, val), do: Map.put(map, key, val)

  defp stringify_keys(map) when is_map(map) do
    Map.new(map, fn
      {k, v} when is_atom(k) -> {Atom.to_string(k), v}
      {k, v} -> {k, v}
    end)
  end
end
