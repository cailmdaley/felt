defmodule Shuttle.MeetingRouter do
  @moduledoc """
  Selects the recording host independently of the agent's owner. Phone requests
  prefer a reachable device-capable recorder; explicit recorder addresses pin
  all subsequent requests. Selection only reads capability, never starts audio.
  """
  alias Shuttle.{OriginRouter, Poller, RegistryCommon, Remote}

  @probe_ms 800
  @max_probes 16

  def own_host, do: Poller.own_host_id()

  def select(params, opts \\ []) do
    own = Keyword.get(opts, :own_host_id, own_host())
    recorder = params["recorder"]

    cond do
      params["recorder_forwarded"] == true and recorder != own ->
        {:error, "forwarded recorder request does not name this host"}

      recorder not in [nil, ""] ->
        addressed(recorder, opts)

      params["prefer"] == "phone" or get_in(params, ["meeting", "mode"]) == "phone" ->
        prefer_phone(opts)

      true ->
        addressed(params["origin"], opts)
    end
  end

  # Non-phone starts record here, even when the agent lives on another host.
  def select_start(params, opts \\ []) do
    select(Map.delete(params, "origin"), opts)
  end

  defp addressed(host, opts) do
    case OriginRouter.route_host(host, opts) do
      {:error, {:unknown_origin, name}} ->
        {:error, OriginRouter.unknown_origin_message(name, opts)}

      route ->
        {:ok, route}
    end
  end

  defp prefer_phone(opts) do
    client = Keyword.get(opts, :client, OriginRouter.forward_client())
    timeout = Keyword.get(opts, :probe_ms, @probe_ms)
    own = Keyword.get(opts, :own_host_id, own_host())

    remotes =
      opts
      |> RegistryCommon.configured_remotes()
      |> Enum.reject(&(&1.name == own))
      |> Enum.sort_by(& &1.name)

    deadline = System.monotonic_time(:millisecond) + timeout

    results =
      Task.Supervisor.async_stream_nolink(
        Shuttle.TaskSupervisor,
        remotes,
        fn remote ->
          remaining = deadline - System.monotonic_time(:millisecond)

          response =
            if remaining > 0,
              do: client.get(Remote.url_for(remote, "/api/v1/meeting"), remaining),
              else: {:error, :probe_deadline}

          case response do
            {:ok, body} ->
              case Jason.decode(body) do
                {:ok, %{"available" => true, "modes" => modes}} when is_list(modes) ->
                  if Enum.all?(~w(room call), &(&1 in modes)), do: remote, else: nil

                _ ->
                  nil
              end

            _ ->
              nil
          end
        end,
        max_concurrency: @max_probes,
        timeout: timeout + 100,
        on_timeout: :kill_task,
        ordered: true
      )
      |> Enum.to_list()

    case Enum.find_value(results, fn
           {:ok, %Remote{} = remote} -> remote
           _ -> nil
         end) do
      nil -> {:ok, :local}
      remote -> {:ok, {:remote, remote}}
    end
  end

  def normalize_origin(origin) when origin in [nil, "", "local"], do: own_host()
  def normalize_origin(origin), do: origin

  def stamp(body, recorder \\ own_host()) when is_map(body) do
    body = Map.put(body, "recorder", recorder)
    key = if Map.has_key?(body, :meeting), do: :meeting, else: "meeting"

    case Map.get(body, key) do
      row when is_map(row) -> Map.put(body, key, Map.put(row, "recorder", recorder))
      _ -> body
    end
  end

  def forward_start(remote, path, params) do
    payload =
      params
      |> Map.put("origin", normalize_origin(params["origin"]))
      |> Map.put("recorder", remote.name)
      |> Map.put("recorder_forwarded", true)

    # A POST transport failure is ambiguous: the recorder may have started.
    # Never retry it and never select another recorder after this call.
    client = OriginRouter.forward_client()
    Code.ensure_loaded?(client)
    post = if function_exported?(client, :post_once, 4), do: :post_once, else: :post

    case apply(client, post, [
           Remote.url_for(remote, path),
           Jason.encode!(payload),
           "application/json",
           OriginRouter.default_forward_timeout_ms()
         ]) do
      {:ok, status, body} ->
        {status, stamp(decode(body), remote.name)}

      {:error, reason} ->
        {502,
         %{
           recorder: remote.name,
           recording_unknown: true,
           error:
             "Recorder #{remote.name} did not confirm the start (#{inspect(reason)}). Inspect that recorder before retrying; it may already be recording."
         }}
    end
  end

  def forward_read(remote) do
    case OriginRouter.forward_client().get_file(Remote.url_for(remote, "/api/v1/meeting"), 2_000) do
      {:ok, status, _type, body} ->
        {status, stamp(decode(body), remote.name)}

      {:error, reason} ->
        {502, %{recorder: remote.name, error: "cannot inspect recorder: #{inspect(reason)}"}}
    end
  end

  def forward_stop(remote, params) do
    payload = params |> Map.put("recorder", remote.name) |> Map.put("recorder_forwarded", true)

    case OriginRouter.forward_client().post(
           Remote.url_for(remote, "/api/v1/meeting/stop"),
           Jason.encode!(payload),
           "application/json",
           OriginRouter.default_forward_timeout_ms()
         ) do
      {:ok, status, body} ->
        {status, stamp(decode(body), remote.name)}

      {:error, reason} ->
        {502,
         %{
           recorder: remote.name,
           error: "stop was not confirmed; inspect this recorder: #{inspect(reason)}"
         }}
    end
  end

  defp decode(body) do
    case Jason.decode(body) do
      {:ok, map} when is_map(map) -> map
      _ -> %{"error" => body}
    end
  end
end
