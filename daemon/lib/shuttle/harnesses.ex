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

  # The session ledger spells Claude Code's harness in full.
  @ledger_names %{"claude" => "claude-code"}

  @doc "Return the ledger spelling for a known harness, or nil if unknown."
  @spec ledger_name(String.t() | nil) :: String.t() | nil
  def ledger_name(name) do
    if supported?(name), do: Map.get(@ledger_names, normalize(name), normalize(name))
  end

  @doc "True when name resolves to one of Shuttle's addressable harnesses."
  @spec supported?(String.t()) :: boolean()
  def supported?(name) when is_binary(name), do: normalize(name) in Map.values(@names)
  def supported?(_), do: false
end
