defmodule Shuttle.Test.ForwardStub do
  @moduledoc """
  Arm the owner-routed forward leg with a stub transport for one test.

  Registers a single remote (`name` → `url`) and points `:write_forward_client`
  at a stub client, restoring both in `on_exit`. `client` defaults to the GET
  stub the body/file/astra reads use; the POST suites pass their own.
  """

  import ExUnit.Callbacks
  import Shuttle.Test.EnvHelpers

  alias Shuttle.Test.StubGetFileClient

  def stub_forward(remote_name, remote_url, response, client \\ StubGetFileClient) do
    start_supervised!(client)
    client.set_response(response)

    previous_remotes = Application.get_env(:shuttle, :remotes)
    previous_client = Application.get_env(:shuttle, :write_forward_client)
    Application.put_env(:shuttle, :remotes, [%{name: remote_name, url: remote_url}])
    Application.put_env(:shuttle, :write_forward_client, client)

    on_exit(fn ->
      restore_app_env(:remotes, previous_remotes)
      restore_app_env(:write_forward_client, previous_client)
    end)
  end
end
