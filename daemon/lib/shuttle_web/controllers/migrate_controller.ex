defmodule ShuttleWeb.MigrateController do
  use Phoenix.Controller, formats: [:json]
  import Plug.Conn

  def create(conn, %{"from" => from, "to" => to} = params)
      when is_binary(from) and from != "" and is_binary(to) and to != "" do
    opts = [
      session_id: params["session_id"] || params["session_uuid"],
      tmux_pane: params["tmux_pane"],
      rest: params["rest"] == true,
      disabled: params["disabled"] == true
    ]

    if Enum.all?([opts[:session_id], opts[:tmux_pane]], &(is_nil(&1) or is_binary(&1))) do
      case Shuttle.Poller.migrate(from, to, opts) do
        {:ok, reply} ->
          json(conn, reply)

        {:error, reason} ->
          code =
            case reason do
              atom when is_atom(atom) -> Atom.to_string(atom)
              {atom, _} when is_atom(atom) -> Atom.to_string(atom)
              _ -> "migration_failed"
            end

          conn |> put_status(422) |> json(%{ok: false, reason: code, error: inspect(reason)})
      end
    else
      conn |> put_status(400) |> json(%{ok: false, reason: "invalid_request"})
    end
  end

  def create(conn, _),
    do:
      conn
      |> put_status(400)
      |> json(%{ok: false, reason: "invalid_request", error: "from and to are required"})
end
