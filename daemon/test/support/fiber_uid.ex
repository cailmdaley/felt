defmodule Shuttle.Test.FiberUid do
  @moduledoc """
  Deterministic intrinsic ids for test fibers.

  Every dispatchable fiber carries a ULID `uid`, and its worker's tmux session
  is `<leaf>-<uid>-shuttle`. Fixtures that do not care which uid a fiber has
  take `for/1` of its id, so a test can name the worker session with
  `session/1` without threading the uid through.
  """

  @crockford ~c"0123456789ABCDEFGHJKMNPQRSTVWXYZ"

  @doc "A stable ULID-shaped uid derived from `fiber_id`."
  @spec for(String.t()) :: String.t()
  def for(fiber_id) when is_binary(fiber_id) do
    <<bits::binary-size(15), _::binary>> = :crypto.hash(:sha256, fiber_id)

    tail =
      for <<chunk::5 <- bits>>, into: "" do
        <<Enum.at(@crockford, chunk)>>
      end

    "01" <> tail
  end

  @doc "The worker session name of `fiber_id` under its `for/1` uid."
  @spec session(String.t()) :: String.t()
  def session(fiber_id), do: Shuttle.Dispatcher.session_name(fiber_id, __MODULE__.for(fiber_id))
end
