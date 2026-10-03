defmodule Shuttle.Attachments do
  @moduledoc """
  Images the board's composer pastes into a directive, stored on the host
  that owns the fiber so the worker it launches can open them by path.

  `store/2` validates a batch, decodes it, and writes each image to

      <data_dir>/attachments/<fiber dir>/<sha256 first 16 hex>.<ext>

  where `<fiber dir>` is the fiber's intrinsic uid when felt carries one and
  otherwise the first 16 hex of the sha256 of its address. Files are
  content-addressed, so sending the same image twice writes the same path.

  Every limit is checked here, whatever the caller already checked: at most
  `max_files/0` images, each at most `max_file_bytes/0` decoded bytes and all of
  them together at most `max_total_bytes/0`; a mime among `mimes/0` whose magic
  bytes the data actually carries; base64 that decodes; a sha256 equal to the
  decoded bytes' digest. Nothing is written unless the whole batch passes.

  Writes are atomic and never follow a link: each directory under the data dir
  is created 0700 and refused if it is a symlink or not a directory, and each
  file is written 0600 to an exclusive temp name in its final directory and
  renamed over the destination (a rename replaces a link, it does not follow
  it).
  """

  @max_files 8
  @max_file_bytes 10 * 1024 * 1024
  @max_total_bytes 25 * 1024 * 1024

  @extensions %{
    "image/png" => "png",
    "image/jpeg" => "jpg",
    "image/gif" => "gif",
    "image/webp" => "webp"
  }

  @type stored :: %{
          name: String.t(),
          path: String.t(),
          sha256: String.t(),
          size: non_neg_integer()
        }

  @doc "The most images one request may carry."
  def max_files, do: @max_files

  @doc "The largest decoded image one request may carry, in bytes."
  def max_file_bytes, do: @max_file_bytes

  @doc "The largest decoded total one request may carry, in bytes."
  def max_total_bytes, do: @max_total_bytes

  @doc "The accepted mime types."
  def mimes, do: Map.keys(@extensions) |> Enum.sort()

  @doc """
  The JSON body ceiling the endpoint's parser applies: the decoded total in
  base64 (4/3) plus room for names, digests and the envelope.
  """
  def max_request_bytes, do: div(@max_total_bytes * 4, 3) + 2 * 1024 * 1024

  @doc """
  Validate and write `attachments` (the request's list of
  `%{"name", "mime", "data", "sha256"}` maps) for the fiber that `resolved`
  describes (a `Shuttle.FeltStores.resolve_fiber/1` result).

  Options: `:root` — the attachments root, default
  `<Shuttle.data_dir/0>/attachments`.

  Returns `{:ok, [stored]}` in request order or `{:error, :invalid, message}`
  for a request that broke a rule, `{:error, :io, message}` for a write that
  failed.
  """
  @spec store(map(), list(), keyword()) ::
          {:ok, [stored()]} | {:error, :invalid | :io, String.t()}
  def store(resolved, attachments, opts \\ [])

  def store(resolved, attachments, opts) when is_list(attachments) do
    root = Keyword.get_lazy(opts, :root, fn -> Path.join(Shuttle.data_dir(), "attachments") end)

    with :ok <- check_count(attachments),
         {:ok, decoded} <- decode_all(attachments),
         :ok <- check_total(decoded),
         dir = Path.join(root, fiber_dir(resolved)),
         :ok <- ensure_private_dir(Path.dirname(root), root),
         :ok <- ensure_private_dir(root, dir) do
      write_all(dir, decoded)
    end
  end

  def store(_resolved, _attachments, _opts),
    do: {:error, :invalid, "attachments must be a list"}

  @doc """
  The per-fiber directory name: the uid when it is a plain token, else a
  digest of the fiber's address. Never a path with separators.
  """
  @spec fiber_dir(map()) :: String.t()
  def fiber_dir(resolved) do
    uid = Map.get(resolved, :uid)

    if is_binary(uid) and Regex.match?(~r/\A[A-Za-z0-9_-]{1,64}\z/, uid) do
      uid
    else
      address = Map.get(resolved, :fiber_id) || ""
      :crypto.hash(:sha256, address) |> Base.encode16(case: :lower) |> binary_part(0, 16)
    end
  end

  defp check_count([]), do: {:error, :invalid, "attachments must not be empty"}

  defp check_count(list) when length(list) > @max_files,
    do: {:error, :invalid, "at most #{@max_files} images per send (got #{length(list)})"}

  defp check_count(_), do: :ok

  defp check_total(decoded) do
    total = decoded |> Enum.map(&byte_size(&1.bytes)) |> Enum.sum()

    if total > @max_total_bytes,
      do: {:error, :invalid, "images total #{total} bytes; the limit is #{@max_total_bytes}"},
      else: :ok
  end

  defp decode_all(attachments) do
    attachments
    |> Enum.with_index(1)
    |> Enum.reduce_while({:ok, []}, fn {item, index}, {:ok, acc} ->
      case decode_one(item) do
        {:ok, entry} -> {:cont, {:ok, [entry | acc]}}
        {:error, message} -> {:halt, {:error, :invalid, "image #{index}: #{message}"}}
      end
    end)
    |> case do
      {:ok, acc} -> {:ok, Enum.reverse(acc)}
      error -> error
    end
  end

  defp decode_one(%{} = item) do
    with {:ok, mime} <- field(item, "mime"),
         {:ok, ext} <- extension(mime),
         {:ok, data} <- field(item, "data"),
         :ok <- check_encoded_size(data),
         {:ok, bytes} <- decode_base64(data),
         :ok <- check_size(bytes),
         :ok <- check_magic(mime, bytes),
         {:ok, sha} <- field(item, "sha256"),
         :ok <- check_sha(sha, bytes) do
      {:ok,
       %{
         name: display_name(Map.get(item, "name")),
         ext: ext,
         bytes: bytes,
         sha256: String.downcase(sha)
       }}
    end
  end

  defp decode_one(_), do: {:error, "must be an object"}

  defp field(item, key) do
    case Map.get(item, key) do
      value when is_binary(value) and value != "" -> {:ok, value}
      _ -> {:error, "#{key} is required"}
    end
  end

  defp extension(mime) do
    case Map.fetch(@extensions, String.downcase(mime)) do
      {:ok, ext} ->
        {:ok, ext}

      :error ->
        {:error, "#{inspect(mime)} is not an accepted image type (#{Enum.join(mimes(), ", ")})"}
    end
  end

  # Refuse an oversized image before decoding it.
  defp check_encoded_size(data) do
    if byte_size(data) > div(@max_file_bytes * 4, 3) + 4,
      do: {:error, "larger than #{@max_file_bytes} bytes"},
      else: :ok
  end

  defp decode_base64(data) do
    case Base.decode64(data, ignore: :whitespace, padding: false) do
      {:ok, bytes} -> {:ok, bytes}
      :error -> {:error, "data is not valid base64"}
    end
  end

  defp check_size(bytes) when byte_size(bytes) == 0, do: {:error, "is empty"}

  defp check_size(bytes) when byte_size(bytes) > @max_file_bytes,
    do: {:error, "is #{byte_size(bytes)} bytes; the limit is #{@max_file_bytes}"}

  defp check_size(_), do: :ok

  defp check_magic(mime, bytes) do
    if magic?(String.downcase(mime), bytes),
      do: :ok,
      else: {:error, "data is not a #{mime} image"}
  end

  defp magic?("image/png", <<0x89, "PNG", 0x0D, 0x0A, 0x1A, 0x0A, _::binary>>), do: true
  defp magic?("image/jpeg", <<0xFF, 0xD8, 0xFF, _::binary>>), do: true
  defp magic?("image/gif", <<"GIF8", v, "a", _::binary>>) when v in [?7, ?9], do: true
  defp magic?("image/webp", <<"RIFF", _::binary-size(4), "WEBP", _::binary>>), do: true
  defp magic?(_, _), do: false

  defp check_sha(sha, bytes) do
    actual = :crypto.hash(:sha256, bytes) |> Base.encode16(case: :lower)

    cond do
      not Regex.match?(~r/\A[0-9a-fA-F]{64}\z/, sha) -> {:error, "sha256 must be 64 hex digits"}
      String.downcase(sha) != actual -> {:error, "sha256 does not match the data"}
      true -> :ok
    end
  end

  # The name is shown back to the board; it never reaches the filesystem.
  defp display_name(name) when is_binary(name) do
    cleaned =
      name
      |> Path.basename()
      |> String.replace(~r/[[:cntrl:]]/u, "")
      |> String.slice(0, 200)

    if cleaned == "", do: "image", else: cleaned
  end

  defp display_name(_), do: "image"

  # `parent` is created if absent; `dir` is created 0700 if absent and refused
  # if it is a link or a non-directory.
  defp ensure_private_dir(parent, dir) do
    with :ok <- File.mkdir_p(parent) |> io_error("create #{parent}") do
      ensure_dir(dir)
    end
  end

  defp ensure_dir(dir) do
    case File.lstat(dir) do
      {:ok, %File.Stat{type: :directory}} ->
        :ok

      {:ok, %File.Stat{type: type}} ->
        {:error, :io, "#{dir} is a #{type}, not a directory"}

      {:error, :enoent} ->
        case File.mkdir(dir) do
          :ok -> File.chmod(dir, 0o700) |> io_error("chmod #{dir}")
          {:error, :eexist} -> ensure_dir(dir)
          {:error, reason} -> {:error, :io, "create #{dir}: #{:file.format_error(reason)}"}
        end

      {:error, reason} ->
        {:error, :io, "inspect #{dir}: #{:file.format_error(reason)}"}
    end
  end

  defp write_all(dir, decoded) do
    Enum.reduce_while(decoded, {:ok, []}, fn entry, {:ok, acc} ->
      case write_one(dir, entry) do
        {:ok, stored} -> {:cont, {:ok, [stored | acc]}}
        error -> {:halt, error}
      end
    end)
    |> case do
      {:ok, acc} -> {:ok, Enum.reverse(acc)}
      error -> error
    end
  end

  defp write_one(dir, %{bytes: bytes, sha256: sha, ext: ext, name: name}) do
    dest = Path.join(dir, "#{binary_part(sha, 0, 16)}.#{ext}")
    tmp = Path.join(dir, ".#{binary_part(sha, 0, 16)}.#{System.unique_integer([:positive])}.tmp")

    result =
      with :ok <- write_exclusive(tmp, bytes),
           :ok <- File.rename(tmp, dest) |> io_error("rename into #{dest}") do
        {:ok, %{name: name, path: dest, sha256: sha, size: byte_size(bytes)}}
      end

    if match?({:error, _, _}, result), do: File.rm(tmp)
    result
  end

  # `:exclusive` is O_CREAT|O_EXCL: it fails rather than open whatever already
  # sits at the temp name, link or not.
  defp write_exclusive(path, bytes) do
    case :file.open(path, [:write, :raw, :binary, :exclusive]) do
      {:ok, fd} ->
        result =
          with :ok <- File.chmod(path, 0o600) |> io_error("chmod #{path}"),
               :ok <- :file.write(fd, bytes) |> io_error("write #{path}"),
               :ok <- :file.sync(fd) |> io_error("sync #{path}") do
            :ok
          end

        :file.close(fd)
        result

      {:error, reason} ->
        {:error, :io, "create #{path}: #{:file.format_error(reason)}"}
    end
  end

  defp io_error(:ok, _what), do: :ok

  defp io_error({:error, reason}, what),
    do: {:error, :io, "#{what}: #{:file.format_error(reason)}"}
end
