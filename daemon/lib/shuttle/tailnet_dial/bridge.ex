defmodule Shuttle.TailnetDial.Bridge do
  @moduledoc false

  use GenServer

  @connect_timeout_ms 5_000
  @drain_timeout_ms 5_000
  @socket_options [:binary, active: false, packet: :http_bin]

  def child_spec(opts) do
    %{
      id: {__MODULE__, Keyword.fetch!(opts, :name)},
      start: {__MODULE__, :start_link, [opts]},
      restart: :permanent,
      shutdown: 1_000,
      type: :worker
    }
  end

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts)
  end

  @impl true
  def init(opts) do
    # Trap supervisor shutdown so terminate/2 can remove the private socket path.
    Process.flag(:trap_exit, true)
    path = opts |> Keyword.fetch!(:path) |> Shuttle.Host.prepare_unix_socket!()
    bytes = byte_size(path)
    limit = unix_socket_path_limit()

    if bytes >= limit do
      {:stop, {:socket_path_too_long, bytes, limit}}
    else
      start_listener(path, opts)
    end
  rescue
    error in [ArgumentError] -> {:stop, error}
  end

  defp start_listener(path, opts) do
    case :gen_tcp.listen(0, [
           :binary,
           active: false,
           packet: :raw,
           ifaddr: {:local, path},
           backlog: 128
         ]) do
      {:ok, listener} ->
        :ok = Shuttle.Host.restrict_bound_socket!(path)
        owner = self()

        {acceptor, acceptor_monitor} =
          spawn_monitor(fn -> accept_loop(listener, Keyword.put(opts, :owner, owner)) end)

        name = Keyword.fetch!(opts, :name)
        host = Keyword.fetch!(opts, :host)
        port = Keyword.fetch!(opts, :port)
        Shuttle.TailnetDial.register_bridge(host, port, name, path)

        {:ok,
         %{
           listener: listener,
           acceptor: acceptor,
           acceptor_monitor: acceptor_monitor,
           path: path,
           host: host,
           port: port
         }}

      {:error, reason} ->
        {:stop, {:listen_failed, reason}}
    end
  end

  defp unix_socket_path_limit do
    case :os.type() do
      {:unix, :darwin} -> 104
      {:unix, :linux} -> 108
      _ -> 104
    end
  end

  @impl true
  def handle_info({:tailnet_accept_error, reason}, state) do
    {:stop, {:accept_failed, reason}, state}
  end

  # Closed probe sockets owned by this process send normal port-exit messages.
  def handle_info({:EXIT, _from, :normal}, state), do: {:noreply, state}
  def handle_info({:EXIT, _from, reason}, state), do: {:stop, {:linked_exit, reason}, state}

  def handle_info({:DOWN, monitor, :process, _pid, reason}, %{acceptor_monitor: monitor} = state) do
    {:stop, {:acceptor_down, reason}, state}
  end

  @impl true
  def terminate(
        _reason,
        %{
          listener: listener,
          acceptor: acceptor,
          acceptor_monitor: monitor,
          path: path,
          host: host,
          port: port
        }
      ) do
    Process.exit(acceptor, :shutdown)
    Process.demonitor(monitor, [:flush])
    :gen_tcp.close(listener)
    Shuttle.TailnetDial.unregister_bridge(host, port)
    File.rm(path)
    :ok
  end

  defp accept_loop(listener, opts) do
    case :gen_tcp.accept(listener) do
      {:ok, client} ->
        start_connection(client, opts)
        accept_loop(listener, opts)

      {:error, :closed} ->
        :ok

      {:error, reason} ->
        send(Keyword.fetch!(opts, :owner), {:tailnet_accept_error, reason})
    end
  end

  defp start_connection(client, opts) do
    case Task.Supervisor.start_child(Shuttle.TaskSupervisor, fn ->
           receive do
             :tailnet_socket_ready -> handle_connection(client, opts)
           end
         end) do
      {:ok, pid} ->
        case :gen_tcp.controlling_process(client, pid) do
          :ok ->
            send(pid, :tailnet_socket_ready)

          {:error, _reason} ->
            :gen_tcp.close(client)
            Process.exit(pid, :kill)
        end

      {:error, _reason} ->
        :gen_tcp.close(client)
    end
  end

  defp handle_connection(client, opts) do
    name = Keyword.fetch!(opts, :name)

    case dial(opts) do
      {:ok, tls_socket} ->
        Shuttle.TailnetDial.clear_error(name)

        try do
          case pump(client, tls_socket, Keyword.fetch!(opts, :request_timeout_ms)) do
            :ok -> :ok
            {:error, reason} -> Shuttle.TailnetDial.record_error(name, :relay, reason)
          end
        after
          :ssl.close(tls_socket)
        end

      {:error, stage, reason} ->
        Shuttle.TailnetDial.record_error(name, stage, reason)
    end
  rescue
    error ->
      Shuttle.TailnetDial.record_error(
        Keyword.fetch!(opts, :name),
        :connection,
        Exception.message(error)
      )
  catch
    kind, reason ->
      Shuttle.TailnetDial.record_error(Keyword.fetch!(opts, :name), :connection, {kind, reason})
  after
    :gen_tcp.close(client)
  end

  defp dial(opts) do
    localapi_socket = Keyword.fetch!(opts, :localapi_socket)

    case :gen_tcp.connect({:local, localapi_socket}, 0, @socket_options, @connect_timeout_ms) do
      {:ok, socket} ->
        dial_tls(socket, opts)

      {:error, reason} ->
        {:error, :localapi_connect, reason}
    end
  end

  defp dial_tls(socket, opts) do
    request = dial_request(Keyword.fetch!(opts, :host), Keyword.fetch!(opts, :port))

    with :ok <- :gen_tcp.send(socket, request),
         {:ok, response} <- read_response(socket),
         :ok <- accept_upgrade(socket, response),
         {:ok, tls_socket} <- upgrade_tls(socket, Keyword.fetch!(opts, :host)) do
      {:ok, tls_socket}
    else
      {:error, :localapi_status, reason} ->
        :gen_tcp.close(socket)
        {:error, :localapi_status, reason}

      {:error, stage, reason} ->
        :gen_tcp.close(socket)
        {:error, stage, reason}

      {:error, reason} ->
        :gen_tcp.close(socket)
        {:error, :localapi, reason}
    end
  end

  defp dial_request(host, port) do
    [
      "POST /localapi/v0/dial HTTP/1.1\r\n",
      "Host: local-tailscaled.sock\r\n",
      "Upgrade: ts-dial\r\n",
      "Connection: upgrade\r\n",
      "Dial-Host: ",
      host,
      "\r\nDial-Port: ",
      Integer.to_string(port),
      "\r\nSec-Tailscale: localapi\r\n",
      "Content-Length: 0\r\n\r\n"
    ]
    |> IO.iodata_to_binary()
  end

  defp read_response(socket) do
    read_response(socket, nil, %{})
  end

  defp read_response(socket, status, headers) do
    case :gen_tcp.recv(socket, 0, @connect_timeout_ms) do
      {:ok, {:http_response, _version, code, reason}} ->
        read_response(socket, {code, to_string(reason)}, headers)

      {:ok, {:http_header, _index, name, _original_name, value}} ->
        read_response(
          socket,
          status,
          Map.put(headers, name |> to_string() |> String.downcase(), to_string(value))
        )

      {:ok, {:http_header, _index, name, value}} ->
        read_response(
          socket,
          status,
          Map.put(headers, name |> to_string() |> String.downcase(), to_string(value))
        )

      {:ok, :http_eoh} ->
        case status do
          {code, phrase} -> {:ok, %{status: code, phrase: phrase, headers: headers}}
          nil -> {:error, :localapi_headers, :missing_status}
        end

      {:ok, {:http_error, reason}} ->
        {:error, :localapi_headers, reason}

      {:error, reason} ->
        {:error, :localapi_headers, reason}
    end
  end

  defp accept_upgrade(socket, %{status: 101, headers: headers}) do
    upgrade = Map.get(headers, "upgrade", "") |> String.split(",") |> Enum.map(&String.trim/1)

    connection =
      headers
      |> Map.get("connection", "")
      |> String.split(",")
      |> Enum.map(&(String.trim(&1) |> String.downcase()))

    if Enum.any?(upgrade, &(String.downcase(&1) == "ts-dial")) and "upgrade" in connection do
      :inet.setopts(socket, packet: :raw)
    else
      {:error, :localapi_upgrade, :invalid_upgrade_headers}
    end
  end

  defp accept_upgrade(socket, %{status: status, phrase: phrase, headers: headers}) do
    with :ok <- :inet.setopts(socket, packet: :raw) do
      body = response_body(socket, headers)
      reason = if body == "", do: phrase, else: body
      {:error, :localapi_status, {:http_status, status, reason}}
    end
  end

  defp response_body(socket, headers) do
    case Integer.parse(Map.get(headers, "content-length", "")) do
      {length, _} when length > 0 ->
        case :gen_tcp.recv(socket, length, @connect_timeout_ms) do
          {:ok, body} -> body
          {:error, _reason} -> ""
        end

      _ ->
        ""
    end
  end

  defp upgrade_tls(socket, host) do
    tls_opts =
      Shuttle.RemoteRegistry.Client.Default.tls_opts()
      |> Keyword.put(:server_name_indication, String.to_charlist(host))
      |> Keyword.put(:active, false)

    case :ssl.connect(socket, tls_opts, @connect_timeout_ms) do
      {:ok, tls_socket} -> {:ok, tls_socket}
      {:error, reason} -> {:error, :tls, reason}
    end
  end

  defp pump(client, tls_socket, request_timeout_ms) do
    with :ok <- :inet.setopts(client, active: :once),
         :ok <- :ssl.setopts(tls_socket, active: :once) do
      pump(client, tls_socket, true, true, 2 * request_timeout_ms)
    end
  end

  defp pump(_client, _tls_socket, false, false, _idle_timeout_ms), do: :ok

  defp pump(client, tls_socket, client_open?, tls_open?, idle_timeout_ms) do
    timeout = if client_open? and tls_open?, do: idle_timeout_ms, else: @drain_timeout_ms

    receive do
      {:tcp, ^client, data} ->
        relay_result(
          :ssl.send(tls_socket, data),
          client,
          tls_socket,
          client_open?,
          tls_open?,
          idle_timeout_ms
        )

      {:ssl, ^tls_socket, data} ->
        relay_result(
          :gen_tcp.send(client, data),
          client,
          tls_socket,
          client_open?,
          tls_open?,
          idle_timeout_ms
        )

      {:tcp_closed, ^client} ->
        _ = :ssl.shutdown(tls_socket, :write)
        pump(client, tls_socket, false, tls_open?, idle_timeout_ms)

      {:ssl_closed, ^tls_socket} ->
        _ = :gen_tcp.shutdown(client, :write)
        pump(client, tls_socket, client_open?, false, idle_timeout_ms)

      {:tcp_error, ^client, reason} ->
        {:error, {:client_tcp, reason}}

      {:ssl_error, ^tls_socket, reason} ->
        {:error, {:peer_tls, reason}}
    after
      timeout -> {:error, if(client_open? and tls_open?, do: :idle_timeout, else: :drain_timeout)}
    end
  end

  defp relay_result(:ok, client, tls_socket, client_open?, tls_open?, idle_timeout_ms) do
    with :ok <- if(client_open?, do: :inet.setopts(client, active: :once), else: :ok),
         :ok <- if(tls_open?, do: :ssl.setopts(tls_socket, active: :once), else: :ok) do
      pump(client, tls_socket, client_open?, tls_open?, idle_timeout_ms)
    end
  end

  defp relay_result(
         {:error, reason},
         _client,
         _tls_socket,
         _client_open?,
         _tls_open?,
         _idle_timeout_ms
       ),
       do: {:error, reason}
end
