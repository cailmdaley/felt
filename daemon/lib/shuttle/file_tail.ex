defmodule Shuttle.FileTail do
  @moduledoc """
  Follow an **append-only** line-oriented file forward from a byte offset.

  These are the read mechanics behind `Shuttle.EventStream`, the one follower
  of `~/.shuttle/events.jsonl`. The stream owns the offset and the
  projections; this module owns only the bytes: snapshot the whole file once,
  then read *only what was appended*, and say so when the file shrank or was
  rotated away.

  Every read opens the file `:raw`, in the calling process. A plain
  `File.read/1` goes through the `file_server_2` process, which then holds the
  whole file's binary until it next collects — 50 MB pinned in a process that
  rarely does.

  ## Why an offset is sound here

  The stream is append-only between rotations, so the bytes below a given
  offset never change. A projection built from the prefix `0..offset` is
  therefore a pure function of a prefix of ground truth — not a cache that can
  disagree with the file, which is what makes following cheaper than rescanning
  without being less true.

  ## Partial trailing lines are never consumed

  A writer can be mid-line when a poll lands. Both `snapshot/1` and `advance/2`
  stop at the **last newline** and leave the remainder unconsumed, so the next
  poll re-reads that record whole. Advancing past it would silently drop the
  event; re-reading it costs one short read.

  ## Shrink is the caller's decision

  A file smaller than the offset means truncation or rotation, and what to do
  about it depends on the caller. So `advance/2` reports `{:reset, size}` and
  does not guess; `size` is where a rebuild from byte 0 ends.

  A rotation renames the followed file and starts a new one at the same path,
  and the new file can outgrow the old offset before anyone notices the
  shrink, so a follower that continues across rotation recognizes it by the
  path's inode moving (`inode/1`) rather than by size, and reads the renamed
  file's last bytes with `drain/2`.
  """

  @type offset :: non_neg_integer()

  @doc """
  Every complete line of `path`, the offset to resume tailing from, and the
  inode the lines were read from — taken from the open file rather than the
  path, so it names the file that was read even when a rotation renames it
  mid-read.

  A missing or unreadable file is `{[], 0, nil}` — not an error: the follower
  starts empty and picks the file up on a later `advance/2`.
  """
  @spec snapshot(Path.t()) :: {[String.t()], offset(), non_neg_integer() | nil}
  def snapshot(path) do
    with {:ok, file} <- :file.open(path, [:read, :binary, :raw]) do
      try do
        with {:ok, info} <- :file.read_file_info(file),
             %File.Stat{inode: inode, size: size} = File.Stat.from_record(info),
             {:ok, contents} <- read_all(file, size) do
          {lines, offset} = split_complete(contents)
          {lines, offset, inode}
        else
          _ -> {[], 0, nil}
        end
      after
        :file.close(file)
      end
    else
      _ -> {[], 0, nil}
    end
  end

  # `size` is the file's size when opened; an append since is picked up by the
  # next `advance/2` like any other.
  defp read_all(_file, 0), do: {:ok, ""}

  defp read_all(file, size) do
    case :file.read(file, size) do
      {:ok, data} -> {:ok, data}
      :eof -> {:ok, ""}
      other -> other
    end
  end

  @doc """
  The complete lines appended to `path` since `offset`.

    * `{:append, lines, new_offset}` — bytes were appended and at least one
      whole line arrived.
    * `{:reset, size}` — the file is smaller than `offset` (truncation or
      rotation). The caller decides whether to rebuild; `size` is the offset a
      rebuild from byte 0 ends at.
    * `:noop` — nothing new, nothing but a partial line, a missing file, or an
      unreadable one.
  """
  @spec advance(Path.t(), offset()) ::
          {:append, [String.t()], offset()} | {:reset, offset()} | :noop
  def advance(path, offset) do
    case File.stat(path) do
      {:ok, %{size: size}} when size > offset -> read_appended(path, offset, size - offset)
      {:ok, %{size: size}} when size < offset -> {:reset, size}
      _ -> :noop
    end
  end

  @doc """
  Every line of a **finished** file from `offset` to its end — the bytes a
  follower had not yet read when the file was rotated away. Nothing appends to
  a rotated file, so an unterminated last line is returned too rather than
  held for a newline that will never come. A missing or unreadable file, or
  an offset at or past its end, is `[]`.
  """
  @spec drain(Path.t(), offset()) :: [String.t()]
  def drain(path, offset) do
    with {:ok, %{size: size}} when size > offset <- File.stat(path),
         {:ok, chunk} <- read_range(path, offset, size - offset) do
      String.split(chunk, "\n", trim: true)
    else
      _ -> []
    end
  end

  @doc """
  The inode of `path`, or `nil` when it does not exist. Rotation moves it; an
  append or a truncation does not.
  """
  @spec inode(Path.t()) :: non_neg_integer() | nil
  def inode(path) do
    case File.stat(path) do
      {:ok, %{inode: inode}} -> inode
      _ -> nil
    end
  end

  defp read_appended(path, offset, length) do
    case read_range(path, offset, length) do
      {:ok, chunk} ->
        case split_complete(chunk) do
          {[], _} -> :noop
          {lines, consumed} -> {:append, lines, offset + consumed}
        end

      _ ->
        :noop
    end
  end

  # The complete lines in `chunk` and how many bytes they occupy — everything
  # up to and including the last newline. No newline at all means nothing is
  # complete.
  defp split_complete(chunk) do
    case :binary.matches(chunk, "\n") do
      [] ->
        {[], 0}

      matches ->
        {last_nl, _} = List.last(matches)
        consumed = last_nl + 1
        lines = chunk |> binary_part(0, consumed) |> String.split("\n", trim: true)
        {lines, consumed}
    end
  end

  defp read_range(path, offset, length) do
    with {:ok, file} <- :file.open(path, [:read, :binary, :raw]) do
      try do
        :file.position(file, offset)

        case :file.read(file, length) do
          {:ok, data} -> {:ok, data}
          other -> other
        end
      after
        :file.close(file)
      end
    end
  end
end
