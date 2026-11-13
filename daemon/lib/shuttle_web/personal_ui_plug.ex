defmodule ShuttleWeb.PersonalUIPlug do
  @moduledoc "Serves personal UI folders from the Shuttle configuration directory."

  import Plug.Conn

  @static Plug.Static.init(at: "/ui", from: {__MODULE__, :directory, []})

  def directory, do: Shuttle.Env.expand("~/.config/shuttle/ui")

  def init(opts), do: opts

  def call(%{method: method, path_info: ["ui", name | rest]} = conn, _opts)
      when method in ["GET", "HEAD"] do
    cond do
      rest == [] and not String.ends_with?(conn.request_path, "/") ->
        location = conn.request_path <> "/" <> query_suffix(conn.query_string)
        conn |> put_resp_header("location", location) |> send_resp(302, "") |> halt()

      true ->
        path_info = if rest == [], do: ["ui", name, "index.html"], else: conn.path_info
        result = Plug.Static.call(%{conn | path_info: path_info}, @static)

        if result.halted do
          result
        else
          conn |> send_resp(404, "Not Found") |> halt()
        end
    end
  end

  def call(conn, _opts), do: conn

  defp query_suffix(""), do: ""
  defp query_suffix(query), do: "?" <> query
end
