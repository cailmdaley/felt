defmodule Shuttle.FS do
  @moduledoc """
  Filesystem operations in the calling process, without OTP's shared file server.

  Descriptors are raw and belong to the process that opens them. There is no
  admission limit here; isolation and deadlines belong to the caller.
  """
  @type posix :: File.posix()
  require Record
  Record.defrecordp(:file_info, Record.extract(:file_info, from_lib: "kernel/include/file.hrl"))

  def open(path, modes) do
    :file.open(path, Enum.uniq([:raw | modes]))
  end

  def open(path, modes, fun) do
    with {:ok, fd} <- open(path, modes) do
      try do
        {:ok, fun.(fd)}
      after
        close(fd)
      end
    end
  end

  defdelegate close(fd), to: :file
  defdelegate position(fd, offset), to: :file
  defdelegate pread(fd, offset, count), to: :file
  defdelegate sync(fd), to: :file
  defdelegate truncate(fd), to: :file
  defdelegate format_error(reason), to: :file
  defdelegate read(fd, count), to: :file

  def read(path) do
    with {:ok, fd} <- open(path, [:read, :binary]) do
      try do
        read_all(fd, [])
      after
        close(fd)
      end
    end
  end

  defp read_all(fd, acc) do
    case read(fd, 64 * 1024) do
      {:ok, bytes} -> read_all(fd, [bytes | acc])
      :eof -> {:ok, IO.iodata_to_binary(Enum.reverse(acc))}
      error -> error
    end
  end

  def write(path_or_fd, bytes, modes \\ [])
  def write(fd, bytes, []) when is_tuple(fd), do: :file.write(fd, bytes)

  def write(path, bytes, modes) do
    with {:ok, fd} <- open(path, [:write, :binary | modes]) do
      try do
        :file.write(fd, bytes)
      after
        close(fd)
      end
    end
  end

  def write_private(path, bytes, mode \\ 0o600) do
    with {:ok, fd} <- open(path, [:write, :binary, :exclusive]) do
      try do
        with :ok <- chmod(path, mode), do: write(fd, bytes)
      after
        close(fd)
      end
    end
  end

  def write_private!(path, bytes, mode \\ 0o600),
    do: bang(write_private(path, bytes, mode), "write file", path)

  def write_atomic(path, bytes) do
    tmp = path <> ".#{System.unique_integer([:positive])}.tmp"

    try do
      with :ok <- write(tmp, bytes, [:exclusive]), do: rename(tmp, path)
    after
      rm(tmp)
    end
  end

  def stat(path, opts \\ []),
    do: info(:prim_file.read_file_info(path, Keyword.put_new(opts, :time, :universal)))

  def lstat(path, opts \\ []),
    do: info(:prim_file.read_link_info(path, Keyword.put_new(opts, :time, :universal)))

  defp info({:ok, record}), do: {:ok, File.Stat.from_record(record)}
  defp info(error), do: error

  def read_file_info(fd) when is_tuple(fd), do: :file.read_file_info(fd, time: :universal)
  def read_file_info(path), do: :prim_file.read_file_info(path, time: :universal)

  def ls(path) do
    case :prim_file.list_dir(path) do
      {:ok, names} -> {:ok, Enum.map(names, &to_string/1)}
      error -> error
    end
  end

  def read_link(path), do: names(:prim_file.read_link(path))
  def cwd, do: names(:prim_file.get_cwd())
  defp names({:ok, name}), do: {:ok, to_string(name)}
  defp names(result), do: result

  @doc "macOS protected folders are outside autonomous store walks."
  def protected?(path, roots \\ protected_roots()) do
    path = Shuttle.Env.expand(to_string(path))
    Enum.any?(roots, fn root -> path == root or String.starts_with?(path, root <> "/") end)
  end

  defp protected_roots do
    if :os.type() == {:unix, :darwin},
      do: Enum.map(~w(Documents Desktop Downloads), &Path.join(Shuttle.Env.home(), &1)),
      else: []
  end

  def exists?(path), do: match?({:ok, _}, stat(path))
  def dir?(path), do: match?({:ok, %{type: :directory}}, stat(path))
  def regular?(path), do: match?({:ok, %{type: :regular}}, stat(path))
  def mkdir(path), do: :prim_file.make_dir(path)
  defp rmdir(path), do: :prim_file.del_dir(path)
  def rm(path), do: :prim_file.delete(path)
  def rename(source, target), do: :prim_file.rename(source, target)
  def chmod(path, mode), do: :prim_file.write_file_info(path, file_info(mode: mode))

  # A missing parent is created once, then the directory itself is tried once
  # more: some filesystems (Linux procfs) answer ENOENT under a parent that
  # exists, and that answer is final.
  def mkdir_p(path) do
    case mkdir_here(path) do
      {:error, :enoent} -> with :ok <- mkdir_p(Path.dirname(path)), do: mkdir_here(path)
      result -> result
    end
  end

  defp mkdir_here(path) do
    case mkdir(path) do
      {:error, :eexist} -> if dir?(path), do: :ok, else: {:error, :eexist}
      result -> result
    end
  end

  def touch(path) do
    now = :calendar.universal_time()

    case :prim_file.write_file_info(path, file_info(atime: now, mtime: now), time: :universal) do
      {:error, :enoent} -> write(path, "")
      result -> result
    end
  end

  def rm_rf(path) do
    case lstat(path) do
      {:error, :enoent} ->
        {:ok, []}

      {:ok, %{type: :directory}} ->
        with {:ok, names} <- ls(path),
             {:ok, removed} <-
               Enum.reduce_while(names, {:ok, []}, fn name, {:ok, acc} ->
                 case rm_rf(Path.join(path, name)) do
                   {:ok, paths} -> {:cont, {:ok, paths ++ acc}}
                   error -> {:halt, error}
                 end
               end),
             :ok <- rmdir(path),
             do: {:ok, [path | removed]}

      {:ok, _} ->
        with :ok <- rm(path), do: {:ok, [path]}

      {:error, reason} ->
        {:error, reason, path}
    end
  end

  def copy(source, target) do
    with {:ok, input} <- open(source, [:read, :binary]) do
      try do
        with {:ok, output} <- open(target, [:write, :binary]) do
          try do
            :file.copy(input, output)
          after
            close(output)
          end
        end
      after
        close(input)
      end
    end
  end

  def stream!(path, modes \\ [], line_or_bytes \\ :line) do
    modes =
      if Enum.any?(modes, &(&1 == :read_ahead or match?({:read_ahead, _}, &1))),
        do: modes,
        else: [:read_ahead | modes]

    Stream.resource(
      fn -> bang(open(path, [:read, :binary | modes]), "open file", path) end,
      fn fd ->
        result = if line_or_bytes == :line, do: :file.read_line(fd), else: read(fd, line_or_bytes)

        case result do
          {:ok, bytes} -> {[bytes], fd}
          :eof -> {:halt, fd}
          {:error, reason} -> raise File.Error, reason: reason, action: "read file", path: path
        end
      end,
      &close/1
    )
  end

  def wildcard(pattern, opts \\ []) do
    key = {__MODULE__, :match_dot}
    previous = Process.put(key, Keyword.get(opts, :match_dot, false))

    try do
      :filelib.wildcard(String.to_charlist(pattern), Shuttle.FS.Wildcard)
      |> Enum.map(&to_string/1)
    after
      if is_nil(previous), do: Process.delete(key), else: Process.put(key, previous)
    end
  end

  for {name, arity, action} <-
        [read: 1, read_link: 1, cwd: 0, mkdir_p: 1, rm: 1, chmod: 2, rename: 2]
        |> Enum.map(fn {name, arity} ->
          {name, arity, Atom.to_string(name)}
        end) do
    args = Macro.generate_arguments(arity, __MODULE__)

    def unquote(:"#{name}!")(unquote_splicing(args)),
      do: bang(unquote(name)(unquote_splicing(args)), unquote(action), unquote(List.first(args)))
  end

  def write!(path, bytes, modes \\ []), do: bang(write(path, bytes, modes), "write file", path)
  defp bang(:ok, _, _), do: :ok
  defp bang({:ok, value}, _, _), do: value

  defp bang({:error, reason}, action, path),
    do: raise(File.Error, reason: reason, action: action, path: path)
end

defmodule Shuttle.FS.Wildcard do
  @moduledoc false
  defdelegate read_file_info(path), to: :prim_file
  defdelegate read_link_info(path), to: :prim_file

  def list_dir(path) do
    case :prim_file.list_dir(path) do
      {:ok, names} ->
        if Process.get({Shuttle.FS, :match_dot}, false),
          do: {:ok, names},
          else: {:ok, Enum.reject(names, &List.starts_with?(&1, ~c"."))}

      error ->
        error
    end
  end
end
