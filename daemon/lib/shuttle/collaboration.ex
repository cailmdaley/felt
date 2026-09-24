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

  @doc "The local-store read instructions, or a visible malformed-data error."
  @spec prompt_section(term()) :: String.t()
  @spec prompt_section({:ok, snapshot() | nil} | {:error, String.t()} | term(), String.t() | nil) ::
          String.t()
  def prompt_section(result, store \\ nil)

  def prompt_section({:ok, nil}, _store), do: ""

  def prompt_section({:ok, assignments}, store) when is_map(assignments) do
    if legacy_shape?(assignments) do
      legacy_prompt_section(assignments, store)
    else
      assignment_prompt_section(assignments, store)
    end
  end

  def prompt_section({:error, reason}, _store),
    do:
      "Collaboration metadata is invalid (#{reason}); report this in Status before relying on it."

  def prompt_section(_, _store), do: ""

  defp assignment_prompt_section(assignments, store) do
    role_store = shared_role_store(store)

    store_arg =
      if is_binary(role_store) and role_store != "",
        do: "-C #{shell_quote(role_store)} ",
        else: ""

    case singleton_assignment(assignments) do
      {:ok, role, [collaborator]} ->
        [
          "Collaboration assignment:",
          "You are working as #{collaborator} within the #{role} role.",
          "Read the current role and collaborator fibers after sync:",
          "felt #{store_arg}show roles/#{role}",
          "felt #{store_arg}show roles/#{role}/#{collaborator}"
        ]
        |> Enum.join("\n")

      {:ok, role, []} ->
        [
          "Collaboration assignment:",
          "You are working within the #{role} role; no collaborator is named.",
          "Read its current role fiber after sync: felt #{store_arg}show roles/#{role}."
        ]
        |> Enum.join("\n")

      _ ->
        [
          "Collaboration assignment:",
          "Read the collaboration block; you are the collaborator named for your model, " <>
            "in each role that lists it.",
          "Read global role context from the shared store with `felt #{store_arg}show roles/<role>` " <>
            "and `felt #{store_arg}show roles/<role>/<collaborator>`."
        ]
        |> Enum.join("\n")
    end
  end

  defp legacy_prompt_section(collaboration, store) do
    store_arg = if is_binary(store) and store != "", do: "-C #{shell_quote(store)} ", else: ""

    references =
      @legacy_keys
      |> Enum.flat_map(fn key ->
        case Map.get(collaboration, key) do
          %{"uid" => uid} -> ["#{key}: felt #{store_arg}show #{uid}"]
          _ -> []
        end
      end)

    [
      "Collaboration:",
      Enum.join(references, "\n"),
      "These UIDs resolve in the shared Felt store. Read each referenced fiber after sync and use its current body as context. Optional origin metadata does not change this local-store lookup. If a UID cannot be read, report that in Status."
    ]
    |> Enum.reject(&(&1 == ""))
    |> Enum.join("\n")
  end

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
    expanded = Path.expand(store)
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

  defp shell_quote(value), do: "'" <> String.replace(value, "'", "'\\''") <> "'"
end
