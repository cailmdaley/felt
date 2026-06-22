defmodule Shuttle.ULID do
  @moduledoc """
  Canonical check for whether a string is a felt ULID.

  A ULID is 26 chars of Crockford base32 (`0-9A-HJKMNP-TV-Z` — excluding I, L,
  O, U). Used to distinguish a stable felt `uid` from a path-derived fallback id.
  """

  @ulid_pattern ~r/^[0-9A-HJKMNP-TV-Z]{26}$/

  @doc "True iff `value` is a 26-char Crockford-base32 ULID."
  @spec valid?(term()) :: boolean()
  def valid?(value) when is_binary(value), do: String.match?(value, @ulid_pattern)
  def valid?(_), do: false
end
