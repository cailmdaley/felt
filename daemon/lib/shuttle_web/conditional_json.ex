defmodule ShuttleWeb.ConditionalJSON do
  @moduledoc """
  Sends JSON with a weak semantic validator. For composite feeds, `generated_at`
  is observation metadata rather than content and is excluded from the hash; a
  304 means the fiber content is unchanged, so clients retain their copy and
  track poll time themselves.
  """

  import Plug.Conn

  def send(conn, body) do
    encoded = Jason.encode!(body)
    validator_body = Map.delete(body, :generated_at) |> Jason.encode!()
    etag = "W/\"" <> (:crypto.hash(:sha256, validator_body) |> Base.encode16(case: :lower)) <> "\""

    conn =
      conn
      |> put_resp_header("etag", etag)
      |> put_resp_header("cache-control", "no-cache")

    if get_req_header(conn, "if-none-match")
       |> Enum.flat_map(&String.split(&1, ","))
       |> Enum.any?(fn candidate -> String.trim(candidate) == etag end) do
      send_resp(conn, 304, "")
    else
      conn
      |> put_resp_content_type("application/json")
      |> send_resp(200, encoded)
    end
  end
end
