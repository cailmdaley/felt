defmodule Shuttle.Opener do
  @moduledoc "Open a conversation on this host's display, wherever its terminal runs."

  alias Shuttle.{Env, Kitty, OpenTrace, OriginRouter, Remote, Terminal}
  alias Shuttle.Terminal.Rex

  @doc """
  Open a conversation's terminal and bring it forward: a Rex display selects the
  worker's window, creating a viewer for a tmux worker, and activates the app;
  a kitty display opens a tab. A Rex terminal that is gone, here or on its
  owner, answers `{:error, {:absent, name}}`.
  """

  @doc "The words for a terminal that is gone."
  def absent_message(name), do: "Cannot locate terminal #{name}; it is absent or unobservable"

  @spec open(String.t(), String.t() | nil) :: :ok | {:error, String.t() | {:absent, String.t()}}
  def open(name, host \\ nil)

  def open(name, host) when is_binary(name) and name != "" do
    OpenTrace.run(name, host, fn ->
      routed(host, fn -> open_local(name) end, &open_remote(name, host, &1))
    end)
  end

  def open(_, _), do: {:error, "tmux_session is required"}

  @doc """
  Move a Rex display to a conversation's window and leave the app where it
  stands. A worker hidden from the view (`Shuttle.RexView`) gets its own window
  back; nothing else is created: no viewer, session or program, and no app
  launch, so a conversation without a terminal, or a kitty display, stays as it
  is. `{:ok, true}` when the display moved.
  """
  @spec select(String.t(), String.t() | nil) :: {:ok, boolean()} | {:error, String.t()}
  def select(name, host \\ nil)

  def select(name, host) when is_binary(name) and name != "" do
    OpenTrace.run(name, host, fn ->
      if Terminal.primary() == Rex,
        do: routed(host, fn -> select_local(name) end, &select_remote(name, host, &1)),
        else: {:ok, false}
    end)
  end

  def select(_, _), do: {:error, "tmux_session is required"}

  defp routed(host, local, remote) do
    case OpenTrace.step(:route, fn -> OriginRouter.route_host(host) end) do
      :local -> local.()
      {:remote, r} -> remote.(r)
      {:error, {:unknown_origin, origin}} -> {:error, OriginRouter.unknown_origin_message(origin)}
    end
  end

  defp select_local(name) do
    runner = runner()

    case OpenTrace.step(:locate, fn -> Terminal.locate_target(runner, name) end) do
      {Rex, binding} -> Rex.select_binding(runner, binding)
      {Terminal.Tmux, _} -> Rex.select_viewer(runner, name <> "@tmux")
      nil -> {:ok, false}
    end
  end

  defp select_remote(name, host, remote) do
    case OpenTrace.step(:remote_backend, fn -> remote_backend(remote) end) do
      {:ok, "rex"} ->
        case OriginRouter.forward(remote, "/api/v1/terminal/reveal", %{
               "name" => name,
               "select_only" => true
             }) do
          {:forwarded, 200, body} ->
            case Jason.decode(body) do
              {:ok, %{"revealed" => moved}} when is_boolean(moved) ->
                {:ok, moved}

              _ ->
                {:error, "#{remote.name} answered the selection without saying whether it moved"}
            end

          reply ->
            reveal_error(reply, remote)
        end

      {:ok, "tmux"} ->
        Rex.select_viewer(runner(), name <> "@" <> host)

      error ->
        error
    end
  end

  defp open_local(name) do
    if Terminal.primary() == Rex do
      runner = runner()

      case OpenTrace.step(:locate, fn -> Terminal.locate_target(runner, name) end) do
        {Rex, binding} ->
          case Rex.reveal_binding(runner, binding) do
            {:error, :no_app_client} -> {:error, "No Rex app client is attached to this server"}
            result -> result
          end

        {Terminal.Tmux, _} ->
          Rex.reveal_tmux(name, nil, nil, fiber: Shuttle.Terminal.RexTree.fiber_for(name))

        nil ->
          {:error, {:absent, name}}
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

  @doc """
  Select a Rex worker on its owner, without routing through the display hub.
  The hub, which holds the display, decides whether to activate its app.
  With `select_only: true` it launches no app, and answers `{:ok, moved}`.
  """
  def reveal_owned_rex(name, opts \\ []) do
    runner = runner()

    case {Rex.locate(runner, name), opts[:select_only]} do
      {{:ok, binding}, true} -> Rex.select_binding(runner, binding)
      {{:ok, binding}, _} -> Rex.reveal_binding(runner, binding, quiet: true)
      {_, true} -> {:ok, false}
      _ -> {:error, {:absent, name}}
    end
  end

  defp reveal_remote_rex(name, remote) do
    case OriginRouter.forward(remote, "/api/v1/terminal/reveal", %{"name" => name}) do
      {:forwarded, 200, _} ->
        case Rex.activate_app(runner()) do
          :ok -> :ok
          {:error, reason} -> {:error, "Cannot activate Rex app: #{inspect(reason)}"}
        end

      reply ->
        reveal_error(reply, remote)
    end
  end

  defp reveal_error({:forwarded, _, body}, remote) do
    case Jason.decode(body) do
      {:ok, %{"code" => "no_app_client"}} ->
        address =
          %URI{scheme: "http", host: URI.parse(remote.url).host, port: 7297}
          |> URI.to_string()

        {:error,
         "No Rex app client is attached to #{remote.name}. Choose Add Remote Host… in the Rex app and enter #{address}"}

      {:ok, %{"code" => "absent", "name" => name}} when is_binary(name) ->
        {:error, {:absent, name}}

      {:ok, %{"error" => message}} when is_binary(message) ->
        {:error, "#{remote.name}: #{message}"}

      _ ->
        {:error, "#{remote.name} could not reveal the Rex worker"}
    end
  end

  defp reveal_error({:error, _}, remote),
    do: {:error, "#{remote.name} could not be reached to reveal the Rex worker"}

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
  defp runner, do: Env.app(:rex_runner, Shuttle.Runner.Default)
end
