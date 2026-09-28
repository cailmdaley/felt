defmodule Shuttle.Harnesses do
  @moduledoc "Canonical address names and compatibility spellings for harnesses."

  # Keep the Go mirror in internal/messaging/harnesses.go aligned through
  # daemon/test/fixtures/harness_names.json.
  @names %{
    "claude" => "claude",
    "claude-code" => "claude",
    "codex" => "codex",
    "pi" => "pi"
  }

  @doc false
  def address_names, do: @names

  @doc "Normalize a known ledger or registry spelling to its address name."
  @spec normalize(String.t()) :: String.t()
  def normalize(name) when is_binary(name), do: Map.get(@names, name, name)

  @doc "Return the ledger spelling for a canonical harness, or nil if unknown."
  @spec ledger_name(String.t() | nil) :: String.t() | nil
  def ledger_name(name) when is_binary(name) do
    canonical = normalize(name)

    if canonical in Map.values(@names) do
      case @names
           |> Enum.filter(fn {spelling, target} -> spelling != target and target == canonical end)
           |> Enum.map(&elem(&1, 0))
           |> Enum.sort()
           |> List.first() do
        nil -> canonical
        ledger_name -> ledger_name
      end
    end
  end

  def ledger_name(_), do: nil

  @doc "True when name resolves to one of Shuttle's addressable harnesses."
  @spec supported?(String.t()) :: boolean()
  def supported?(name) when is_binary(name), do: normalize(name) in Map.values(@names)
  def supported?(_), do: false
end
