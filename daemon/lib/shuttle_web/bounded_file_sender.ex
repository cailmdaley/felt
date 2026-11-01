defmodule ShuttleWeb.BoundedFileSender do
  @moduledoc "Bounded raw file transfer with preflight reads and socket backpressure."

  import Plug.Conn, except: [send_file: 3, send_file: 4, send_file: 5]
  alias Shuttle.FileAccess
  alias Shuttle.FileAccess.Reader

  @doc "Send a representation with an optional entity tag and single byte ranges."
  def serve(conn, path, size, opts \\ []) do
    etag = Keyword.get(opts, :etag)
    conn = conn |> put_resp_header("accept-ranges", "bytes")
    conn = if etag, do: put_resp_header(conn, "etag", etag), else: conn

    cond do
      not_modified?(conn, etag) ->
        send_resp(conn, 304, "")

      head_request?(conn) ->
        send_file(conn, 200, path, 0, size, opts)

      true ->
        case requested_range(conn, etag, size) do
          {:partial, first, last} ->
            conn
            |> put_resp_header("content-range", "bytes #{first}-#{last}/#{size}")
            |> send_file(206, path, first, last - first + 1, opts)

          :unsatisfiable ->
            conn
            |> put_resp_header("content-range", "bytes */#{size}")
            |> put_resp_header("content-length", "0")
            |> send_resp(416, "")

          :ignore ->
            send_file(conn, 200, path, 0, size, opts)
        end
    end
  end

  @doc "Transfer a byte window without opening the path in the socket owner."
  def send_file(conn, status, path, offset, length, opts \\ []) do
    conn = put_resp_header(conn, "content-length", Integer.to_string(length))

    if head_request?(conn) or length == 0 do
      send_resp(conn, status, "")
    else
      case prepare(path, offset, length, options(conn, opts)) do
        {:ok, reader, bytes} ->
          try do
            stream_chunks(send_chunked(conn, status), reader, offset, length, bytes)
          after
            Reader.close(reader)
          end

        {:transient, error} ->
          unavailable(conn, error)

        {:missing, _reason} ->
          conn = conn |> clear_representation() |> put_resp_header("cache-control", "no-store")

          case Keyword.get(opts, :missing) do
            fun when is_function(fun, 1) -> fun.(conn)
            _ -> send_json(conn, 404, %{error: "file not found"})
          end
      end
    end
  end

  defp prepare(path, offset, length, opts) do
    with {:ok, reader} <- Reader.open(path, opts) do
      try do
        case Reader.read(reader, offset, min(length, Reader.chunk_size())) do
          {:ok, bytes} when byte_size(bytes) > 0 ->
            {:ok, reader, bytes}

          {:error, reason} ->
            Reader.close(reader)
            io_failure(path, reason)

          other ->
            Reader.close(reader)
            io_failure(path, other)
        end
      rescue
        error ->
          Reader.close(reader)
          reraise error, __STACKTRACE__
      end
    else
      {:error, reason} when reason in [:enoent, :enotdir] -> {:missing, reason}
      {:error, reason} -> io_failure(path, reason)
    end
  rescue
    error in FileAccess.Error -> {:transient, error}
  end

  defp io_failure(path, cause),
    do: {:transient, %FileAccess.Error{reason: :io, path: path, cause: cause}}

  # Errors after headers escape to the HTTP adapter, which must close the
  # connection without a successful end-of-body marker or a second response.
  defp stream_chunks(conn, reader, offset, remaining, bytes) do
    case chunk(conn, bytes) do
      {:ok, conn} ->
        remaining = remaining - byte_size(bytes)
        offset = offset + byte_size(bytes)

        if remaining == 0 do
          conn
        else
          case Reader.read(reader, offset, min(remaining, Reader.chunk_size())) do
            {:ok, bytes} when byte_size(bytes) > 0 ->
              stream_chunks(conn, reader, offset, remaining, bytes)

            {:error, reason} ->
              raise File.Error, reason: reason, action: "read file", path: reader.path

            _ ->
              raise File.Error, reason: :eio, action: "read file", path: reader.path
          end
        end

      {:error, _closed} ->
        halt(conn)
    end
  end

  defp options(conn, opts),
    do:
      Keyword.merge(
        Map.get(conn.private, :shuttle_file_access, []),
        Keyword.get(opts, :file_access, [])
      )

  @doc "A truthful transient response, with all representation metadata removed."
  def unavailable(conn, error) do
    conn
    |> clear_representation()
    |> put_resp_header("cache-control", "no-store")
    |> send_json(Plug.Exception.status(error), %{
      error: Exception.message(error),
      reason: error.reason
    })
  end

  defp clear_representation(conn) do
    Enum.reduce(
      [
        "content-length",
        "content-range",
        "etag",
        "last-modified",
        "x-transcript-byte-count",
        "x-transcript-sha256"
      ],
      conn,
      &delete_resp_header(&2, &1)
    )
  end

  defp send_json(conn, status, body),
    do:
      conn |> put_resp_content_type("application/json") |> send_resp(status, Jason.encode!(body))

  @doc "Recognize HEAD even when Plug.Head has rewritten the method to GET."
  def head_request?(%{adapter: {_, %{method: "HEAD"}}}), do: true
  def head_request?(conn), do: conn.method == "HEAD"

  defp not_modified?(_conn, nil), do: false

  defp not_modified?(conn, etag) do
    conn
    |> get_req_header("if-none-match")
    |> Enum.flat_map(&String.split(&1, ","))
    |> Enum.any?(fn tag ->
      tag = String.trim(tag)
      tag == "*" or String.replace_prefix(tag, "W/", "") == String.replace_prefix(etag, "W/", "")
    end)
  end

  defp requested_range(conn, etag, size) do
    with [range] <- get_req_header(conn, "range"),
         true <- get_req_header(conn, "if-range") in [[], [etag]],
         [_, first, last] <- Regex.run(~r/\Abytes=(\d*)-(\d*)\z/i, String.trim(range)) do
      case {first, last} do
        {"", ""} -> :ignore
        {"", suffix} -> suffix_range(String.to_integer(suffix), size)
        {first, ""} -> bounded_range(String.to_integer(first), size - 1, size)
        {first, last} -> bounded_range(String.to_integer(first), String.to_integer(last), size)
      end
    else
      _ -> :ignore
    end
  end

  defp suffix_range(0, _size), do: :unsatisfiable
  defp suffix_range(_length, 0), do: :unsatisfiable
  defp suffix_range(length, size), do: {:partial, max(size - length, 0), size - 1}
  defp bounded_range(_first, _last, 0), do: :unsatisfiable
  defp bounded_range(first, _last, size) when first >= size, do: :unsatisfiable
  defp bounded_range(first, last, _size) when last < first, do: :ignore
  defp bounded_range(first, last, size), do: {:partial, first, min(last, size - 1)}
end
