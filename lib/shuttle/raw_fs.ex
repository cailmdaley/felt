defmodule Shuttle.RawFS do
  @moduledoc """
  Filesystem primitives that do not go through the OTP file server.

  Elixir's `File.*` functions are client calls to `:file_server_2`, a single
  GenServer shared by the whole VM. That is invisible until one call blocks —
  and the paths this daemon is pointed at block for human-scale durations. A
  felt store in iCloud Drive or `~/Library/CloudStorage` sits behind macOS's TCC
  layer, where the first reach raises a consent dialog and the syscall does not
  return until somebody clicks it.

  While that one call is out, `:file_server_2` is executing it, and **every**
  other `File.ls/1`, `File.dir?/1`, `File.stat/1`, `File.lstat/1` and
  `File.read/1` in the VM is a message sitting in its mailbox. So is
  `System.find_executable/1`, which is how `Shuttle.Runner` locates `felt` and
  `tmux`. Measured with a writer-less FIFO — one blocked reader, everything
  above stalls indefinitely; see the fiber
  `professional-open-source/idea-discovery-off-the-poller-process/finding-one-blocked-file-call-wedges-the-vm`.

  This matters more than it looks, because it defeats the obvious defence.
  Moving a slow filesystem call into a throwaway task (`Shuttle.BoundedIO`)
  bounds the *caller*, but if the call is a `File.*` the work still happens on
  the one process everybody shares — the isolation is nominal. Only a call that
  bypasses the file server is actually isolated.

  `:prim_file` and the `:raw` option on `:file` do bypass it: they run the NIF
  on the calling process, dispatched to a dirty IO scheduler. Same measurement,
  same wedged path, 0 ms.

  ## The remaining ceiling

  Dirty IO schedulers are finite — `#{:erlang.system_info(:dirty_io_schedulers)}`
  on this machine, ten on a typical one. Nine concurrently blocked raw calls
  cost nothing measurable; the tenth wedges every filesystem call in the VM
  again. So raw is not free, it is *ten times* free, and callers must treat a
  blocked probe as a consumed unit of a small budget: never re-issue a probe
  that has not come back. `Shuttle.FeltStores` caps concurrent scans for exactly
  this reason.

  Only the calls this daemon makes on stall-exposed paths are wrapped. Code
  reading its own installation, or a path under `~/.shuttle`, has no reason to
  prefer these over `File.*` — but note that the protection is only as good as
  its weakest call site: ONE `File.*` on a stalled path re-wedges the file
  server for everybody, and most of the daemon's read endpoints (`/activity`,
  `/sessions`, `/spend`, `/commits`, `/sent-files`) read daemon-owned files
  through `File.*` and stop answering when that happens. They are not the leak;
  they are what a leak costs.
  """

  @type stat :: %{
          type: :device | :directory | :other | :regular | :symlink,
          size: non_neg_integer(),
          mtime: integer()
        }

  @doc """
  Directory entries as binaries, `{:ok, names}` or `{:error, posix}`.

  Same shape and same names as `File.ls/1` — the charlists `:prim_file` returns
  carry the native name encoding and `List.to_string/1` reproduces exactly what
  the file server's own conversion produces.
  """
  @spec ls(Path.t()) :: {:ok, [binary()]} | {:error, :file.posix()}
  def ls(path) do
    case :prim_file.list_dir(binary(path)) do
      {:ok, names} -> {:ok, Enum.map(names, &List.to_string/1)}
      {:error, reason} -> {:error, reason}
    end
  end

  @doc "`File.stat/1` (symlinks followed) without the file server."
  @spec stat(Path.t()) :: {:ok, stat()} | {:error, :file.posix()}
  def stat(path), do: path |> :file.read_file_info(raw_opts()) |> to_stat()

  @doc "`File.lstat/1` (symlinks not followed) without the file server."
  @spec lstat(Path.t()) :: {:ok, stat()} | {:error, :file.posix()}
  def lstat(path), do: path |> :file.read_link_info(raw_opts()) |> to_stat()

  @doc "`File.dir?/1` without the file server."
  @spec dir?(Path.t()) :: boolean()
  def dir?(path), do: match?({:ok, %{type: :directory}}, stat(path))

  @doc "`File.regular?/1` without the file server."
  @spec regular?(Path.t()) :: boolean()
  def regular?(path), do: match?({:ok, %{type: :regular}}, stat(path))

  @doc "`File.exists?/1` without the file server."
  @spec exists?(Path.t()) :: boolean()
  def exists?(path), do: match?({:ok, _}, stat(path))

  @doc "`File.read/1` without the file server."
  @spec read(Path.t()) :: {:ok, binary()} | {:error, :file.posix()}
  def read(path), do: :prim_file.read_file(binary(path))

  @doc """
  `File.write/2` without the file server.
  """
  @spec write(Path.t(), iodata()) :: :ok | {:error, :file.posix()}
  def write(path, contents) do
    # Flattened HERE, not handed to `:prim_file` as iodata, because
    # `:prim_file.write_file/2` opens (and therefore truncates) before it
    # validates: bad iodata leaves an emptied file where `File.write/2` returns
    # `{:error, :badarg}` with the file untouched. The copy is the price of that
    # ordering.
    :prim_file.write_file(binary(path), IO.iodata_to_binary(contents))
  end

  @doc """
  `File.mkdir_p/1` without the file server — creates missing parents, `:ok` when
  the directory already exists.

  One divergence, in the two cases that mean "the path you named is not a
  directory and never will be" — a regular file, or a dangling symlink:
  `File.mkdir_p/1` reports `:enotdir` where this reports `:eexist`. Both refuse,
  which is what callers act on, but an operator reading the message sees "file
  already exists" rather than "not a directory".
  """
  @spec mkdir_p(Path.t()) :: :ok | {:error, :file.posix()}
  def mkdir_p(path), do: path |> binary() |> do_mkdir_p()

  # `File.mkdir_p/1`'s own algorithm, transcribed onto `:prim_file`: exists-first,
  # then create the parent, then create this one and treat `:eexist` on a
  # directory as success. Transcribed rather than reinvented so the error atoms
  # match — a component that is a regular file has to fail the way the caller's
  # rescue clauses already expect it to.
  defp do_mkdir_p("/"), do: :ok

  defp do_mkdir_p(path) do
    if dir?(path) do
      :ok
    else
      parent = Path.dirname(path)

      if parent == path do
        {:error, :einval}
      else
        _ = do_mkdir_p(parent)

        case :prim_file.make_dir(path) do
          {:error, :eexist} = error -> if dir?(path), do: :ok, else: error
          other -> other
        end
      end
    end
  end

  @doc """
  `File.rename/2` without the file server.
  """
  @spec rename(Path.t(), Path.t()) :: :ok | {:error, :file.posix()}
  def rename(source, destination),
    do: :prim_file.rename(binary(source), binary(destination))

  @doc """
  `:file.read_link/1` without the file server — the symlink's target, verbatim.
  """
  @spec read_link(Path.t()) :: {:ok, binary()} | {:error, :file.posix()}
  def read_link(path) do
    case :prim_file.read_link(binary(path)) do
      {:ok, target} -> {:ok, List.to_string(target)}
      {:error, reason} -> {:error, reason}
    end
  end

  @doc """
  `System.find_executable/1` without the file server.

  `System.find_executable/1` is `:os.find_executable/1`, which stats every `PATH`
  entry through the file server — so a wedged store stops the daemon shelling
  `felt` or `tmux` at all, on whichever process asked. This walks `PATH` with raw
  stats instead.

  Deliberately not memoized, though the temptation is real: `PATH` is live state
  the test suite and the operator both rewrite (stub `felt` binaries shimmed
  ahead of the real one, an upgrade that relocates it), and a cached answer
  would quietly outlive the change. A handful of raw stats per shell-out is what
  `System.find_executable/1` cost anyway; the fix is the raw, not a cache.

  Spawning the port is unaffected — `Port.open({:spawn_executable, …})` with an
  absolute path answers normally through a wedged file server, which is why
  resolving the path raw is the whole fix.

  Parity includes the surprising case: `:os.find_executable/1` joins a RELATIVE
  name onto each `PATH` entry whether or not it contains a slash, so
  `"./bin/tool"` resolves against `PATH`, not against the current directory, and
  normally comes back `nil`. An earlier version of this function expanded such a
  name against the daemon's cwd instead — more permissive than the thing it
  replaces, which in a command name that comes from an agent registry means
  executing a binary the stock resolver would have refused to find.
  """
  @spec find_executable(binary()) :: binary() | nil
  def find_executable(command) when is_binary(command) do
    if Path.type(command) == :relative do
      System.get_env("PATH", "") |> path_entries() |> first_executable(command)
    else
      if executable?(command), do: command
    end
  end

  # An EMPTY `PATH` element means the current directory, both in POSIX and in
  # `:os.find_executable/1` (`os.erl` rewrites `[]` to `"."`), so `PATH=":/usr/bin"`
  # searches the cwd first. Splitting with `trim: true` would silently drop it and
  # make this resolver stricter than the one it replaces — which fails to find
  # `felt` where the stock one finds it.
  defp path_entries(path) do
    path
    |> String.split(":")
    |> Enum.map(fn
      "" -> "."
      dir -> dir
    end)
  end

  # `:filename.join/2` rather than `Path.join/2`: it collapses the repeated and
  # trailing separators a hand-edited `PATH` carries, so the returned string is
  # the one `:os.find_executable/1` would have returned rather than merely a path
  # to the same file.
  defp first_executable(dirs, command) do
    Enum.find_value(dirs, fn dir ->
      candidate = :filename.join(dir, command)
      if executable?(candidate), do: candidate
    end)
  end

  # Regular (or a symlink to one) and carrying any execute bit. The `file_info`
  # record is positional: 1 size, 2 type, 3 access, 4 atime, 5 mtime, 6 ctime,
  # 7 mode. 0o111 is user/group/other execute.
  defp executable?(path) do
    case :file.read_file_info(path, raw_opts()) do
      {:ok, info} ->
        elem(info, 2) == :regular and Bitwise.band(elem(info, 7), 0o111) != 0

      _ ->
        false
    end
  end

  defp raw_opts, do: [{:time, :posix}, :raw]

  # The `file_info` record is positional: 1 size, 2 type, 3 access, 4 atime,
  # 5 mtime. `mtime` is posix seconds because `raw_opts/0` asks for `:posix`.
  defp to_stat({:ok, info}),
    do: {:ok, %{type: elem(info, 2), size: elem(info, 1), mtime: elem(info, 5)}}

  defp to_stat({:error, reason}), do: {:error, reason}

  # Paths go to `:prim_file` as BINARIES, never charlists. `String.to_charlist/1`
  # raises `UnicodeConversionError` on a name that is not valid UTF-8 — a latin-1
  # filename on Linux — where `File.*` returns an error tuple and lets the caller
  # decide. These functions are drop-in replacements, so they must fail the way
  # the thing they replace fails: `Shuttle.FiberDoc.read_path/1` runs on the
  # Poller process over paths that come from felt's JSON, and a raise there is a
  # crashed GenServer rather than a logged read error.
  defp binary(path), do: IO.chardata_to_string(path)
end
