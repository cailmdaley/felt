defmodule Shuttle.Test.BootProbe do
  @moduledoc "A diagnostic probe bounded by both a short request ceiling and the gate deadline."

  def request(url, deadline) do
    timeout = (deadline - System.monotonic_time(:millisecond)) |> min(2_000) |> max(1)
    :httpc.request(:get, {url, []}, [timeout: timeout, connect_timeout: timeout], [])
  end
end
