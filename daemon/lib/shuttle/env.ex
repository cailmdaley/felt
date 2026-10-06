defmodule Shuttle.Env do
  @moduledoc """
  The daemon's one reader of process-global configuration: the OS environment,
  the `:shuttle` application env, and executable lookup on `PATH`.

  Production code calls `get/2`, `app/2`, `find_executable/1`,
  `home/0`, `expand/1` and `cmd/3` instead of `System.get_env/2`,
  `Application.get_env(:shuttle, …)`, `System.find_executable/1`,
  `System.user_home!/0`, `Path.expand/1` and `System.cmd/3`. In `:dev` and `:prod` each is a straight
  passthrough to the global value.

  Test builds (`config :shuttle, scoped_env: true`, read at compile time) first
  consult *scoped overrides*: values a test process registers for itself and
  for every process acting on its behalf, so concurrent tests can give the same
  key different values without touching global state. A process acts on behalf
  of an owner when the owner is reachable through `$callers` (Tasks) or
  `$ancestors` (processes started with `start_supervised`/`start_link`),
  followed transitively — a Task started by a GenServer the test supervises
  sees the test's scope. Processes the application started at boot reach no
  test, and read the global value.

  An override is either a value or a deletion (the variable reads as unset,
  the app key as absent). `child_env/0` hands a scope's OS-env overrides to
  child processes, so a command spawned through `Shuttle.Runner.Default` sees
  the same environment its caller does. `server/1` resolves which process a
  default-named singleton (`Shuttle.Poller`, the remote registries) means for
  the caller, so a test can run its own unnamed instance. The test-side writer is
  `Shuttle.Test.Env`.
  """

  @scoped Application.compile_env(:shuttle, :scoped_env, false)
  @table :shuttle_scoped_env

  @doc "The ETS table holding scoped overrides (test builds only)."
  def table, do: @table

  @doc "Whether this build consults scoped overrides."
  def scoped?, do: @scoped

  if @scoped do
    @max_walk 64
    @owner_key :"$shuttle_env_owner"

    @doc "`System.get_env/2`, through the caller's scope."
    @spec get(String.t(), String.t() | nil) :: String.t() | nil
    def get(name, default \\ nil) do
      case lookup(:env, name) do
        {:ok, {:set, value}} -> value
        {:ok, :delete} -> default
        :error -> System.get_env(name, default)
      end
    end

    @doc "`Application.get_env(:shuttle, key, default)`, through the caller's scope."
    @spec app(atom(), term()) :: term()
    def app(key, default \\ nil) do
      case lookup(:app, key) do
        {:ok, {:set, value}} -> value
        {:ok, :delete} -> default
        :error -> Application.get_env(:shuttle, key, default)
      end
    end

    @doc """
    `System.find_executable/1` against the caller's `PATH`: a scoped `PATH`
    override is searched instead of the VM's.
    """
    @spec find_executable(String.t()) :: String.t() | nil
    def find_executable(name) do
      case lookup(:env, "PATH") do
        {:ok, {:set, path}} -> find_on(name, path)
        {:ok, :delete} -> nil
        :error -> System.find_executable(name)
      end
    end

    @doc "The user's home directory: a scoped `HOME`, else `System.user_home!/0`."
    @spec home() :: String.t()
    def home do
      case lookup(:env, "HOME") do
        {:ok, {:set, home}} -> home
        _ -> System.user_home!()
      end
    end

    @doc "`Path.expand/1`, with a leading `~` resolved against a scoped `HOME`."
    @spec expand(Path.t()) :: String.t()
    def expand(path) do
      case {path, lookup(:env, "HOME")} do
        {"~", {:ok, {:set, home}}} -> Path.expand(home)
        {"~/" <> rest, {:ok, {:set, home}}} -> Path.expand(Path.join(home, rest))
        _ -> Path.expand(path)
      end
    end

    @doc """
    `System.cmd/3` as the caller's scope sees it: the executable resolved on
    the scoped `PATH`, the scoped env handed to the child (an `env:` entry the
    caller passes wins).
    """
    @spec cmd(String.t(), [String.t()], keyword()) :: {Collectable.t(), non_neg_integer()}
    def cmd(command, args, opts \\ []) do
      executable =
        if Path.type(command) == :absolute, do: command, else: find_executable(command) || command

      opts =
        case child_env() do
          [] ->
            opts

          scoped ->
            caller = Keyword.get(opts, :env, [])
            names = MapSet.new(caller, &elem(&1, 0))
            Keyword.put(opts, :env, caller ++ Enum.reject(scoped, &(elem(&1, 0) in names)))
        end

      System.cmd(executable, args, opts)
    end

    @doc """
    The caller's scoped OS-env overrides as `System.cmd/3`-style `env:`
    entries (`nil` unsets). Empty outside a scope.
    """
    @spec child_env() :: [{String.t(), String.t() | nil}]
    def child_env do
      case owner() do
        nil ->
          []

        owner ->
          for [name, override] <- :ets.match(@table, {{owner, :env, :"$1"}, :"$2"}) do
            case override do
              {:set, value} -> {name, value}
              :delete -> {name, nil}
            end
          end
      end
    end

    @doc """
    The scope owner the calling process acts for: the first registered owner
    reached from `self()` through `$callers` and `$ancestors`, breadth-first.
    """
    @spec owner() :: pid() | nil
    def owner do
      cond do
        :ets.whereis(@table) == :undefined ->
          nil

        # Resolved once, then held by pid: a name in `$ancestors` may later
        # be registered by another process.
        is_pid(cached = Process.get(@owner_key)) ->
          if :ets.member(@table, {:owner, cached}), do: cached

        true ->
          callers = Process.get(:"$callers", [])
          ancestors = Process.get(:"$ancestors", [])

          with owner when is_pid(owner) <- walk([self() | callers ++ ancestors], MapSet.new(), 0) do
            Process.put(@owner_key, owner)
            owner
          end
      end
    end

    @doc """
    `key`, qualified by the caller's scope owner when it has one: for
    process-global caches (`:persistent_term`) that would otherwise be shared
    by concurrent tests.
    """
    @spec scope_key(term()) :: term()
    def scope_key(key) do
      case owner() do
        nil -> key
        owner -> {key, owner}
      end
    end

    @doc """
    The process to address for a singleton registered as `name`: the
    caller's scoped instance when a test registered one, else `name`.
    """
    @spec server(atom()) :: GenServer.server()
    def server(name) do
      case lookup(:server, name) do
        {:ok, {:set, server}} -> server
        _ -> name
      end
    end

    @doc """
    The `$callers` chain to hand a process started on the caller's behalf
    under an application-level supervisor (which is no ancestor of the
    caller), so it reads the caller's scope. Pair with `adopt_callers/1` in
    the child's `init/1`.
    """
    @spec callers() :: [pid()]
    # The resolved owner rides along, so the chain still reaches the test after
    # an intermediate process (the starting Poller) has exited.
    def callers, do: [self() | Process.get(:"$callers", [])] ++ List.wrap(owner())

    @doc "Adopt a `callers/0` chain as this process's `$callers`."
    @spec adopt_callers([pid()]) :: :ok
    def adopt_callers([]), do: :ok

    def adopt_callers(callers) when is_list(callers) do
      Process.put(:"$callers", callers)
      :ok
    end

    defp lookup(kind, key) do
      with owner when is_pid(owner) <- owner(),
           [{_, override}] <- :ets.lookup(@table, {owner, kind, key}) do
        {:ok, override}
      else
        _ -> :error
      end
    end

    defp find_on(name, path) do
      case :os.find_executable(String.to_charlist(name), String.to_charlist(path)) do
        false -> nil
        found -> List.to_string(found)
      end
    end

    defp walk([], _seen, _n), do: nil
    defp walk(_queue, _seen, n) when n >= @max_walk, do: nil

    defp walk([ref | rest], seen, n) do
      pid = resolve(ref)

      cond do
        pid == nil or MapSet.member?(seen, pid) ->
          walk(rest, seen, n)

        :ets.member(@table, {:owner, pid}) ->
          pid

        true ->
          walk(rest ++ links_of(pid), MapSet.put(seen, pid), n + 1)
      end
    end

    defp resolve(pid) when is_pid(pid), do: pid
    defp resolve(name) when is_atom(name), do: Process.whereis(name)
    defp resolve(_), do: nil

    # The caller's own links are already queued from its dictionary.
    defp links_of(pid) when pid == self(), do: []

    defp links_of(pid) do
      case Process.info(pid, :dictionary) do
        {:dictionary, dict} -> dict_list(dict, :"$callers") ++ dict_list(dict, :"$ancestors")
        nil -> []
      end
    end

    defp dict_list(dict, key) do
      case List.keyfind(dict, key, 0) do
        {^key, list} when is_list(list) -> list
        _ -> []
      end
    end
  else
    @doc "`System.get_env/2`."
    @spec get(String.t(), String.t() | nil) :: String.t() | nil
    def get(name, default \\ nil), do: System.get_env(name, default)

    @doc "`Application.get_env(:shuttle, key, default)`."
    @spec app(atom(), term()) :: term()
    def app(key, default \\ nil), do: Application.get_env(:shuttle, key, default)

    @doc "`System.find_executable/1`."
    @spec find_executable(String.t()) :: String.t() | nil
    def find_executable(name), do: System.find_executable(name)

    @doc "`System.user_home!/0`."
    @spec home() :: String.t()
    def home, do: System.user_home!()

    @doc "`Path.expand/1`."
    @spec expand(Path.t()) :: String.t()
    def expand(path), do: Path.expand(path)

    @doc "`System.cmd/3`."
    @spec cmd(String.t(), [String.t()], keyword()) :: {Collectable.t(), non_neg_integer()}
    def cmd(command, args, opts \\ []), do: System.cmd(command, args, opts)

    @doc "No scoped overrides exist outside test builds."
    @spec child_env() :: []
    def child_env, do: []

    @doc "`key` itself: there are no scopes outside test builds."
    @spec scope_key(term()) :: term()
    def scope_key(key), do: key

    @doc "The singleton registered as `name`."
    @spec server(atom()) :: atom()
    def server(name), do: name

    @doc "No scopes exist outside test builds, so there is no chain to hand on."
    @spec callers() :: []
    def callers, do: []

    @doc "A no-op outside test builds."
    @spec adopt_callers(list()) :: :ok
    def adopt_callers(_callers), do: :ok

    @doc "No scope owners exist outside test builds."
    @spec owner() :: nil
    def owner, do: nil
  end
end
