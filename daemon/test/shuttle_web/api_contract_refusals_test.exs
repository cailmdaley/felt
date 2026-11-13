defmodule ShuttleWeb.ApiContractRefusalsTest do
  use ExUnit.Case, async: true
  import Phoenix.ConnTest
  import Shuttle.Test.ApiConn
  import Shuttle.Test.ApiContract
  alias Shuttle.Test.Env
  @endpoint ShuttleWeb.Endpoint

  # Script the dependency's result, not the controller's wire response: each
  # controller must still select its own status and serialize the refusal.
  defmodule RefusingPoller do
    use GenServer
    def start_link(_), do: GenServer.start_link(__MODULE__, nil)
    def init(state), do: {:ok, state}
    def handle_call({:result, result}, _, _), do: {:reply, :ok, result}
    def handle_call({:capture, _, _}, _, result), do: {:reply, result, result}
    def handle_call({:dispatch, _, _}, _, result), do: {:reply, result, result}
    def handle_call({:kill_session, _}, _, result), do: {:reply, result, result}
  end

  setup do
    poller = Env.start_scoped!({RefusingPoller, []}, Shuttle.Poller)
    {:ok, poller: poller}
  end

  @tag :tmp_dir
  test "capture serializes backend, preflight and internal refusals", %{
    poller: poller,
    tmp_dir: tmp
  } do
    for {result, status} <- [
          {{:error, {:backend_not_ready, "terminal starting"}}, 503},
          {{:error, {:invalid_axes, "effort not supported"}}, 422},
          {{:error, :launch_failed}, 500}
        ] do
      :ok = GenServer.call(poller, {:result, result})

      conn =
        post(
          api_conn(),
          "/api/v1/capture",
          Jason.encode!(%{prompt: "Investigate", project_dir: tmp})
        )

      assert conn.status == status
      assert %{"spawned" => false} = assert_contract(conn, "/capture")
    end
  end

  test "dispatch and delivery serialize all launch refusal status families", %{poller: poller} do
    for {result, status} <- [
          {{:error, {:fiber_not_found, "fiber missing here"}}, 404},
          {{:error, {:launch_reserved, %{"worker" => "worker-1", "reason" => "unconfirmed"}}},
           409},
          {{:error, :no_live_worker}, 422},
          {{:error, {:arm_refused, %{message: "directory needed", needs: "project_dir"}}}, 422},
          {{:error, :launch_failed}, 500},
          {{:error, {:backend_not_ready, "terminal starting"}}, 503},
          {{:error, :poller_busy}, 504}
        ],
        path <- ~w(/dispatch /deliver) do
      :ok = GenServer.call(poller, {:result, result})

      conn =
        post(
          api_conn(),
          "/api/v1" <> path,
          Jason.encode!(%{fiber_id: "work/item", text: "Continue"})
        )

      assert conn.status == status
      assert %{"dispatched" => false} = assert_contract(conn, path)
    end
  end

  test "kill preserves its fiber identity on a backend stop failure", %{poller: poller} do
    :ok = GenServer.call(poller, {:result, {:error, "terminal unavailable"}})
    conn = post(api_conn(), "/api/v1/kill", Jason.encode!(%{fiber_id: "work/item"}))
    assert conn.status == 500

    assert %{"fiber_id" => "work/item", "killed" => false, "error" => "terminal unavailable"} =
             assert_contract(conn, "/kill")
  end
end
