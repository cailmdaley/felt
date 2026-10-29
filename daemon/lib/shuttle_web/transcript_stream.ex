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
    event_bytes: 262_144
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

  def follow(conn, path, offset, opts \\ []) do
    cfg = config()
    start = now()

    stat =
      Keyword.get_lazy(opts, :stat, fn ->
        case File.stat(path) do
          {:ok, stat} -> stat
          {:error, _} -> %{inode: nil, size: offset}
        end
      end)

    case chunk(conn, ": open\n\n") do
      {:ok, conn} -> loop(conn, path, offset, stat.inode, stat.size, start, start, cfg)
      {:error, _} -> conn
    end
  end

  defp loop(conn, path, offset, inode, observed_size, started, last_write, cfg) do
    time = now()

    if time - started >= cfg[:max_ms] do
      conn
    else
      result = FileTail.advance(path, offset, max_bytes: cfg[:event_bytes])

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
              result =
                if lines == [], do: {:ok, conn}, else: chunk(conn, event_iodata(lines, next))

              case result do
                {:ok, conn} ->
                  written = if lines == [], do: last_write, else: now()

                  if next < current_size do
                    loop(conn, path, next, inode, current_size, started, written, cfg)
                  else
                    wait(conn, path, next, inode, current_size, started, written, cfg)
                  end

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
