defmodule Shuttle.Terminal.TmuxTest do
  use ExUnit.Case, async: true

  alias Shuttle.Terminal.Tmux
  alias Shuttle.Test.Env

  defmodule Runner do
    def cmd("tmux", ["load-buffer", "-b", buffer, path], _opts) do
      send(self(), {:buffer, buffer, path, File.stat!(path).mode, File.read!(path)})
      {"", 0}
    end

    def cmd("tmux", _args, _opts), do: {"", 0}
  end

  test "paste stages its message in a private unpredictable file and removes it" do
    Env.put_app_env(:paste_submit_delay_ms, 0)
    assert :ok = Tmux.paste(Runner, "worker", "private message")
    assert_received {:buffer, buffer, path, mode, "private message"}
    assert buffer =~ ~r/^shuttle-paste-[0-9a-f]{24}$/
    assert Path.basename(path) == buffer
    assert Bitwise.band(mode, 0o777) == 0o600
    refute File.exists?(path)
  end
end
