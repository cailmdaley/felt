defmodule Shuttle.VoiceExitTest do
  use ExUnit.Case, async: true

  test "a helper port's normal exit does not stop Voice" do
    state = %{task: nil}

    assert {:noreply, ^state} =
             Shuttle.Voice.handle_info(
               {:EXIT, :erlang.list_to_port(~c"#Port<0.1>"), :normal},
               state
             )
  end
end
