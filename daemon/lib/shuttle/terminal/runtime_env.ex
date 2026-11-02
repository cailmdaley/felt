defmodule Shuttle.Terminal.RuntimeEnv do
  @moduledoc "Environment values shared with workers and terminal viewers."

  @names ~w(
    SHUTTLE_HOST
    SHUTTLE_DATA_DIR
    SHUTTLE_LISTEN
    SHUTTLE_AGENTS_FILE
    SHUTTLE_HOST_CONFIG_FILE
    SHUTTLE_REX_BIN
    SHUTTLE_REX_SERVER
    CODEX_HOME
    PATH
    SSH_AUTH_SOCK
    TMUX_TMPDIR
  )

  def values do
    Enum.flat_map(@names, fn name ->
      case Shuttle.Env.get(name) do
        nil -> []
        value -> [{name, value}]
      end
    end)
  end

  def tmux_args do
    configured = Map.new(values())

    Enum.flat_map(@names, fn name ->
      case Map.fetch(configured, name) do
        {:ok, value} -> ["-e", "#{name}=#{value}"]
        :error -> ["-e", name]
      end
    end)
  end

  def script do
    configured = Map.new(values())

    Enum.map_join(@names, "", fn name ->
      case Map.fetch(configured, name) do
        {:ok, value} -> "export #{name}='" <> String.replace(value, "'", "'\\''") <> "'\n"
        :error -> "unset #{name}\n"
      end
    end)
  end
end
