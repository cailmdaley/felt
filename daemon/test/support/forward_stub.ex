defmodule Shuttle.Test.ForwardStub do
  @moduledoc """
  Arm the owner-routed forward leg with a stub transport for one test.

  Registers a single remote (`name` → `url`) and points `:write_forward_client`
  at this test's instance of a stub client, both in the test's scope
  (`Shuttle.Test.Env`). `client` defaults to the GET stub the body/file reads
  use; the POST suites pass `Shuttle.Test.StubPostClient`.
  """

  alias Shuttle.Test.{Env, StubGetFileClient}

  def stub_forward(remote_name, remote_url, response, client \\ StubGetFileClient) do
    client.start!()
    client.set_response(response)
    Env.put_app_env(:remotes, [%{name: remote_name, url: remote_url}])
    Env.put_app_env(:write_forward_client, client)
  end
end
