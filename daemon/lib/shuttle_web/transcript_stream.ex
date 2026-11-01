defmodule ShuttleWeb.TranscriptStream do
  @moduledoc """
  Follows local JSONL transcripts and relays remote owners' server-sent events
  in the request process.
  """

  import Plug.Conn
  alias Shuttle.{FileTail, OriginRouter, Remote}
  alias ShuttleWeb.TranscriptController

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

    cfg = config()

    remote_full? =
      case key do
        {:relay, _} -> Registry.count_match(@registry, key, :_) > cfg[:max_relays_per_remote]
        {:local, _} -> false
      end

    if Registry.count(@registry) > cfg[:max_streams] or remote_full? do
      Registry.unregister(@registry, key)
      :busy
    else
      :ok
    end
  end

  def release(key), do: Registry.unregister(@registry, key)

  def relay(conn, %Remote{} = remote, query, session) do
    key = {:relay, remote.name}

    case admit(key) do
      :busy ->
        json_response(conn, 429, %{error: "stream_capacity"})

      :ok ->
        owner = :erlang.alias()

        try do
          cfg = config()
          client = OriginRouter.forward_client()

          case OriginRouter.forward_stream(
                 remote,
                 "/api/v1/transcript/stream",
                 Map.put(query, "host", "local"),
                 req_headers: [{"accept", "text/event-stream"}],
                 owner: owner,
                 connect_timeout_ms: cfg[:relay_connect_ms]
               ) do
            {:ok, id} ->
              try do
                relay_open(conn, remote, query, session, client, id, cfg)
              after
                # httpc cancellation is asynchronous. Close delivery before draining
                # so a keep-alive connection cannot receive this request's late bytes.
                :erlang.unalias(owner)

                try do
                  client.stream_cancel(id)
                after
                  flush_stream(id)
                end
              end

            {:error, :stream_not_supported} ->
              unsupported(conn, remote)

            {:error, _} ->
              TranscriptController.unavailable(conn, session, :host_unreachable, remote.name)
          end
        after
          :erlang.unalias(owner)
          release(key)
        end
    end
  end

  defp relay_open(conn, remote, query, session, client, id, cfg) do
    receive do
      {:remote_stream, ^id, {:open, headers, cursor}} ->
        if event_stream?(headers) do
          conn =
            conn
            |> put_resp_content_type("text/event-stream")
            |> put_resp_header("cache-control", "no-cache, no-transform")
            |> put_resp_header("x-accel-buffering", "no")
            |> put_resp_header("x-transcript-offset", Map.get(query, "offset", "0"))
            |> send_chunked(200)

          client.stream_next(cursor)
          relay_loop(conn, client, id, cursor, cfg[:relay_idle_ms])
        else
          unsupported(conn, remote)
        end

      {:remote_stream, ^id, {:response, status, headers, body}} ->
        case Jason.decode(body) do
          {:ok, %{"availability" => _}} ->
            conn |> put_resp_content_type("application/json") |> send_resp(status, body)

          _ when status in [404, 405] ->
            unsupported(conn, remote)

          _ ->
            conn |> put_resp_content_type(content_type(headers), nil) |> send_resp(status, body)
        end

      {:remote_stream, ^id, {:error, _}} ->
        TranscriptController.unavailable(conn, session, :host_unreachable, remote.name)

      {:remote_stream, ^id, :done} ->
        TranscriptController.unavailable(conn, session, :host_unreachable, remote.name)

      {:EXIT, _, _reason} = exit ->
        return_on_exit(conn, exit)
    after
      cfg[:relay_connect_ms] ->
        TranscriptController.unavailable(conn, session, :host_unreachable, remote.name)
    end
  end

  defp relay_loop(conn, client, id, cursor, idle_ms) do
    receive do
      {:remote_stream, ^id, {:data, bytes}} ->
        case chunk(conn, bytes) do
          {:ok, conn} ->
            client.stream_next(cursor)
            relay_loop(conn, client, id, cursor, idle_ms)

          {:error, _} ->
            conn
        end

      {:remote_stream, ^id, :done} ->
        conn

      {:remote_stream, ^id, {:error, _}} ->
        relay_error(conn, "upstream_error")

      {:EXIT, _, _reason} = exit ->
        return_on_exit(conn, exit)
    after
      idle_ms -> relay_error(conn, "upstream_idle")
    end
  end

  defp relay_error(conn, reason) do
    # End any partial upstream line, then override its event type before the
    # blank line dispatches it. The client must not commit a partial data event.
    case chunk(conn, ["\nevent: error\ndata: ", Jason.encode!(%{error: reason}), "\n\n"]) do
      {:ok, conn} -> conn
      {:error, _} -> conn
    end
  end

  defp event_stream?(headers) do
    headers
    |> content_type()
    |> String.split(";", parts: 2)
    |> hd()
    |> String.trim()
    |> String.downcase()
    |> Kernel.==("text/event-stream")
  end

  defp content_type(headers) do
    Enum.find_value(headers, "application/json", fn {name, value} ->
      if String.downcase(name) == "content-type", do: value
    end)
  end

  defp unsupported(conn, remote),
    do: json_response(conn, 501, %{error: "stream_unsupported", host: remote.name})

  defp json_response(conn, status, payload),
    do:
      conn
      |> put_resp_content_type("application/json")
      |> send_resp(status, Jason.encode!(payload))

  defp flush_stream(id) do
    receive do
      {:remote_stream, ^id, _} -> flush_stream(id)
    after
      0 -> :ok
    end
  end

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
      {:EXIT, _, _reason} = exit -> return_on_exit(conn, exit)
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

  defp return_on_exit(conn, exit) do
    # Return control to Bandit's GenServer without consuming its parent's exit.
    # It must process that signal after request cleanup, even on keep-alive.
    send(self(), exit)
    conn
  end

  defp now, do: System.monotonic_time(:millisecond)
end
