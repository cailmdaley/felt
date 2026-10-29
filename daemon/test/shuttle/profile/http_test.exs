defmodule Shuttle.Profile.HTTPTest do
  use ExUnit.Case, async: false

  alias Shuttle.Profile.HTTP

  @start [:phoenix, :endpoint, :start]
  @stop [:phoenix, :endpoint, :stop]

  test "groups endpoint events by route, peer and status and reports request reductions" do
    parent = self()
    unrelated_id = {__MODULE__, make_ref()}

    :ok =
      :telemetry.attach(
        unrelated_id,
        @start,
        fn _, _, _, pid -> send(pid, :unrelated) end,
        parent
      )

    {:ok, profile} = HTTP.start()

    conn =
      conn(
        "/items/:id",
        "GET",
        200,
        {127, 0, 0, 1},
        [{"x-forwarded-for", "203.0.113.9, 10.0.0.2"}],
        %{"shuttle" => "true"}
      )

    :telemetry.execute(@start, %{system_time: System.system_time()}, %{conn: conn})
    assert_receive :unrelated
    _ = Enum.sum(1..10_000)

    :telemetry.execute(@stop, %{duration: System.convert_time_unit(12, :millisecond, :native)}, %{
      conn: %{conn | status: 201}
    })

    result = HTTP.finish(profile)

    assert [
             %{
               "method" => "GET",
               "route" => "/items/:id",
               "shuttle" => true,
               "remote_ip" => "127.0.0.1",
               "forwarded_for_untrusted" => "203.0.113.9, 10.0.0.2",
               "status" => 201,
               "count" => 1,
               "duration_ms" => duration,
               "reductions" => reductions
             }
           ] = result["groups"]

    assert duration == 12.0
    assert reductions > 0
    assert result["dropped"] == 0
    assert :telemetry.list_handlers(@start) |> Enum.any?(&(&1.id == unrelated_id))
    refute :telemetry.list_handlers(@start) |> Enum.any?(&(&1.id == profile.id))
    :telemetry.detach(unrelated_id)
  end

  test "unmatched stop is ignored and group overflow remains bounded" do
    {:ok, profile} = HTTP.start()
    conn = conn("/unmatched", "GET", 404, {127, 0, 0, 1}, [], %{})
    :telemetry.execute(@stop, %{duration: 1}, %{conn: conn})

    for index <- 1..257 do
      route = "/route/#{index}"
      request = %{conn | private: %{phoenix_route: route}}
      :telemetry.execute(@start, %{}, %{conn: request})
      :telemetry.execute(@stop, %{duration: 1}, %{conn: request})
    end

    result = HTTP.finish(profile)
    assert length(result["groups"]) == 256
    assert result["overflow"] == 2
  end

  test "owner death detaches the handler" do
    parent = self()

    owner =
      spawn(fn ->
        {:ok, profile} = HTTP.start()
        send(parent, {:profile, profile})
        receive do: (:stop -> :ok)
      end)

    assert_receive {:profile, profile}
    assert Enum.any?(:telemetry.list_handlers(@start), &(&1.id == profile.id))
    Process.exit(owner, :kill)

    assert eventually(fn ->
             not Enum.any?(:telemetry.list_handlers(@start), &(&1.id == profile.id))
           end)
  end

  defp conn(route, method, status, ip, headers, params) do
    %Plug.Conn{
      method: method,
      status: status,
      remote_ip: ip,
      req_headers: headers,
      params: params,
      private: %{phoenix_route: route}
    }
  end

  defp eventually(fun, attempts \\ 50)
  defp eventually(fun, 0), do: fun.()

  defp eventually(fun, attempts) do
    if fun.(),
      do: true,
      else:
        (
          Process.sleep(10)
          eventually(fun, attempts - 1)
        )
  end
end
