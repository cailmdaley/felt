defmodule Shuttle.Test.HostCapabilityProbeRunner do
  @moduledoc false

  def cmd(command, args, opts) do
    send(self(), {:capability_probe, command, args, opts})
    Process.get(:capability_probe_responses, %{}) |> Map.get(command, {"missing", 127})
  end
end
