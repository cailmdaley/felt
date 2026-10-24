defmodule ShuttleWeb.MigrateControllerTest do
  use ExUnit.Case, async: true
  import Shuttle.Test.ApiConn
  import Phoenix.ConnTest

  alias Shuttle.Test.Env
  @endpoint ShuttleWeb.Endpoint

  defmodule RefusingPoller do
    use GenServer
    def start_link(reason), do: GenServer.start_link(__MODULE__, reason)
    @impl true
    def init(reason), do: {:ok, reason}
    @impl true
    def handle_call({:migrate, "source", "destination", _opts}, _from, reason),
      do: {:reply, {:error, reason}, reason}
  end

  for {reason, fix} <- [
        not_installed: "shuttle install <fiber> --disabled",
        already_running: "migrate that worker elsewhere",
        other_host: "owning host",
        same_fiber: "different destination",
        surface_unsupported: "native session ID",
        not_running: "--from",
        identity_mismatch: "source worker",
        invalid_options: "only one",
        not_found: "exact ID or UID",
        uid_missing: "felt backfill-ids",
        rename_failed: "tmux server",
        document_conflict: "concurrent edits"
      ] do
    test "#{reason} gives a corrective action" do
      reason = unquote(reason)
      Env.start_scoped!({RefusingPoller, reason}, Shuttle.Poller)

      conn =
        api_conn() |> post("/api/v1/migrate", Jason.encode!(%{from: "source", to: "destination"}))

      assert conn.status == 422

      assert %{"ok" => false, "reason" => code, "error" => message} =
               Jason.decode!(conn.resp_body)

      assert code == Atom.to_string(reason)
      assert message =~ unquote(fix)
    end
  end

  for reason <- [:rollback_failed, :reconciliation_required, :recovery_failed] do
    test "#{reason} reports uncertainty and preserves recovery evidence" do
      reason = unquote(reason)
      Env.start_scoped!({RefusingPoller, {reason, :fixture}}, Shuttle.Poller)

      conn =
        api_conn() |> post("/api/v1/migrate", Jason.encode!(%{from: "source", to: "destination"}))

      assert conn.status == 503

      assert %{"ok" => false, "reason" => code, "error" => message} =
               Jason.decode!(conn.resp_body)

      assert code == Atom.to_string(reason)
      assert message =~ "keep the journal and surviving worker"
      assert message =~ "restart the daemon"
    end
  end

  test "missing source or destination is rejected before invoking the Poller" do
    conn = api_conn() |> post("/api/v1/migrate", Jason.encode!(%{from: "source"}))
    assert conn.status == 400

    assert %{"reason" => "invalid_request", "error" => "from and to are required"} =
             Jason.decode!(conn.resp_body)
  end
end
