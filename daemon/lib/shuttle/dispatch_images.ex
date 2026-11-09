defmodule Shuttle.DispatchImages do
  @moduledoc """
  Images pasted into the board's worker line, landed on the worker's host.

  `/api/v1/dispatch` carries them as `images: [%{"name", "data"}]`, `data`
  base64. The owning daemon writes each under
  `<data dir>/images/<sha256>.<ext>`, content-addressed so a retried send
  rewrites nothing, and the opening message names each path on its own
  `[Image: <path>]` line, which the worker reads.
  """

  @max_images 8
  @max_bytes 20 * 1024 * 1024
  @types %{"png" => <<0x89, "PNG">>, "jpg" => <<0xFF, 0xD8>>, "gif" => "GIF8", "webp" => "RIFF"}

  @doc "The message with one `[Image: <path>]` line per image appended, or why the images were refused."
  @spec attach(String.t() | nil, term()) :: {:ok, String.t() | nil} | {:error, String.t()}
  def attach(message, images) when images in [nil, []], do: {:ok, message}

  def attach(message, images) when is_list(images) and length(images) <= @max_images do
    with {:ok, decoded} <- decode(images),
         {:ok, paths} <- write(decoded) do
      lines = Enum.map_join(paths, "\n", &"[Image: #{&1}]")
      {:ok, if(message in [nil, ""], do: lines, else: message <> "\n\n" <> lines)}
    end
  end

  def attach(_message, images) when is_list(images),
    do: {:error, "at most #{@max_images} images per send"}

  def attach(_message, _images), do: {:error, "images must be a list"}

  defp decode(images) do
    Enum.reduce_while(images, {:ok, [], 0}, fn image, {:ok, acc, total} ->
      with %{"data" => data} when is_binary(data) <- image,
           {:ok, bytes} <- Base.decode64(data),
           {:ok, ext} <- type(bytes),
           total = total + byte_size(bytes),
           true <- total <= @max_bytes || {:error, "images exceed 20 MB in total"} do
        {:cont, {:ok, [{bytes, ext} | acc], total}}
      else
        {:error, reason} -> {:halt, {:error, reason}}
        _ -> {:halt, {:error, "each image needs base64 data"}}
      end
    end)
    |> case do
      {:ok, decoded, _} -> {:ok, Enum.reverse(decoded)}
      error -> error
    end
  end

  # The bytes name their own type; the client's file name never reaches the disk.
  defp type(bytes) do
    case Enum.find(@types, fn {_ext, magic} -> String.starts_with?(bytes, magic) end) do
      {ext, _} -> {:ok, ext}
      nil -> {:error, "images must be PNG, JPEG, GIF or WebP"}
    end
  end

  defp write(decoded) do
    dir = Path.join(Shuttle.data_dir(), "images")

    with :ok <- File.mkdir_p(dir), :ok <- File.chmod(dir, 0o700) do
      Enum.reduce_while(decoded, {:ok, []}, fn {bytes, ext}, {:ok, paths} ->
        path = Path.join(dir, Base.encode16(:crypto.hash(:sha256, bytes), case: :lower) <> "." <> ext)

        case File.exists?(path) or put(path, bytes) == :ok do
          true -> {:cont, {:ok, [path | paths]}}
          false -> {:halt, {:error, "could not store an image on this host"}}
        end
      end)
      |> case do
        {:ok, paths} -> {:ok, Enum.reverse(paths)}
        error -> error
      end
    else
      _ -> {:error, "could not store an image on this host"}
    end
  end

  defp put(path, bytes) do
    tmp = path <> ".#{System.unique_integer([:positive])}.tmp"

    with :ok <- File.write(tmp, bytes, [:exclusive]),
         :ok <- File.chmod(tmp, 0o600),
         :ok <- File.rename(tmp, path) do
      :ok
    else
      error ->
        File.rm(tmp)
        error
    end
  end
end
