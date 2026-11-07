defmodule Shuttle.RecorderRouter do
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

      params["source"] == "phone" ->
        prefer_phone(opts)

      true ->
        addressed(params["origin"], opts)
    end
  end

  @doc "The host that speaks: an addressed recorder, else this host, else the first remote that can."
  def select_speaker(params, opts \\ []) do
    cond do
      params["recorder"] not in [nil, ""] ->
        select(params, opts)

      Keyword.get_lazy(opts, :speaks, &Shuttle.Speaker.available?/0) ->
        {:ok, :local}

      true ->
        # Addressed, so a host that cannot speak answers for itself instead
        # of forwarding the probe on to one that can.
        case probe(
               opts,
               &("/api/v1/speak?recorder=" <> URI.encode_www_form(&1.name)),
               &match?(%{"available" => true}, &1)
             ) do
          nil -> {:error, "no host can speak: none has afplay"}
          remote -> {:ok, {:remote, remote}}
        end
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
    case probe(opts, &("/api/v1/voice?recorder=" <> URI.encode_www_form(&1.name)), fn
           %{"available" => true, "sources" => sources} when is_list(sources) ->
             "desktop" in sources

           _ ->
             false
         end) do
      nil -> {:ok, :local}
      remote -> {:ok, {:remote, remote}}
    end
  end

  # The first remote, by name, whose answer at `path` satisfies `accept`.
  defp probe(opts, path, accept) do
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
              do: client.get(Remote.url_for(remote, url_path(path, remote)), remaining),
              else: {:error, :probe_deadline}

          case response do
            {:ok, body} ->
              case Jason.decode(body) do
                {:ok, answer} -> if accept.(answer), do: remote
                _ -> nil
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

    Enum.find_value(results, fn
      {:ok, %Remote{} = remote} -> remote
      _ -> nil
    end)
  end

  defp url_path(path, remote) when is_function(path, 1), do: path.(remote)
  defp url_path(path, _remote), do: path

  def stamp(body, recorder \\ own_host()), do: Map.put(body, "recorder", recorder)

  def forward_read(remote, path) do
    case OriginRouter.forward_client().get_file(Remote.url_for(remote, path), 2_000) do
      {:ok, status, _type, body} ->
        {status, stamp(decode(body), remote.name)}

      {:error, reason} ->
        {502, %{recorder: remote.name, error: "cannot inspect recorder: #{inspect(reason)}"}}
    end
  end

  def forward_control(remote, path, params) do
    payload = params |> Map.put("recorder", remote.name) |> Map.put("recorder_forwarded", true)

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
           error: "recorder control was not confirmed; inspect this recorder: #{inspect(reason)}"
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
