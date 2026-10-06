defmodule Shuttle.Collaboration do
  @moduledoc """
  Validates and renders optional collaboration assignments carried by a fiber.

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

  @doc """
  The collaboration facts for a dispatch prompt: the assigned role and
  collaborator and the shared store their fibers live in, a prompt to take up
  and assign a role when the fiber carries no roster, or a visible
  malformed-data error. A missing snapshot (no fiber context) renders nothing.
  How to read them is the shuttle skill's (`references/collaboration.md`).
  """
  @spec prompt_section({:ok, snapshot() | nil} | {:error, String.t()} | term(), String.t() | nil) ::
          String.t()
  def prompt_section(result, store \\ nil)

  def prompt_section({:ok, nil}, store) do
    "Collaboration: no roster — before substantive work, take up the role that fits " <>
      "(felt find -t role) or create one, and assign it (shuttle assign)" <>
      store_suffix(shared_role_store(store))
  end

  def prompt_section({:ok, assignments}, store) when is_map(assignments) do
    if legacy_shape?(assignments) do
      legacy_prompt_section(assignments, store)
    else
      assignment_prompt_section(assignments, store)
    end
  end

  def prompt_section({:error, reason}, _store),
    do: "Collaboration: invalid metadata (#{reason})"

  def prompt_section(_, _store), do: ""

  defp assignment_prompt_section(assignments, store) do
    assignment =
      case singleton_assignment(assignments) do
        {:ok, role, [collaborator]} -> "#{collaborator} in role #{role}"
        {:ok, role, []} -> "role #{role}, no collaborator named"
        _ -> "several assignments on the roster"
      end

    "Collaboration: #{assignment}" <> store_suffix(shared_role_store(store))
  end

  defp legacy_prompt_section(collaboration, store) do
    references =
      Enum.flat_map(@legacy_keys, fn key ->
        case Map.get(collaboration, key) do
          %{"uid" => uid} -> ["#{key} #{uid}"]
          _ -> []
        end
      end)

    "Collaboration: #{Enum.join(references, ", ")}" <> store_suffix(store)
  end

  defp store_suffix(store) when is_binary(store) and store != "", do: "; role store: #{store}"
  defp store_suffix(_), do: ""

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

  defp singleton_assignment(assignments) when map_size(assignments) == 1 do
    [{role, collaborators}] = Map.to_list(assignments)
    {:ok, role, collaborators}
  end

  defp singleton_assignment(_), do: :multiple

  defp valid_slug?(slug) when is_binary(slug), do: String.match?(slug, @slug_pattern)
  defp valid_slug?(_), do: false

  defp shared_role_store(store) when is_binary(store) and store != "" do
    expanded = Shuttle.Env.expand(store)
    host = if Path.basename(expanded) == ".felt", do: Path.dirname(expanded), else: expanded
    felt_path = Shuttle.FeltStores.store_felt_realpath(host)
    enclosing_felt_parent(felt_path, expanded)
  end

  defp shared_role_store(store), do: store

  defp enclosing_felt_parent(path, fallback) do
    cond do
      Path.basename(path) == ".felt" -> Path.dirname(path)
      Path.dirname(path) == path -> fallback
      true -> enclosing_felt_parent(Path.dirname(path), fallback)
    end
  end

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
