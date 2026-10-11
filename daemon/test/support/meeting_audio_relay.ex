defmodule Shuttle.Test.MeetingAudioRelay.Recorder do
  @moduledoc false
  @behaviour WebSock
  def init(opts) do
    send(opts[:observer], {:recorder, self(), opts[:launch]})
    {:push, {:text, ~s({"state":"connected"})}, opts}
  end

  def handle_in({"finish", opcode: :text}, opts),
    do: {:stop, :normal, {4409, "another microphone"}, [{:text, ~s({"state":"replaced"})}], opts}

  def handle_in({body, opcode: op}, opts) do
    send(opts[:observer], {:audio, op, body})
    {:push, {op, body}, opts}
  end

  def handle_info(_, opts), do: {:ok, opts}
  def terminate(reason, opts), do: send(opts[:observer], {:recorder_closed, reason})
end

defmodule Shuttle.Test.MeetingAudioRelay.Ingress do
  @moduledoc false
  @behaviour Plug
  def init(opts), do: opts

  def call(conn, opts) do
    conn = Plug.Conn.fetch_query_params(conn)

    case Shuttle.MeetingAudioRelay.route(conn.query_params, opts[:routing]) do
      {:remote, _url} ->
        ShuttleWeb.MeetingAudioController.upgrade(conn, conn.query_params, opts[:routing])

      {:local, launch} ->
        socket = opts[:socket] || Shuttle.Test.MeetingAudioRelay.Recorder
        args = Keyword.put(opts[:socket_opts] || [], :launch, launch)
        conn |> WebSockAdapter.upgrade(socket, args, timeout: 30_000) |> Plug.Conn.halt()

      {:error, reason} ->
        Plug.Conn.send_resp(conn, 409, inspect(reason))
    end
  end
end
