defmodule Shuttle.Test.FiberUid do
  @moduledoc """
  Deterministic intrinsic ids for test fibers.

  Every dispatchable fiber carries a ULID `uid`. Each launch of its worker
  gets a tmux session `<leaf>-<uuid8>-<uid>-shuttle` (`launch?/2` recognizes
  one). Fixtures that do not care which uid a fiber has take `for/1` of its
  id. `session/1` is the name a worker launched by an earlier build carries,
  `<leaf>-<uid>-shuttle`, for tests that model such a worker.
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

  @doc "The `<leaf>-<uid>-shuttle` session name of `fiber_id` under its `for/1` uid."
  @spec session(String.t()) :: String.t()
  def session(fiber_id), do: session_name(fiber_id, __MODULE__.for(fiber_id))

  @doc "The `<leaf>-<uid>-shuttle` session name of `fiber_id` under `uid`."
  @spec session_name(String.t(), String.t()) :: String.t()
  def session_name(fiber_id, uid), do: leaf(fiber_id) <> "-" <> uid <> "-shuttle"

  @doc "True when `session` names a launch of `fiber_id`'s worker under its `for/1` uid."
  @spec launch?(String.t() | nil, String.t()) :: boolean()
  def launch?(session, fiber_id) when is_binary(session) do
    String.match?(
      session,
      ~r/^#{Regex.escape(leaf(fiber_id))}-[0-9a-f]{8}-#{__MODULE__.for(fiber_id)}-shuttle$/
    )
  end

  def launch?(_session, _fiber_id), do: false

  defp leaf(fiber_id),
    do: fiber_id |> String.trim_trailing("/") |> String.split("/") |> List.last()
end
