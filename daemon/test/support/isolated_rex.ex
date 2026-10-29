defmodule Shuttle.Test.IsolatedRex do
  @moduledoc "A test-owned Rex server; no requests or signals reach the operator's server."

  alias Shuttle.{Rex, Test.Env}
  import ExUnit.Assertions
  import ExUnit.Callbacks, only: [on_exit: 1]

  def start(data_dir) do
    root = Path.join(System.tmp_dir!(), "rex-test-#{System.unique_integer([:positive])}")
    File.mkdir_p!(root)
    endpoint = "unix://#{root}/rex.sock"
    Env.put_app_env(:rex_server, endpoint)
    Env.put_env("SHUTTLE_REX_SERVER", endpoint)
    Env.put_env("SHUTTLE_DATA_DIR", data_dir)

    env =
      for key <- ~w(HOME PATH SHELL LANG SSH_AUTH_SOCK),
          value = Shuttle.Env.get(key),
          value != nil,
          do: "#{key}=#{value}"

    port =
      Port.open({:spawn_executable, "/usr/bin/env"}, [
        :binary,
        :exit_status,
        :stderr_to_stdout,
        args:
          ["-i" | env] ++
            [
              Rex.bin(),
              "server",
              "run",
              "--listen",
              endpoint,
              "--state-dir",
              "#{root}/state",
              "--max-sessions",
              "8"
            ]
      ])

    {:os_pid, pid} = Port.info(port, :os_pid)

    on_exit(fn ->
      System.cmd("kill", ["-TERM", to_string(pid)], stderr_to_stdout: true)
      File.rm_rf!(root)
    end)

    await(fn -> match?({:ok, _}, Rex.whoami(Shuttle.Runner.Default)) end)
    root
  end

  def await(fun, remaining \\ 100)
  def await(fun, 0), do: assert(fun.(), "isolated Rex observation did not arrive")

  def await(fun, remaining) do
    if fun.() do
      :ok
    else
      Process.sleep(50)
      await(fun, remaining - 1)
    end
  end
end
