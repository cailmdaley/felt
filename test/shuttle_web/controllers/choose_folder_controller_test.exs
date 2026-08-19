defmodule ShuttleWeb.ChooseFolderControllerTest do
  @moduledoc """
  Wiring for `POST /api/v1/choose-folder` — the native half of the pickers'
  "+ Add project…".

  No test may raise a real dialog: every one of them either forces
  `:folder_picker_mechanism` to `:none` or pins it alongside a
  `:folder_picker_runner` stub, so the mechanism is decided in config and the
  "dialog" is a scripted `{output, status}` tuple.
  """
  use ExUnit.Case
  import Shuttle.Test.EnvHelpers
  import Phoenix.ConnTest
  import Plug.Conn

  @endpoint ShuttleWeb.Endpoint

  alias Shuttle.FolderPicker

  # Stands in for osascript/zenity: records the invocation, replays a scripted
  # result. Same shape as the `:felt_stores_runner` stubs.
  defmodule DialogRunner do
    use Agent
    @behaviour Shuttle.Runner

    def start_link(result),
      do: Agent.start_link(fn -> %{result: result, last: nil} end, name: __MODULE__)

    def last, do: Agent.get(__MODULE__, & &1.last)

    @impl true
    def cmd(command, args, opts) do
      Agent.update(__MODULE__, &Map.put(&1, :last, %{command: command, args: args, opts: opts}))
      Agent.get(__MODULE__, & &1.result)
    end
  end

  # POST transport stub for the write-forward plane.
  defmodule ForwardClient do
    use Agent

    def start_link(response),
      do: Agent.start_link(fn -> %{response: response, last: nil} end, name: __MODULE__)

    def last, do: Agent.get(__MODULE__, & &1.last)

    def post(url, body, _content_type, _timeout_ms) do
      Agent.update(__MODULE__, &Map.put(&1, :last, %{url: url, body: body}))
      Agent.get(__MODULE__, & &1.response)
    end
  end

  setup do
    previous_mechanism = Application.get_env(:shuttle, :folder_picker_mechanism)
    previous_runner = Application.get_env(:shuttle, :folder_picker_runner)
    # Default for every test: no dialog. A test that wants one opts in.
    Application.put_env(:shuttle, :folder_picker_mechanism, :none)

    on_exit(fn ->
      restore_app_env(:folder_picker_mechanism, previous_mechanism)
      restore_app_env(:folder_picker_runner, previous_runner)
    end)

    :ok
  end

  describe "availability" do
    test "no mechanism → 501, so the UI can fall back to /browse" do
      conn = post_choose()

      assert conn.status == 501
      body = Jason.decode!(conn.resp_body)
      assert body["ok"] == false
      assert body["error"] =~ "no native folder picker"
    end

    test "the probe is what the felt-stores origin payload reports" do
      refute FolderPicker.available?()

      Application.put_env(:shuttle, :folder_picker_mechanism, :zenity)
      assert FolderPicker.available?()

      conn = build_conn() |> get("/api/v1/felt-stores")
      body = Jason.decode!(conn.resp_body)
      own = body["host"]
      assert body["origins"][own]["native_folder_picker"] == true
    end

    test "a mechanism that vanished between probe and run reports absence, not a choice" do
      arm(:zenity, {"zenity: command not found", 127})

      conn = post_choose()
      assert conn.status == 501
    end
  end

  describe "choosing" do
    test "the chosen path comes back absolute, trailing slash stripped" do
      arm(:osascript, {"/Users/x/dev/felt/\n", 0})

      conn = post_choose()

      assert conn.status == 200
      assert Jason.decode!(conn.resp_body) == %{"ok" => true, "path" => "/Users/x/dev/felt"}
    end

    test "macOS runs `choose folder` behind an activate, so the dialog comes forward" do
      arm(:osascript, {"/tmp/x\n", 0})
      post_choose()

      last = DialogRunner.last()
      assert last.command == "osascript"
      assert [_flag, script] = last.args
      assert script =~ ~s(tell application "System Events")
      assert script =~ "activate"
      assert script =~ "choose folder"
      # A human is standing there: minutes, not the default command bound.
      assert last.opts[:timeout_ms] >= 60_000
    end

    test "zenity is driven with --file-selection --directory" do
      arm(:zenity, {"/home/x/code\n", 0})
      post_choose()

      assert DialogRunner.last().args == ["--file-selection", "--directory"]
    end
  end

  describe "cancelling" do
    test "a dismissed dialog is a 200 non-error, not a failure" do
      # osascript's cancel: exit 1, "User canceled." on stderr, no path.
      arm(:osascript, {"0:23: execution error: User canceled. (-128)", 1})

      conn = post_choose()

      assert conn.status == 200
      assert Jason.decode!(conn.resp_body) == %{"ok" => false, "cancelled" => true}
    end

    test "zenity's bare exit 1 is a cancel too" do
      arm(:zenity, {"", 1})

      conn = post_choose()
      assert conn.status == 200
      assert Jason.decode!(conn.resp_body)["cancelled"] == true
    end

    test "a dialog nobody ever answered is an error, not a cancel" do
      arm(:osascript, {"osascript timed out after 300000ms", :timeout})

      conn = post_choose()
      assert conn.status == 500
      assert Jason.decode!(conn.resp_body)["error"] =~ "timeout"
    end
  end

  test "a remote origin forwards to the owning daemon, origin stripped" do
    start_supervised!(
      {ForwardClient, {:ok, 200, Jason.encode!(%{"ok" => true, "path" => "/srv/x"})}}
    )

    previous_remotes = Application.get_env(:shuttle, :remotes)
    previous_client = Application.get_env(:shuttle, :write_forward_client)
    Application.put_env(:shuttle, :remotes, [%{name: "candide", url: "http://localhost:4001"}])
    Application.put_env(:shuttle, :write_forward_client, ForwardClient)

    on_exit(fn ->
      restore_app_env(:remotes, previous_remotes)
      restore_app_env(:write_forward_client, previous_client)
    end)

    conn = post_choose(%{"origin" => "candide"})

    assert conn.status == 200
    assert Jason.decode!(conn.resp_body)["path"] == "/srv/x"

    last = ForwardClient.last()
    assert last.url == "http://localhost:4001/api/v1/choose-folder"
    refute Map.has_key?(Jason.decode!(last.body), "origin")
  end

  defp arm(mechanism, result) do
    start_supervised!({DialogRunner, result})
    Application.put_env(:shuttle, :folder_picker_mechanism, mechanism)
    Application.put_env(:shuttle, :folder_picker_runner, DialogRunner)
  end

  defp post_choose(params \\ %{}) do
    build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
    |> post("/api/v1/choose-folder", Jason.encode!(params))
  end
end
