defmodule Shuttle.Test.ReadyCodexBackend do
  @moduledoc "Inert dependency for dispatch fixtures; never starts or probes an operator backend."
  def status, do: %{state: :ready, endpoint: "/isolated-test/control.sock", error: nil}
end
