defmodule Shuttle.Test.RecorderHTTP do
  import Plug.Conn
  def init(opts), do: opts

  def call(conn, opts) do
    index = Agent.get_and_update(opts[:counter], fn count -> {count, count + 1} end)
    send(opts[:owner], {:start_post, index, conn.method, conn.request_path})

    cond do
      index > 0 ->
        send_resp(conn, 200, "{\"duplicate\":true}")

      conn.request_path == "/retry" ->
        conn |> put_resp_header("retry-after", "0") |> send_resp(503, "{\"error\":\"busy\"}")

      true ->
        conn
        |> put_resp_header("location", "/second")
        |> send_resp(307, "{\"error\":\"redirect\"}")
    end
  end
end

defmodule Shuttle.MeetingTransportTest do
  use ExUnit.Case, async: true
  alias Shuttle.RemoteRegistry.Client.Default

  test "recorder POST transport neither follows redirects nor replays Retry-After responses" do
    for {path, status} <- [{"/redirect", 307}, {"/retry", 503}] do
      counter = start_supervised!({Agent, fn -> 0 end}, id: make_ref())

      server =
        start_supervised!(
          {Bandit,
           plug: {Shuttle.Test.RecorderHTTP, owner: self(), counter: counter},
           ip: {127, 0, 0, 1},
           port: 0}, id: make_ref())

      {:ok, {_, port}} = ThousandIsland.listener_info(server)

      assert {:ok, ^status, _} =
               Default.post_once(
                 "http://127.0.0.1:#{port}#{path}",
                 "{}",
                 "application/json",
                 5_000
               )

      assert_receive {:start_post, 0, "POST", ^path}
      assert Agent.get(counter, & &1) == 1
    end
  end
end
