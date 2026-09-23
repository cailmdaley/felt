defmodule Shuttle.Collaboration do
  @moduledoc """
  Validates and renders optional collaboration pointers carried by a fiber.

  Collaboration is durable document data, not a worker or an execution recipe.
  Each reference names a fiber by intrinsic UID in the shared Felt store. The
  daemon snapshots those pointers when it creates a session ledger row, so later
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

  @doc "The local-store read instructions, or a visible malformed-data error."
  @spec prompt_section(term()) :: String.t()
  @spec prompt_section({:ok, snapshot() | nil} | {:error, String.t()} | term(), String.t() | nil) ::
          String.t()
  def prompt_section(result, store \\ nil)

  def prompt_section({:ok, nil}, _store), do: ""

  def prompt_section({:ok, collaboration}, store) when is_map(collaboration) do
    store_arg = if is_binary(store) and store != "", do: "-C #{shell_quote(store)} ", else: ""

    references =
      @keys
      |> Enum.flat_map(fn key ->
        case Map.get(collaboration, key) do
          %{"uid" => uid} ->
            ["#{key}: felt #{store_arg}show #{uid}"]

          _ ->
            []
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

  def prompt_section({:error, reason}, _store),
    do:
      "Collaboration metadata is invalid (#{reason}); report this in Status before relying on it."

  def prompt_section(_, _store), do: ""

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
