defmodule Shuttle.TailnetDial do
  @moduledoc """
  Private per-remote HTTPS bridges over tailscaled's LocalAPI unix socket.

  Each URL remote gets an owner-only unix listener in the daemon's
  `<data_dir>/sock` directory. When the daemon uses its default Unix listener,
  that socket shares the same `0700` directory. The bridge accepts only local
  `:httpc` traffic and carries it through a verified TLS connection opened by
  this process over the configured LocalAPI socket.
  """

  use Supervisor
  require Logger

  @table __MODULE__.Table
  @dynamic_supervisor Shuttle.TailnetDial.DynamicSupervisor

  def start_link(opts \\ []) do
    Supervisor.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(opts) do
    children = [
      {DynamicSupervisor, strategy: :one_for_one, name: @dynamic_supervisor},
      {Shuttle.TailnetDial.Reconciler, opts}
    ]

    Supervisor.init(children, strategy: :one_for_all)
  end

  @doc false
  def status do
    GenServer.call(Shuttle.TailnetDial.Reconciler, :status, 1_000)
  catch
    :exit, _ ->
      socket = Shuttle.Remotes.tailscale_socket()
      %{configured: Shuttle.Remotes.tailscale_socket_configured?(), socket: socket, bridges: []}
  end

  @doc "Returns the dial bridge socket for a unique URL host, or nil when absent or ambiguous."
  @spec socket_for(String.t()) :: String.t() | nil
  def socket_for(host) do
    case :ets.match_object(@table, {{:socket, host, :_}, :_}) do
      [{{:socket, ^host, _port}, path}] -> path
      _ -> nil
    end
  rescue
    ArgumentError -> nil
  end

  @doc false
  @spec socket_for(String.t(), pos_integer()) :: String.t() | nil
  def socket_for(host, port) do
    case :ets.lookup(@table, {:socket, host, port}) do
      [{{:socket, ^host, ^port}, path}] -> path
      _ -> nil
    end
  rescue
    ArgumentError -> nil
  end

  @doc false
  @spec bridge_pid(String.t()) :: pid() | nil
  def bridge_pid(remote_name) do
    case :ets.lookup(@table, {:bridge, remote_name}) do
      [{{:bridge, ^remote_name}, pid}] -> pid
      _ -> nil
    end
  rescue
    ArgumentError -> nil
  end

  @doc false
  @spec remote_for(String.t(), pos_integer()) :: String.t() | nil
  def remote_for(host, port) do
    case :ets.lookup(@table, {:remote, host, port}) do
      [{{:remote, ^host, ^port}, name}] -> name
      _ -> nil
    end
  rescue
    ArgumentError -> nil
  end

  @doc false
  @spec last_error(String.t()) :: {:tailnet_dial, atom(), term()} | nil
  def last_error(remote_name) do
    case :ets.lookup(@table, {:error, remote_name}) do
      [{{:error, ^remote_name}, {stage, reason}}] -> {:tailnet_dial, stage, reason}
      _ -> nil
    end
  rescue
    ArgumentError -> nil
  end

  @doc false
  def register_bridge(host, port, remote_name, path) do
    :ets.insert(@table, [
      {{:socket, host, port}, path},
      {{:remote, host, port}, remote_name},
      {{:bridge, remote_name}, self()}
    ])

    clear_error(remote_name)
  rescue
    ArgumentError -> :ok
  end

  @doc false
  def unregister_bridge(remote_name, host, port) do
    case :ets.lookup(@table, {:remote, host, port}) do
      [{{:remote, ^host, ^port}, ^remote_name}] ->
        :ets.delete(@table, {:socket, host, port})
        :ets.delete(@table, {:remote, host, port})

      _ ->
        :ok
    end

    :ets.delete(@table, {:bridge, remote_name})
  rescue
    ArgumentError -> :ok
  end

  @doc false
  def clear_error(remote_name) do
    :ets.delete(@table, {:error, remote_name})
  rescue
    ArgumentError -> :ok
  end

  @doc false
  def record_error(remote_name, stage, reason) do
    :ets.insert(@table, {{:error, remote_name}, {stage, reason}})
    log_error(remote_name, stage, reason)
  rescue
    ArgumentError -> :ok
  end

  @doc false
  def socket_path(remote_name, data_dir \\ Shuttle.data_dir()) do
    Path.join([data_dir, "sock", "dial-#{socket_component(remote_name)}.sock"])
  end

  @doc false
  def profile(remote_name) do
    digest = :crypto.hash(:sha256, remote_name) |> Base.encode16(case: :lower)
    String.to_atom("shuttle_dial_" <> digest)
  end

  defp socket_component(name) when is_binary(name) do
    if byte_size(name) <= 64 and Regex.match?(~r/\A[A-Za-z0-9._-]+\z/, name) do
      "name-" <> name
    else
      digest = :crypto.hash(:sha256, name) |> Base.encode16(case: :lower) |> binary_part(0, 16)
      "hash-" <> digest
    end
  end

  defp log_error(remote_name, stage, reason) do
    now = System.monotonic_time(:millisecond)
    key = {:log, remote_name, stage}

    should_log? =
      case :ets.lookup(@table, key) do
        [{^key, last}] when now - last < 30_000 ->
          false

        _ ->
          :ets.insert(@table, {key, now})
          true
      end

    if should_log? do
      Logger.warning(
        "TailnetDial: remote #{remote_name} failed at #{stage}: #{format_reason(reason)}"
      )
    end
  rescue
    ArgumentError -> :ok
  end

  defp format_reason(reason), do: inspect(reason)
end
