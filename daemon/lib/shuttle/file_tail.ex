defmodule Shuttle.FileTail do
  @moduledoc """
  Follow an **append-only** line-oriented file forward from a byte offset.

  This is the read mechanics shared by every in-memory follower of
  `~/.shuttle/events.jsonl` — `Shuttle.WaitingTracker` and
  `Shuttle.SentFiles.Follower`. Each owns its own projection and its own
  offset; this module owns only the bytes: seed once from the whole file, then
  read *only what was appended*, and say so when the file shrank.

  ## Why an offset is sound here

  The stream is append-only between rotations, so the bytes below a given
  offset never change. A projection built from the prefix `0..offset` is
  therefore a pure function of a prefix of ground truth — not a cache that can
  disagree with the file, which is what makes following cheaper than rescanning
  without being less true.

  ## Partial trailing lines are never consumed

  A writer can be mid-line when a poll lands. Both `seed/1` and `advance/2`
  stop at the **last newline** and leave the remainder unconsumed, so the next
  poll re-reads that record whole. Advancing past it would silently drop the
  event; re-reading it costs one short read.

  ## Shrink is the caller's decision

  A file smaller than the offset means truncation or rotation, and what to do
  about it depends on the projection: a last-event-wins map can keep what it
  has, while an index of the file's whole contents must be rebuilt. So
  `advance/2` reports `{:reset, size}` and does not guess. The offset the
  caller adopts is the file's current size, which is where a rebuilt read ends.
  """

  @type offset :: non_neg_integer()

  @doc """
  Every complete line of `path`, plus the offset to resume tailing from.

  A missing or unreadable file is `{[], 0}` — not an error: the follower starts
  empty and picks the file up on a later `advance/2`.
  """
  @spec seed(Path.t()) :: {[String.t()], offset()}
  def seed(path) do
    case File.read(path) do
      {:ok, contents} -> split_complete(contents)
      _ -> {[], 0}
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
    with {:ok, file} <- File.open(path, [:read, :binary]) do
      try do
        :file.position(file, offset)

        case :file.read(file, length) do
          {:ok, data} -> {:ok, data}
          other -> other
        end
      after
        File.close(file)
      end
    end
  end
end
