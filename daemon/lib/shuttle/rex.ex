defmodule Shuttle.Rex do
  @moduledoc "Bounded, non-autostarting Rex CLI requests."

  alias Shuttle.Env

  def bin do
    case Env.get("SHUTTLE_REX_BIN") do
      nil ->
        Env.find_executable("rex") ||
          Env.find_executable(
            Path.join(
              Env.home(),
              "Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex"
            )
          )

      path ->
        Env.find_executable(path)
    end
  end

  def flags do
    ["--autostart=false", "--timeout", "5s"] ++
      case Env.app(:rex_server) || Env.get("SHUTTLE_REX_SERVER") do
        nil -> []
        server -> ["-S", server]
      end
  end

  def call(runner, method, args, opts \\ []) do
    session =
      case opts[:session] do
        nil -> []
        sid -> ["-s", sid]
      end

    with {:ok, output} <-
           command(runner, ["api", "call"] ++ session ++ [method, "-"],
             input: Jason.encode!(args) <> "\n",
             input_eof: true
           ),
         {:ok, result} when is_map(result) <- Jason.decode(output) do
      {:ok, result}
    else
      {:error, %Jason.DecodeError{}} -> {:error, {:unknown, "invalid Rex JSON reply"}}
      {:ok, _} -> {:error, {:unknown, "invalid Rex reply shape"}}
      error -> error
    end
  end

  def command(runner, args, opts \\ []) do
    case bin() do
      nil ->
        {:error, {:unknown, "Rex executable not found"}}

      executable ->
        runner.cmd(
          executable,
          flags() ++ args,
          Keyword.merge([stderr_to_stdout: true, timeout_ms: 6_000], opts)
        )
        |> classify()
    end
  end

  def classify({output, 0}), do: {:ok, output}

  def classify({output, status}) when status in [:timeout, :output_limit],
    do: {:error, {:unknown, output}}

  def classify({output, status}) do
    down = String.downcase(output)

    cond do
      status == 4 or
          Enum.any?(
            ["server is not running", "connect: no such file", "connection refused"],
            &String.contains?(down, &1)
          ) ->
        {:error, :server_absent}

      status == 3 or String.contains?(down, "not found") ->
        {:error, :not_found}

      true ->
        {:error, {:unknown, output}}
    end
  end

  @doc "Fork a detached auxiliary command under Rex Server's privacy attribution."
  def run_background(argv, runner) do
    with :ok <- Shuttle.Terminal.Rex.ensure_ready(runner),
         executable when is_binary(executable) <- bin() do
      # Rex keeps empty sessions. Only this newly created session is removed;
      # a matching display label is never permission to reuse or destroy one.
      cleanup =
        Enum.map_join([executable] ++ flags(), " ", &quote_sh/1) <>
          " api call -s \"$REX_SESSION\" session.destroy - <<< '{}' >/dev/null 2>&1"

      exports =
        Enum.map_join(~w(PATH SSH_AUTH_SOCK), "", fn key ->
          case Env.get(key) do
            nil -> "unset #{key}\n"
            value -> "export #{key}=#{quote_sh(value)}\n"
          end
        end)

      command = [
        "/usr/bin/env",
        "-u",
        "REX_SESSION",
        "-u",
        "REX_BLOCK",
        "-u",
        "REX_CLIENT" | argv
      ]

      script =
        "unset TMUX TMUX_PANE\n" <>
          exports <>
          "trap #{quote_sh(cleanup)} EXIT\n" <> Enum.map_join(command, " ", &quote_sh/1) <> "\n"

      spec =
        Shuttle.Terminal.Rex.create_spec("shuttle-tmux-anchor@rex", Env.home(), "")
        |> put_in(["initial_windows", Access.at(0), "layout", "block", "options", "command"], [
          "/bin/bash",
          "-c",
          script
        ])

      case create(runner, spec) do
        {:ok, %{"session_id" => "session:" <> _}} -> :ok
        error -> {:error, "Rex background launch failed: #{inspect(error)}"}
      end
    else
      error -> {:error, "Rex background launch unavailable: #{inspect(error)}"}
    end
  end

  defp quote_sh(text), do: "'" <> String.replace(text, "'", "'\\''") <> "'"

  def whoami(runner), do: json_command(runner, ["whoami", "--json"])

  def sessions(runner),
    do: collection(call(runner, "session.list", %{}), "sessions", "session_id")

  def blocks(runner, sid),
    do: collection(call(runner, "session.list_blocks", %{}, session: sid), "blocks", "block_id")

  def process(runner, sid, bid),
    do:
      call(runner, "com.superlogical.terminal.process", %{"block_id" => bid, "args" => %{}},
        session: sid
      )

  def create(runner, spec), do: call(runner, "session.create", spec)
  def destroy(runner, sid), do: call(runner, "session.destroy", %{}, session: sid)
  def privacy_status(runner), do: call(runner, "server.apple.privacy_status", %{})

  def set_labels(runner, sid, bid, label) do
    with {:ok, _} <- call(runner, "session.set_label", %{"label" => label}, session: sid),
         {:ok, _} <-
           call(runner, "session.set_block_label", %{"block_id" => bid, "label" => label},
             session: sid
           ) do
      :ok
    end
  end

  def paste(runner, sid, bid, text),
    do:
      call(
        runner,
        "block.event",
        %{"block_id" => bid, "event" => %{"type" => "paste", "payload" => %{"text" => text}}},
        session: sid
      )

  def send_key(runner, sid, bid, key),
    do: command(runner, ["send-key", "-s", sid, "-b", bid, key])

  def app_client(runner) do
    with {:ok, %{"clients" => clients}} when is_list(clients) <-
           json_command(runner, ["client", "ls", "--json"]) do
      case Enum.find(clients, &match?(%{"info" => %{"kind" => "app"}}, &1)) do
        %{"client_id" => id} -> {:ok, id}
        nil -> {:error, :not_found}
        _ -> {:error, {:unknown, "invalid Rex client"}}
      end
    else
      {:ok, _} -> {:error, {:unknown, "invalid Rex client list"}}
      error -> error
    end
  end

  def select(runner, client, sid),
    do:
      call(runner, "client.perform", %{
        "client_id" => client,
        "action" => "session.select",
        "args" => %{"session_id" => sid},
        "timeout_ms" => 5_000
      })

  defp json_command(runner, args) do
    with {:ok, output} <- command(runner, args),
         {:ok, result} when is_map(result) <- Jason.decode(output) do
      {:ok, result}
    else
      {:error, %Jason.DecodeError{}} -> {:error, {:unknown, "invalid Rex JSON reply"}}
      {:ok, _} -> {:error, {:unknown, "invalid Rex reply shape"}}
      error -> error
    end
  end

  defp collection({:ok, result}, key, id) do
    case result[key] do
      items when is_list(items) ->
        if Enum.all?(items, &(is_map(&1) and is_binary(&1[id]))),
          do: {:ok, items},
          else: {:error, {:unknown, "invalid Rex #{key}"}}

      _ ->
        {:error, {:unknown, "invalid Rex #{key}"}}
    end
  end

  defp collection(error, _, _), do: error
end
