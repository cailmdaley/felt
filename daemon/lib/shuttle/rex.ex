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

  def macos?, do: (Env.app(:os_type) || :os.type()) == {:unix, :darwin}

  def server do
    case Env.get("SHUTTLE_REX_SERVER") do
      value when value in [nil, ""] ->
        Env.app(:rex_server) ||
          if(!macos?(), do: "unix://" <> Path.join(Shuttle.data_dir(), "rex/server.sock"))

      endpoint ->
        endpoint
    end
  end

  @doc "CLI flags for `server`: this host's server by default, else another host's by its Rex label."
  def flags(server \\ server()) do
    ["--autostart=false", "--timeout", "5s"] ++
      case server do
        nil -> []
        endpoint -> ["-S", endpoint]
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
             input_eof: true,
             server: Keyword.get_lazy(opts, :server, &server/0)
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
    {server, opts} = Keyword.pop_lazy(opts, :server, &server/0)

    case bin() do
      nil ->
        {:error, {:unknown, "Rex executable not found"}}

      executable ->
        runner.cmd(
          executable,
          flags(server) ++ args,
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

  @doc "Export the daemon's worker and transport environment into a Rex block."
  def environment_script, do: Shuttle.Terminal.RuntimeEnv.script()

  def whoami(runner), do: json_command(runner, ["whoami", "--json"])

  def sessions(runner, opts \\ []),
    do: collection(call(runner, "session.list", %{}, opts), "sessions", "session_id")

  def blocks(runner, sid),
    do: collection(call(runner, "session.list_blocks", %{}, session: sid), "blocks", "block_id")

  def process(runner, sid, bid),
    do:
      call(runner, "com.superlogical.terminal.process", %{"block_id" => bid, "args" => %{}},
        session: sid
      )

  def create(runner, spec), do: call(runner, "session.create", spec)

  def windows(runner, sid, opts \\ []) do
    case call(runner, "session.view", %{}, Keyword.put(opts, :session, sid)) do
      {:ok, view} -> {:ok, view["windows"] || []}
      error -> error
    end
  end

  def new_window(runner, sid, spec),
    do: call(runner, "session.new_window", Map.put(spec, "focus", false), session: sid)

  def close_window(runner, sid, wid),
    do: call(runner, "session.close_window", %{"window_id" => wid}, session: sid)

  def destroy(runner, sid), do: call(runner, "session.destroy", %{}, session: sid)

  def set_labels(runner, sid, bid, label) do
    with {:ok, _} <- call(runner, "session.set_label", %{"label" => label}, session: sid),
         {:ok, _} <-
           call(runner, "session.set_block_label", %{"block_id" => bid, "label" => label},
             session: sid
           ) do
      with {:ok, blocks} <- blocks(runner, sid) do
        case Enum.find(blocks, &(&1["block_id"] == bid)) do
          %{"window_id" => wid} when is_binary(wid) ->
            case call(runner, "session.set_window_label", %{"window_id" => wid, "label" => label},
                   session: sid
                 ) do
              {:ok, _} -> :ok
              error -> error
            end

          _ ->
            :ok
        end
      end
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

  def app_client(runner, opts \\ []) do
    with {:ok, %{"clients" => clients}} when is_list(clients) <-
           json_command(runner, ["client", "ls", "--json"], opts) do
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

  def select(runner, client, sid, wid \\ nil, opts \\ []),
    do:
      call(
        runner,
        "client.perform",
        %{
          "client_id" => client,
          "action" => "session.select",
          "args" =>
            if(wid, do: %{"session_id" => sid, "window_id" => wid}, else: %{"session_id" => sid}),
          "timeout_ms" => 5_000
        },
        opts
      )

  defp json_command(runner, args, opts \\ []) do
    with {:ok, output} <- command(runner, args, opts),
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
