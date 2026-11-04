defmodule Shuttle.Opener do
  @moduledoc "Open a conversation on this host's display, wherever its terminal runs."

  alias Shuttle.{Env, Kitty, OpenTrace, OriginRouter, Remote, Terminal}
  alias Shuttle.Terminal.Rex

  @spec open(String.t(), String.t() | nil) :: :ok | {:error, String.t()}
  def open(name, host \\ nil)

  def open(name, host) when is_binary(name) and name != "" do
    OpenTrace.run(name, host, fn -> open_routed(name, host) end)
  end

  def open(_, _), do: {:error, "tmux_session is required"}

  defp open_routed(name, host) do
    case OpenTrace.step(:route, fn -> OriginRouter.route_host(host) end) do
      :local ->
        open_local(name)

      {:remote, remote} ->
        open_remote(name, host, remote)

      {:error, {:unknown_origin, origin}} ->
        {:error, OriginRouter.unknown_origin_message(origin)}
    end
  end

  defp open_local(name) do
    if Terminal.primary() == Rex do
      runner = Env.app(:rex_runner, Shuttle.Runner.Default)

      case OpenTrace.step(:locate, fn -> Terminal.locate_target(runner, name) end) do
        {Rex, binding} ->
          case Rex.reveal_binding(runner, binding) do
            {:error, :no_app_client} -> {:error, "No Rex app client is attached to this server"}
            result -> result
          end

        {Terminal.Tmux, _} ->
          Rex.reveal_tmux(name, nil, nil, fiber: Shuttle.Terminal.RexTree.fiber_for(name))

        nil ->
          {:error, "Cannot locate terminal #{name}; it is absent or unobservable"}
      end
    else
      OpenTrace.step(:kitty, fn -> kitty().open(name, nil) end)
    end
  end

  defp open_remote(name, host, remote) do
    if Terminal.primary() == Rex do
      case OpenTrace.step(:remote_backend, fn -> remote_backend(remote) end) do
        {:ok, "rex"} ->
          reveal_remote_rex(name, remote)

        {:ok, "tmux"} ->
          with {:ok, destination} <-
                 OpenTrace.step(:ssh_destination, fn -> Kitty.ssh_destination(host) end) do
            fiber = OpenTrace.step(:remote_fiber, fn -> remote_fiber(name, remote) end)

            OpenTrace.step(:viewer, fn ->
              Rex.reveal_tmux(name, host, destination, fiber: fiber)
            end)
          end

        error ->
          error
      end
    else
      OpenTrace.step(:kitty, fn -> kitty().open(name, host) end)
    end
  end

  # A daemon without the terminal field uses tmux. An unavailable or malformed
  # version is not evidence that an ssh/tmux viewer can reach the worker.
  defp remote_backend(remote) do
    client = Env.app(:opener_http_client, Shuttle.RemoteRegistry.Client.Default)

    with {:ok, body} <-
           client.get(Remote.url_for(remote, "/api/v1/version"), remote.request_timeout_ms),
         {:ok, version} when is_map(version) <- Jason.decode(body) do
      case Map.get(version, "terminal", "tmux") do
        backend when backend in ["tmux", "rex"] -> {:ok, backend}
        _ -> {:error, "#{remote.name} reports an unsupported terminal backend"}
      end
    else
      _ ->
        {:error,
         "Cannot determine #{remote.name}'s terminal backend; its daemon could not be reached or returned an invalid version"}
    end
  end

  @doc "Reveal a Rex worker on its owner, without routing through the display hub."
  def reveal_owned_rex(name) do
    runner = Env.app(:rex_runner, Shuttle.Runner.Default)

    case Rex.locate(runner, name) do
      {:ok, binding} -> Rex.reveal_binding(runner, binding)
      _ -> {:error, "Cannot locate terminal #{name}; it is absent or unobservable"}
    end
  end

  defp reveal_remote_rex(name, remote) do
    case OriginRouter.forward(remote, "/api/v1/terminal/reveal", %{"name" => name}) do
      {:forwarded, 200, _} ->
        case Rex.activate_app(Env.app(:rex_runner, Shuttle.Runner.Default)) do
          :ok -> :ok
          {:error, reason} -> {:error, "Cannot activate Rex app: #{inspect(reason)}"}
        end

      {:forwarded, _, body} ->
        case Jason.decode(body) do
          {:ok, %{"code" => "no_app_client"}} ->
            address =
              %URI{scheme: "http", host: URI.parse(remote.url).host, port: 7297}
              |> URI.to_string()

            {:error,
             "No Rex app client is attached to #{remote.name}. Choose Add Remote Host… in the Rex app and enter #{address}"}

          {:ok, %{"error" => message}} when is_binary(message) ->
            {:error, "#{remote.name}: #{message}"}

          _ ->
            {:error, "#{remote.name} could not reveal the Rex worker"}
        end

      {:error, _} ->
        {:error, "#{remote.name} could not be reached to reveal the Rex worker"}
    end
  end

  defp remote_fiber(name, remote) do
    client = Env.app(:opener_http_client, Shuttle.RemoteRegistry.Client.Default)

    with {:ok, body} <- client.get(Remote.sessions_url(remote), remote.request_timeout_ms),
         {:ok, %{"records" => records}} when is_list(records) <- Jason.decode(body) do
      Shuttle.Terminal.RexTree.fiber_for(name, records)
    else
      # Missing presentation metadata does not prevent opening a known terminal.
      _ -> nil
    end
  end

  defp kitty, do: Env.app(:kitty_impl, Kitty)
end
