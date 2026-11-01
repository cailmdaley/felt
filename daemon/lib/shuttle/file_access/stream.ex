defmodule Shuttle.FileAccess.Stream do
  @moduledoc false
  alias Shuttle.FileAccess.Reader

  def open(path, modes, line_or_bytes, opts) do
    unless line_or_bytes == :line or (is_integer(line_or_bytes) and line_or_bytes > 0),
      do: raise(ArgumentError, "stream unit must be :line or a positive byte count")

    if Enum.any?(modes, &(&1 in [:write, :append, :exclusive])),
      do: raise(ArgumentError, "FileAccess streams are read-only")

    Stream.resource(
      fn ->
        case Reader.open(path, Keyword.put(opts, :file_modes, modes)) do
          {:ok, reader} -> {reader, 0}
          {:error, reason} -> file_error!(path, reason)
        end
      end,
      fn {reader, offset} = state ->
        result =
          if line_or_bytes == :line,
            do: Reader.read_line(reader),
            else: bytes(reader, offset, line_or_bytes, [])

        case result do
          {:ok, data} -> {[data], {reader, offset + byte_size(data)}}
          :eof -> {:halt, state}
          {:error, reason} -> file_error!(path, reason)
        end
      end,
      fn {reader, _offset} -> Reader.close(reader) end
    )
  end

  defp bytes(_reader, _offset, 0, acc), do: {:ok, acc |> Enum.reverse() |> IO.iodata_to_binary()}

  defp bytes(reader, offset, remaining, acc) do
    case Reader.read(reader, offset, remaining) do
      {:ok, data} ->
        bytes(reader, offset + byte_size(data), remaining - byte_size(data), [data | acc])

      :eof when acc == [] ->
        :eof

      :eof ->
        bytes(reader, offset, 0, acc)

      error ->
        error
    end
  end

  defp file_error!(path, reason),
    do: raise(File.Error, reason: reason, action: "stream file", path: path)
end
