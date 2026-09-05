defmodule Shuttle.ULID do
  @moduledoc """
  Canonical check for whether a string is a felt ULID.

  A ULID is 26 chars of Crockford base32 (`0-9A-HJKMNP-TV-Z` — excluding I, L,
  O, U). Used to distinguish a stable felt `uid` from a path-derived fallback id.
  """

  @ulid_pattern ~r/^[0-9A-HJKMNP-TV-Z]{26}$/

  # The ULID felt embeds as `<leaf>-<ULID>-shuttle` in a worker's tmux session
  # name (Crockford excludes I, L, O, U). The Go side writes that name.
  @ulid_in_tmux ~r/-([0-9A-HJKMNP-TV-Z]{26})-shuttle$/

  @doc "True iff `value` is a 26-char Crockford-base32 ULID."
  @spec valid?(term()) :: boolean()
  def valid?(value) when is_binary(value), do: String.match?(value, @ulid_pattern)
  def valid?(_), do: false

  @doc "The fiber ULID embedded in a `<leaf>-<ULID>-shuttle` tmux session name, else `nil`."
  @spec from_tmux(term()) :: String.t() | nil
  def from_tmux(name) when is_binary(name) do
    case Regex.run(@ulid_in_tmux, name) do
      [_, ulid] -> ulid
      nil -> nil
    end
  end

  def from_tmux(_), do: nil
end
