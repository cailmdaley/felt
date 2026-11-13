defmodule Shuttle.ApiContract do
  @moduledoc """
  The stable tier of the daemon's HTTP API: `contract/shuttle-api.json`, an
  OpenAPI document embedded at compile time so a daemon serves the contract it
  was built with.

  The document's `info.version` is the API level `GET /api/v1/version` reports
  as `api_level`.
  """

  @path Path.expand("../../../contract/shuttle-api.json", __DIR__)
  @external_resource @path
  @json (case Shuttle.FS.read(@path) do
           {:ok, json} -> json
         end)
  @level @json |> Jason.decode!() |> get_in(["info", "version"]) |> String.to_integer()

  @doc "The OpenAPI document as JSON text."
  @spec json() :: String.t()
  def json, do: @json

  @doc "The API level a client states it was built against."
  @spec level() :: pos_integer()
  def level, do: @level
end
