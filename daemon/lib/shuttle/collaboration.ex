defmodule Shuttle.Collaboration do
  @moduledoc """
  Validates optional collaboration assignments carried by a fiber.

  Current assignments map role slugs to ordered collaborator slugs. Empty lists
  assign a role without naming a collaborator. Older UID pointer snapshots are
  still accepted and returned unchanged so historic ledger data remains readable.
  Collaboration records participation; it does not establish who authored a
  session.
  """

  @legacy_keys ~w(collaborator role)
  @slug_pattern ~r/\A[a-z0-9]+(?:-[a-z0-9]+)*\z/
  @strict_ulid_pattern ~r/\A[0-7][0-9A-HJKMNP-TV-Z]{25}\z/
  @origin_pattern ~r/\A[a-z0-9][a-z0-9._-]*\z/
  @type legacy_snapshot :: %{optional(String.t()) => %{required(String.t()) => String.t()}}
  @type assignments :: %{required(String.t()) => [String.t()]}
  @type snapshot :: legacy_snapshot() | assignments()

  @spec snapshot(map()) :: {:ok, snapshot() | nil} | {:error, String.t()}
  def snapshot(fiber) when is_map(fiber), do: parse(Map.get(fiber, "collaboration"))

  @spec parse(term()) :: {:ok, snapshot() | nil} | {:error, String.t()}
  def parse(nil), do: {:ok, nil}

  def parse(value) when is_map(value) and map_size(value) == 0,
    do: {:error, "collaboration must name a role or legacy reference"}

  def parse(value) when is_map(value) do
    if legacy_shape?(value), do: parse_legacy(value), else: parse_assignments(value)
  end

  def parse(_), do: {:error, "collaboration must be an object"}

  defp legacy_shape?(value) do
    Enum.all?(Map.values(value), &is_map/1)
  end

  defp parse_legacy(value) do
    unknown = Map.keys(value) -- @legacy_keys

    cond do
      unknown != [] ->
        {:error, "collaboration has unknown keys: #{Enum.join(unknown, ", ")}"}

      true ->
        Enum.reduce_while(@legacy_keys, {:ok, %{}}, fn key, {:ok, acc} ->
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

  defp parse_assignments(value) do
    Enum.reduce_while(value, {:ok, %{}}, fn {role, collaborators}, {:ok, acc} ->
      cond do
        not valid_slug?(role) ->
          {:halt, {:error, "collaboration role names must be valid slugs"}}

        not is_list(collaborators) ->
          {:halt, {:error, "collaboration.#{role} must be a list of collaborator slugs"}}

        not Enum.all?(collaborators, &valid_slug?/1) ->
          {:halt, {:error, "collaboration.#{role} contains an invalid collaborator slug"}}

        length(collaborators) != length(Enum.uniq(collaborators)) ->
          {:halt, {:error, "collaboration.#{role} contains duplicate collaborator slugs"}}

        true ->
          {:cont, {:ok, Map.put(acc, role, collaborators)}}
      end
    end)
  end

  defp valid_slug?(slug) when is_binary(slug), do: String.match?(slug, @slug_pattern)
  defp valid_slug?(_), do: false

  defp parse_reference(key, %{"uid" => uid} = reference)
       when is_binary(uid) and map_size(reference) in [1, 2] do
    cond do
      Map.keys(reference) -- ["uid", "origin"] != [] ->
        {:error, "collaboration.#{key} must contain only uid and optional origin"}

      not String.match?(uid, @strict_ulid_pattern) ->
        {:error, "collaboration.#{key}.uid must be a canonical ULID"}

      not valid_origin?(Map.get(reference, "origin")) ->
        {:error, "collaboration.#{key}.origin must be an optional normalized host id"}

      true ->
        {:ok, Map.take(reference, ["uid", "origin"])}
    end
  end

  defp parse_reference(key, _),
    do: {:error, "collaboration.#{key} must contain uid and an optional origin"}

  defp valid_origin?(nil), do: true
  defp valid_origin?(""), do: true
  defp valid_origin?("local"), do: false

  defp valid_origin?(origin) when is_binary(origin),
    do: String.match?(origin, @origin_pattern)

  defp valid_origin?(_), do: false
end
