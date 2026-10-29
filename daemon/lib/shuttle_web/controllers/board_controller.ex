defmodule ShuttleWeb.BoardController do
  @moduledoc "Host-local board feed."
  use Phoenix.Controller, formats: [:json]

  import ShuttleWeb.RelayHelpers,
    only: [integer_param: 3, json_with_validator: 3, rotating_file_tokens: 1, bad_param: 2]

  alias Shuttle.{Board, EventStream}

  def show(conn, params) do
    with {:ok, since_ms} <- integer_param(params, "since_ms", default: 0) do
      validator = {since_ms, rotating_file_tokens(EventStream.default_events_file())}
      json_with_validator(conn, validator, fn -> %{records: Board.all_since(since_ms)} end)
    else
      {:error, {:bad_param, key}} -> bad_param(conn, key)
    end
  end
end
