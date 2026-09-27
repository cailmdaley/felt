defmodule Shuttle.TailnetDial.Reconciler do
  @moduledoc false

  use GenServer
  alias Shuttle.Remote
  alias Shuttle.TailnetDial.Bridge

  @table Shuttle.TailnetDial.Table
  @dynamic_supervisor Shuttle.TailnetDial.DynamicSupervisor
  @refresh_interval_ms 1_000

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(opts) do
    :ets.new(@table, [
      :named_table,
      :public,
      :set,
      read_concurrency: true,
      write_concurrency: true
    ])

    data_dir = Keyword.get(opts, :data_dir, Shuttle.data_dir())
    {remotes, socket} = configured_inputs(opts)
    desired = bridge_specs(remotes, socket, data_dir)
    bridges = reconcile(desired, %{})

    state = %{
      options: opts,
      data_dir: data_dir,
      desired: desired,
      bridges: bridges,
      tailscale_socket: socket,
      token: Shuttle.Remotes.config_token(),
      refresh?: Keyword.get(opts, :refresh?, true)
    }

    if state.refresh?, do: Process.send_after(self(), :refresh, @refresh_interval_ms)
    {:ok, state}
  end

  @impl true
  def handle_call(:status, _from, state) do
    bridges =
      Enum.map(state.desired, fn {name, spec} ->
        error = Shuttle.TailnetDial.last_error(name)
        pid = Shuttle.TailnetDial.bridge_pid(name)

        ready? =
          is_pid(pid) and Process.alive?(pid) and
            Shuttle.TailnetDial.socket_for(spec.host, spec.port) == spec.path

        {stage, reason} =
          case error do
            {:tailnet_dial, stage, reason} -> {stage, reason}
            _ -> {nil, nil}
          end

        %{
          name: name,
          host: spec.host,
          port: spec.port,
          socket: spec.path,
          status:
            cond do
              error -> "error"
              ready? -> "ready"
              true -> "starting"
            end,
          error_stage: if(stage, do: Atom.to_string(stage)),
          error: if(reason, do: inspect(reason))
        }
      end)

    {:reply,
     %{
       configured: Shuttle.Remotes.tailscale_socket_configured?(),
       socket: state.tailscale_socket,
       bridges: bridges
     }, state}
  end

  @impl true
  def handle_info(:refresh, state) do
    token = Shuttle.Remotes.config_token()

    {desired, socket, token} =
      if token == state.token do
        {state.desired, state.tailscale_socket, token}
      else
        {remotes, socket} = configured_inputs(state.options)
        {bridge_specs(remotes, socket, state.data_dir), socket, token}
      end

    bridges = reconcile(desired, state.bridges)
    Process.send_after(self(), :refresh, @refresh_interval_ms)

    {:noreply,
     %{state | desired: desired, bridges: bridges, tailscale_socket: socket, token: token}}
  end

  defp configured_inputs(opts) do
    remotes = Keyword.get(opts, :remotes, Shuttle.Remotes.configured())
    socket = Keyword.get(opts, :tailscale_socket, Shuttle.Remotes.tailscale_socket())
    {remotes, socket}
  end

  defp bridge_specs(remotes, socket, data_dir) when is_binary(socket) and socket != "" do
    remotes
    |> Enum.filter(& &1.enabled)
    |> Enum.flat_map(fn %Remote{} = remote ->
      case URI.parse(remote.url) do
        %URI{scheme: scheme, host: host} = uri
        when is_binary(scheme) and is_binary(host) and host != "" ->
          if String.downcase(scheme) == "https" do
            host = String.downcase(host)
            port = uri.port || 443
            path = Shuttle.TailnetDial.socket_path(remote.name, data_dir)

            [
              {remote.name,
               %{host: host, port: port, url: remote.url, localapi_socket: socket, path: path}}
            ]
          else
            []
          end

        _ ->
          []
      end
    end)
    |> Map.new()
  end

  defp bridge_specs(_remotes, _socket, _data_dir), do: %{}

  defp reconcile(desired, current) do
    current = live_bridges(current)

    current =
      Enum.reduce(current, %{}, fn {name, %{pid: pid, spec: old_spec}}, acc ->
        case Map.get(desired, name) do
          ^old_spec ->
            Map.put(acc, name, %{pid: pid, spec: old_spec})

          _ when is_pid(pid) ->
            Shuttle.TailnetDial.unregister_bridge(old_spec.host, old_spec.port)
            Shuttle.TailnetDial.clear_error(name)
            DynamicSupervisor.terminate_child(@dynamic_supervisor, pid)
            acc

          _ ->
            Shuttle.TailnetDial.unregister_bridge(old_spec.host, old_spec.port)
            Shuttle.TailnetDial.clear_error(name)
            acc
        end
      end)

    Enum.reduce(desired, current, fn {name, spec}, acc ->
      if Map.has_key?(acc, name) do
        acc
      else
        child_opts = spec |> Map.to_list() |> Keyword.put(:name, name)

        case DynamicSupervisor.start_child(@dynamic_supervisor, {Bridge, child_opts}) do
          {:ok, pid} ->
            Map.put(acc, name, %{pid: pid, spec: spec})

          {:error, reason} ->
            Shuttle.TailnetDial.record_error(name, :listen, reason)
            acc
        end
      end
    end)
  end

  defp live_bridges(previous) do
    Map.new(previous, fn {name, %{spec: spec}} ->
      pid = Shuttle.TailnetDial.bridge_pid(name)
      {name, %{pid: if(is_pid(pid) and Process.alive?(pid), do: pid), spec: spec}}
    end)
  end
end
