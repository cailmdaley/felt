defmodule Shuttle.Opener do
  @moduledoc "Open a conversation on this host's display, wherever its terminal runs."

  alias Shuttle.{Env, Kitty, OriginRouter, Remote, Terminal}
  alias Shuttle.Terminal.Rex

  @spec open(String.t(), String.t() | nil) :: :ok | {:error, String.t()}
  def open(name, host \\ nil)

  def open(name, host) when is_binary(name) and name != "" do
    case OriginRouter.route_host(host) do
      :local ->
        open_local(name)

      {:remote, remote} ->
        open_remote(name, host, remote)

      {:error, {:unknown_origin, origin}} ->
        {:error, OriginRouter.unknown_origin_message(origin)}
    end
  end

  def open(_, _), do: {:error, "tmux_session is required"}

  defp open_local(name) do
    if Terminal.primary() == Rex do
      runner = Env.app(:rex_runner, Shuttle.Runner.Default)

      case Terminal.locate(runner, name) do
        Rex ->
          Rex.reveal(name, nil)

        Terminal.Tmux ->
          Rex.reveal_tmux(name, nil, nil, fiber: Shuttle.Terminal.RexTree.fiber_for(name))

        nil ->
          {:error, "Cannot locate terminal #{name}; it is absent or unobservable"}
      end
    else
      kitty().open(name, nil)
    end
  end

  defp open_remote(name, host, remote) do
    if Terminal.primary() == Rex do
      with :ok <- remote_tmux(remote),
           {:ok, destination} <- Kitty.ssh_destination(host) do
        Rex.reveal_tmux(name, host, destination, fiber: remote_fiber(name, remote))
      end
    else
      kitty().open(name, host)
    end
  end

  # A daemon without the terminal field uses tmux. An unavailable or malformed
  # version is not evidence that an ssh/tmux viewer can reach the worker.
  defp remote_tmux(remote) do
    client = Env.app(:opener_http_client, Shuttle.RemoteRegistry.Client.Default)

    with {:ok, body} <-
           client.get(Remote.url_for(remote, "/api/v1/version"), remote.request_timeout_ms),
         {:ok, version} when is_map(version) <- Jason.decode(body) do
      case Map.get(version, "terminal", "tmux") do
        "tmux" -> :ok
        "rex" -> {:error, "opening a worker on a remote Rex server is not supported yet"}
        _ -> {:error, "#{remote.name} reports an unsupported terminal backend"}
      end
    else
      _ ->
        {:error,
         "Cannot determine #{remote.name}'s terminal backend; its daemon could not be reached or returned an invalid version"}
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
