defmodule Shuttle.FileAccess.Reader do
  @moduledoc """
  A pull reader whose raw descriptor stays in one leased worker.

  Open and each read have a deadline. Timeout abandons the reply alias and
  requests cleanup, but leaves capacity occupied until native I/O and close
  actually return. Reads are capped at 64 KiB; the request owner sends bytes
  to its socket and supplies backpressure. Owner death also requests cleanup.
  An idle reader retains its slot and descriptor: capacity two means at most
  two concurrent readers, with other I/O failing fast while both are leased.
  """
  alias Shuttle.FileAccess, as: Access
  alias Shuttle.FileAccess.Error
  defstruct [:worker, :server, :lease, :token, :path, :timeout]
  @chunk_size 64 * 1024

  def chunk_size, do: @chunk_size

  def open(path, opts \\ []) do
    if Process.get({Access, :lease}),
      do:
        raise(ArgumentError, "readers must be opened by their consumer, outside an I/O callback")

    owner = self()
    info = Access.service_info(Keyword.get(opts, :service, Shuttle.Env.server(Access)))
    timeout = Keyword.get(opts, :timeout, info.timeout)
    token = make_ref()

    Access.run(
      path,
      fn resolved ->
        monitor = Process.monitor(owner)
        {server, lease} = Process.get({Access, :lease})

        try do
          with {:ok, fd} <-
                 :file.open(
                   Access.native(resolved),
                   [:read, :binary, :raw] ++ Keyword.get(opts, :file_modes, [])
                 ) do
            try do
              Access.permission_proof()

              reader = %__MODULE__{
                worker: self(),
                server: server,
                lease: lease,
                token: token,
                path: path,
                timeout: timeout
              }

              case GenServer.call(server, {:reader_ready, lease, reader}) do
                :ok ->
                  loop(
                    fd,
                    reader,
                    owner,
                    monitor,
                    Keyword.get(opts, :read_fn, &:file.pread/3),
                    {:ok, :closed}
                  )

                :expired ->
                  {:ok, :closed}
              end
            after
              :file.close(fd)
            end
          end
        after
          Process.demonitor(monitor, [:flush])
        end
      end,
      opts
    )
  end

  def read(%__MODULE__{} = reader, offset, length)
      when is_integer(offset) and offset >= 0 and is_integer(length) and length > 0 do
    request(reader, {:pread, offset, min(length, @chunk_size)})
  end

  def read_line(%__MODULE__{} = reader), do: request(reader, :line)

  defp request(reader, operation) do
    reply = :erlang.alias()
    request = make_ref()
    worker_monitor = Process.monitor(reader.worker)
    server_monitor = Process.monitor(reader.server)

    deadline = System.monotonic_time(:millisecond) + reader.timeout

    send(
      reader.worker,
      {:read, reader.token, self(), reply, request, deadline, operation}
    )

    try do
      receive do
        {^request, result} ->
          case result do
            {:transient, error} ->
              block(reader, :timeout, request)
              close(reader)
              raise error

            {:error, cause} when cause in [:eacces, :eperm] ->
              block(reader, cause, request)
              close(reader)
              raise Error, reason: :blocked, path: reader.path, cause: cause

            other ->
              other
          end

        {:DOWN, ^worker_monitor, :process, _, reason} ->
          raise Error, reason: :busy, path: reader.path, cause: reason

        {:DOWN, ^server_monitor, :process, _, reason} ->
          close(reader)
          raise Error, reason: :busy, path: reader.path, cause: reason
      after
        max(deadline - System.monotonic_time(:millisecond), 0) ->
          :erlang.unalias(reply)
          block(reader, :timeout, request)
          close(reader)
          raise Error, reason: :timeout, path: reader.path
      end
    after
      :erlang.unalias(reply)
      Process.demonitor(worker_monitor, [:flush])
      Process.demonitor(server_monitor, [:flush])
    end
  end

  def close(%__MODULE__{} = reader) do
    send(reader.worker, {:close, reader.token, self()})
    :ok
  end

  defp block(reader, cause, failure_id) do
    message = {:reader_block, reader.lease, failure_id, cause}

    try do
      GenServer.call(reader.server, message, 50)
    catch
      :exit, _ -> GenServer.cast(reader.server, message)
    end
  end

  defp loop(fd, reader, owner, monitor, read_fn, last_result) do
    receive do
      {:read, token, ^owner, reply, request, deadline, operation}
      when token == reader.token ->
        result =
          if Process.alive?(owner) and deadline > System.monotonic_time(:millisecond) do
            case operation do
              {:pread, offset, length} -> read_fn.(fd, offset, length)
              :line -> :file.read_line(fd)
            end
          else
            {:transient, %Error{reason: :timeout, path: reader.path}}
          end

        if match?({:ok, _}, result) or result == :eof, do: Access.permission_proof()
        send(reply, {request, result})

        completion =
          case result do
            {:ok, _} -> {:ok, :closed}
            :eof -> {:ok, :closed}
            {:transient, _} -> {:error, :timeout}
            error -> error
          end

        loop(fd, reader, owner, monitor, read_fn, completion)

      {:close, token, ^owner} when token == reader.token ->
        last_result

      {:DOWN, ^monitor, :process, ^owner, _} ->
        last_result
    end
  end
end
