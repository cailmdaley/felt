defmodule ShuttleWeb.RouterBoundary do
  @moduledoc """
  Renders dependency-call timeouts and unavailable OTP servers as JSON 503s.

  Only `GenServer.call` timeout/noproc exits are handled, including exits
  wrapped by Plug. Other failures keep their ordinary error handling. The
  request deadline's untrappable kill closes the connection without a response.
  A mutation may finish after its caller times out; a 503 is not a rollback.
  """

  import Plug.Conn

  def init(opts) do
    plug = Keyword.get(opts, :plug, ShuttleWeb.Router)
    {plug, plug.init(Keyword.get(opts, :plug_opts, []))}
  end

  def call(conn, {plug, opts}) do
    plug.call(conn, opts)
  rescue
    error in Shuttle.FileAccess.Error ->
      if response_started?(conn),
        do: reraise(error, __STACKTRACE__),
        else: filesystem_unavailable(conn, error)

    error in Plug.Conn.WrapperError ->
      cond do
        response_started?(error.conn) ->
          reraise error, __STACKTRACE__

        error.kind == :exit and dependency_exit?(error.reason) ->
          unavailable(error.conn)

        match?(%Shuttle.FileAccess.Error{}, error.reason) ->
          filesystem_unavailable(error.conn, error.reason)

        true ->
          reraise error, __STACKTRACE__
      end
  catch
    :exit, reason ->
      if dependency_exit?(reason) and not response_started?(conn) do
        unavailable(conn)
      else
        :erlang.raise(:exit, reason, __STACKTRACE__)
      end
  end

  defp dependency_exit?({reason, {GenServer, :call, _args}}) when reason in [:timeout, :noproc],
    do: true

  defp dependency_exit?(_reason), do: false

  defp response_started?(%{state: state}) when state in [:sent, :chunked, :upgraded], do: true

  defp response_started?(_conn) do
    receive do
      {:plug_conn, :sent} = sent ->
        send(self(), sent)
        true
    after
      0 -> false
    end
  end

  defp filesystem_unavailable(conn, error) do
    conn
    |> put_resp_content_type("application/json")
    |> put_resp_header("cache-control", "no-store")
    |> send_resp(
      Plug.Exception.status(error),
      Jason.encode!(%{error: Exception.message(error), reason: error.reason})
    )
    |> halt()
  end

  defp unavailable(conn) do
    conn
    |> put_resp_content_type("application/json")
    |> send_resp(503, Jason.encode!(%{error: "dependency unavailable or timed out"}))
    |> halt()
  end
end
