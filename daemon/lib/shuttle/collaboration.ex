defmodule Shuttle.Collaboration do
  @moduledoc """
  Validates and renders optional collaboration pointers carried by a fiber.

  Collaboration is durable document data, not a worker or an execution recipe.
  Each reference names a fiber by intrinsic UID and owning daemon. The daemon
  snapshots those pointers when it creates a session ledger row, so later
  assignment edits cannot rewrite historical attribution.
  """

  @keys ~w(collaborator role)
  @strict_ulid_pattern ~r/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/
  @origin_pattern ~r/^[a-z0-9][a-z0-9._-]*$/

  @type fiber_ref :: %{required(String.t()) => String.t()}
  @type snapshot :: %{optional(String.t()) => fiber_ref()}

  @spec snapshot(map()) :: {:ok, snapshot() | nil} | {:error, String.t()}
  def snapshot(fiber) when is_map(fiber), do: parse(Map.get(fiber, "collaboration"))

  @spec parse(term()) :: {:ok, snapshot() | nil} | {:error, String.t()}
  def parse(nil), do: {:ok, nil}

  def parse(value) when is_map(value) do
    unknown = Map.keys(value) -- @keys

    cond do
      unknown != [] ->
        {:error, "collaboration has unknown keys: #{Enum.join(unknown, ", ")}"}

      map_size(value) == 0 ->
        {:error, "collaboration must name a collaborator or role"}

      true ->
        Enum.reduce_while(@keys, {:ok, %{}}, fn key, {:ok, acc} ->
          case Map.fetch(value, key) do
            :error ->
              {:cont, {:ok, acc}}

            {:ok, reference} ->
              case parse_reference(key, reference) do
                {:ok, parsed} -> {:cont, {:ok, Map.put(acc, key, parsed)}}
                {:error, _} = error -> {:halt, error}
              end
          end
        end)
    end
  end

  def parse(_), do: {:error, "collaboration must be an object"}

  @doc "The pointer-only prompt section, or a visible malformed-data error."
  @spec prompt_section({:ok, snapshot() | nil} | {:error, String.t()} | term()) :: String.t()
  def prompt_section({:ok, nil}), do: ""

  def prompt_section({:ok, collaboration}) when is_map(collaboration) do
    references =
      @keys
      |> Enum.flat_map(fn key ->
        case Map.get(collaboration, key) do
          %{"uid" => uid, "origin" => origin} ->
            query = URI.encode_query(%{"body" => "true", "origin" => origin})
            ["#{key}: GET /api/v1/fibers/#{uid}?#{query} from the local daemon"]

          _ ->
            []
        end
      end)

    [
      "Collaboration:",
      Enum.join(references, "\n"),
      "For every response, select the matching entry from response.fibers; verify its fiber.uid and response.host both equal the requested UID and origin before using it. Never substitute a local git mirror; report any read, UID, or host mismatch in Status."
    ]
    |> Enum.reject(&(&1 == ""))
    |> Enum.join("\n")
  end

  def prompt_section({:error, reason}),
    do:
      "Collaboration metadata is invalid (#{reason}); report this in Status before relying on it."

  def prompt_section(_), do: ""

  defp parse_reference(key, %{"uid" => uid, "origin" => origin} = reference)
       when map_size(reference) == 2 and is_binary(uid) and is_binary(origin) do
    cond do
      not String.match?(uid, @strict_ulid_pattern) ->
        {:error, "collaboration.#{key}.uid must be a canonical ULID"}

      origin == "local" ->
        {:error, "collaboration.#{key}.origin must name an owning host, not local"}

      not String.match?(origin, @origin_pattern) ->
        {:error, "collaboration.#{key}.origin must be a URL-safe host id"}

      true ->
        {:ok, %{"uid" => uid, "origin" => origin}}
    end
  end

  defp parse_reference(key, _),
    do: {:error, "collaboration.#{key} must contain exactly uid and origin"}
end
