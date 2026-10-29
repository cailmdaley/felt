defmodule ShuttleWeb.TranscriptStream do
  @moduledoc """
  Follows a local JSONL transcript as server-sent events in the request process.
  """

  import Plug.Conn
  alias Shuttle.FileTail

  @registry ShuttleWeb.TranscriptStreams
  @defaults [
    tick_ms: 250,
    heartbeat_ms: 15_000,
    max_ms: 1_800_000,
    max_streams: 32,
    max_relays_per_remote: 16,
    relay_idle_ms: 45_000,
    relay_connect_ms: 15_000,
    event_bytes: 262_144,
    read_bytes: 1_048_576
  ]

  def config, do: Keyword.merge(@defaults, Shuttle.Env.app(:transcript_stream, []))

  def admit(key) do
    {:ok, _} = Registry.register(@registry, key, nil)

    if Registry.count(@registry) > config()[:max_streams] do
      Registry.unregister(@registry, key)
      :busy
    else
      :ok
    end
  end

  def release(key), do: Registry.unregister(@registry, key)

  def follow(conn, path, offset) do
    key = conn.private[:transcript_stream_key]

    try do
      cfg = config()
      start = now()
      inode = conn.private[:transcript_stream_inode] || FileTail.inode(path)
      size = conn.private[:transcript_stream_size] || offset

      case chunk(conn, ": open\n\n") do
        {:ok, conn} -> loop(conn, path, offset, inode, size, start, start, cfg)
        {:error, _} -> conn
      end
    after
      if key, do: release(key)
    end
  end

  defp loop(conn, path, offset, inode, observed_size, started, last_write, cfg) do
    time = now()

    if time - started >= cfg[:max_ms] do
      conn
    else
      result = FileTail.advance(path, offset, max_bytes: cfg[:read_bytes])

      case File.stat(path) do
        {:ok, %{inode: current, size: size}} when current != inode or is_nil(inode) ->
          reset(conn, size)

        {:error, _} ->
          reset(conn, 0)

        {:ok, %{size: size}} when size < observed_size ->
          reset(conn, size)

        {:ok, %{size: current_size}} ->
          case result do
            {:reset, size} ->
              reset(conn, size)

            {:append, lines, next} ->
              case send_events(conn, path, lines, offset, next, inode, cfg[:event_bytes]) do
                {:ok, conn} ->
                  written = now()

                  if current_size - offset >= cfg[:read_bytes] and current_size > next do
                    loop(conn, path, next, inode, current_size, started, written, cfg)
                  else
                    wait(conn, path, next, inode, current_size, started, written, cfg)
                  end

                {:error, :changed} ->
                  reset(
                    conn,
                    case File.stat(path) do
                      {:ok, %{size: size}} -> size
                      _ -> 0
                    end
                  )

                {:error, _} ->
                  conn
              end

            :noop ->
              if time - last_write >= cfg[:heartbeat_ms] do
                case chunk(conn, ": keepalive\n\n") do
                  {:ok, conn} ->
                    wait(conn, path, offset, inode, current_size, started, now(), cfg)

                  {:error, _} ->
                    conn
                end
              else
                wait(conn, path, offset, inode, current_size, started, last_write, cfg)
              end
          end
      end
    end
  end

  defp wait(conn, path, offset, inode, observed_size, started, last_write, cfg) do
    remaining = max(0, cfg[:max_ms] - (now() - started))

    receive do
    after
      min(cfg[:tick_ms], remaining) ->
        loop(conn, path, offset, inode, observed_size, started, last_write, cfg)
    end
  end

  defp send_events(conn, path, lines, offset, next, inode, limit) do
    with {:ok, file} <- :file.open(path, [:read, :binary, :raw]) do
      result =
        try do
          :file.pread(file, offset, next - offset)
        after
          :file.close(file)
        end

      with {:ok, bytes} <- result,
           true <- byte_size(bytes) == next - offset,
           ^inode <- FileTail.inode(path) do
        {records, _} =
          bytes
          |> :binary.split("\n", [:global])
          |> Enum.reduce({[], offset}, fn line, {records, pos} ->
            next_pos = pos + byte_size(line) + 1
            if line == "", do: {records, next_pos}, else: {[{line, next_pos} | records], next_pos}
          end)

        records = Enum.reverse(records)

        if Enum.map(records, &elem(&1, 0)) == lines do
          write_batches(conn, records, limit)
        else
          {:error, :changed}
        end
      else
        _ -> {:error, :changed}
      end
    else
      {:error, _} -> {:error, :changed}
    end
  end

  defp write_batches(conn, records, limit) do
    {batches, batch, _size, id} =
      Enum.reduce(records, {[], [], 0, 0}, fn {line, pos}, {batches, batch, size, id} ->
        bytes = byte_size(line) + 1

        if batch != [] and size + bytes > limit do
          {[{Enum.reverse(batch), id} | batches], [line], bytes, pos}
        else
          {batches, [line | batch], size + bytes, pos}
        end
      end)

    batches = Enum.reverse([{Enum.reverse(batch), id} | batches])

    Enum.reduce_while(batches, {:ok, conn}, fn {batch, id}, {:ok, conn} ->
      case chunk(conn, event_iodata(batch, id)) do
        {:ok, conn} -> {:cont, {:ok, conn}}
        error -> {:halt, error}
      end
    end)
  end

  def event_iodata(lines, id) do
    [
      "id: ",
      Integer.to_string(id),
      "\n",
      Enum.map(lines, &["data: ", :binary.replace(&1, "\r", "", [:global]), "\n"]),
      "\n"
    ]
  end

  defp reset(conn, size) do
    case chunk(conn, ["event: reset\ndata: ", Jason.encode!(%{byte_count: size}), "\n\n"]) do
      {:ok, conn} -> conn
      {:error, _} -> conn
    end
  end

  defp now, do: System.monotonic_time(:millisecond)
end
