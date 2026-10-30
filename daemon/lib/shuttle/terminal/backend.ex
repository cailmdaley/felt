defmodule Shuttle.Terminal.Backend do
  @moduledoc "Terminal primitives; Shuttle.Terminal owns worker liveness and lifecycle policy."

  @type probe :: :present | :absent | :unknown
  @type runner :: module()

  @callback id() :: String.t()
  @callback available?() :: boolean()
  @callback ensure_ready(runner()) :: :ok | {:error, {atom(), String.t()}}
  @callback launch(runner(), String.t(), String.t(), String.t(), keyword()) ::
              :ok | {:error, String.t()}
  @callback probe(runner(), String.t()) :: probe()
  @callback list(runner()) :: {:ok, [String.t()]} | {:error, :unknown}
  @callback close(runner(), String.t()) :: :ok | :absent | {:error, String.t()}
  @callback paste(runner(), String.t(), String.t()) :: :ok | {:error, String.t()}
  @callback rename(runner(), String.t(), String.t()) :: :ok | {:error, atom()}
  @callback owns_pane?(runner(), String.t(), String.t()) :: boolean()
  @callback identity(runner(), String.t()) :: {:ok, map()} | {:error, :backend_unobservable}
  @callback script(String.t()) :: %{
              wait_for_viewer: String.t(),
              passthrough: String.t(),
              submit_key: String.t(),
              env: String.t()
            }
  @callback unreachable_hint([map()], map()) :: String.t()
end
