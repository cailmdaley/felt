defmodule Shuttle.Realpath do
  @moduledoc """
  Hand-rolled symlink-resolving realpath, segment by segment.

  Resolves a path to its physical location, following symlinks along every
  segment so that an ownership prefix matches felt's symlink-resolved `path`.
  Each segment is probed with `:file.read_link`; a segment that isn't a symlink
  falls back to `Path.expand`. `@max_symlink_hops` bounds the resolution so a
  symlink loop returns `{:error, :symlink_loop}` rather than spinning.

  Self-contained on purpose (no OS `realpath` shell-out, no cross-module
  dependency) so both the poller's ownership-prefix derivation and felt-store
  resolution share one canonical implementation with identical edge-case
  behavior.
  """

  @max_symlink_hops 40

  @doc """
  Resolve `path` to its symlink-followed physical location.

  Returns `{:ok, resolved}` or `{:error, reason}` (`:empty_path`,
  `:empty_target`, or `:symlink_loop`).
  """
  @spec resolve(Path.t()) :: {:ok, String.t()} | {:error, atom()}
  def resolve(path) do
    case Path.split(Path.expand(path)) do
      ["/" | rest] -> resolve_segments("/", rest, 0)
      [first | rest] -> resolve_segments(first, rest, 0)
      [] -> {:error, :empty_path}
    end
  end

  defp resolve_segments(current, [], _hops), do: {:ok, current}

  defp resolve_segments(_current, _segments, hops) when hops > @max_symlink_hops,
    do: {:error, :symlink_loop}

  defp resolve_segments(current, [segment | rest], hops) do
    candidate = Path.join(current, segment)

    case :file.read_link(String.to_charlist(candidate)) do
      {:ok, target} ->
        target_path = List.to_string(target)

        expanded_target =
          case Path.type(target_path) do
            :absolute -> Path.expand(target_path)
            _ -> Path.expand(target_path, Path.dirname(candidate))
          end

        case Path.split(expanded_target) do
          ["/" | target_rest] -> resolve_segments("/", target_rest ++ rest, hops + 1)
          [first | target_rest] -> resolve_segments(first, target_rest ++ rest, hops + 1)
          [] -> {:error, :empty_target}
        end

      {:error, _} ->
        resolve_segments(candidate, rest, hops)
    end
  end
end
