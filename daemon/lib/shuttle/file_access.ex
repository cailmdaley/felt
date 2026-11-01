defmodule Shuttle.FileAccess.Error do
  @moduledoc "A transient filesystem failure, never an absent-file result."
  defexception [:reason, :path, :cause]

  @impl true
  def message(error) do
    "filesystem #{error.reason}#{if error.path, do: " at #{error.path}", else: ""}" <>
      if(error.cause, do: " (#{inspect(error.cause)})", else: "")
  end
end

defimpl Plug.Exception, for: Shuttle.FileAccess.Error do
  def status(%{reason: :timeout}), do: 504
  def status(_), do: 503
  def actions(_), do: []
end

defmodule Shuttle.FileAccess do
  @moduledoc """
  Bounded, host-local filesystem access.

  A caller's deadline does not kill its worker: a native open can remain parked
  in the kernel after an Erlang process is killed. Capacity belongs to the
  actual callback, including its cleanup, until it returns. There is no queue.
  The independently supervised journal owns leases, aliases and folder blocks
  across coordinator restarts. Unexpected worker death quarantines its credit
  until VM restart: process death cannot prove a native callback has returned.
  Journal failure also fails closed until VM restart. Reply aliases discard
  results after a caller leaves.
  Readers hold a slot for their entire descriptor lifetime, including network
  backpressure; short operations share those slots and fail fast when full.

  Ordinary filesystem errors retain File's result shapes. Busy, timeout and
  protected-folder failures raise `Shuttle.FileAccess.Error`, including from
  predicates, so they cannot silently become missing-file observations.

  Options: `service:` (supervisor pid/name), `timeout:` (milliseconds).
  Startup options additionally include `capacity:` and `protected_roots:`.
  Protected roots default to Documents/Desktop/Downloads under the runtime
  user's home on macOS; other platforms have none. Blocks persist until reset
  or an in-flight native open/read proves access. Metadata success cannot
  clear a protected-folder block.
  """
  use Supervisor
  require Record

  Record.defrecordp(
    :file_info_record,
    :file_info,
    Record.extract(:file_info, from_lib: "kernel/include/file.hrl")
  )

  def start_link(opts \\ []) do
    opts = Keyword.merge(Shuttle.Env.app(__MODULE__, []), opts)
    Supervisor.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @impl true
  def init(opts) do
    capacity = Keyword.get(opts, :capacity, 2)

    unless is_integer(capacity) and capacity > 0,
      do: raise(ArgumentError, "capacity must be positive")

    children = [
      %{id: :workers, start: {__MODULE__, :start_workers, [self(), capacity]}, type: :supervisor},
      {Shuttle.FileAccess.Journal, {self(), opts}},
      {Shuttle.FileAccess.Coordinator, {self(), opts}}
    ]

    Supervisor.init(children, strategy: :one_for_one)
  end

  @doc false
  def start_workers(supervisor, capacity) do
    case Task.Supervisor.start_link(max_children: capacity) do
      {:ok, pid} = result ->
        :persistent_term.put({__MODULE__, :workers, supervisor}, pid)

        spawn(fn ->
          monitor = Process.monitor(supervisor)

          receive do
            {:DOWN, ^monitor, :process, ^supervisor, _} ->
              :persistent_term.erase({__MODULE__, :workers, supervisor})
              :persistent_term.erase({__MODULE__, :journal, supervisor})
              :persistent_term.erase({__MODULE__, :journal_lifetime, supervisor})
              :persistent_term.erase({__MODULE__, :service, supervisor})
          end
        end)

        result

      error ->
        error
    end
  end

  def cwd do
    task("/", fn ->
      case :prim_file.get_cwd() do
        {:ok, path} -> {:ok, to_string(path)}
        error -> error
      end
    end)
  end

  def cwd! do
    case cwd() do
      {:ok, path} -> path
      {:error, reason} -> raise File.Error, reason: reason, action: "get working directory"
    end
  end

  def protected_roots do
    if match?({:unix, :darwin}, :os.type()) do
      Enum.map(["Documents", "Desktop", "Downloads"], &Path.join(Shuttle.Env.home(), &1))
    else
      []
    end
  end

  def status(service \\ Shuttle.Env.server(__MODULE__)) do
    GenServer.call(coordinator(service), :status, 50)
  rescue
    Shuttle.FileAccess.Error -> unavailable_status()
  catch
    :exit, _ -> unavailable_status()
  end

  defp unavailable_status,
    do: %{active: nil, capacity: nil, blocked_prefixes: [], available: false}

  def reset(prefix \\ :all, service \\ Shuttle.Env.server(__MODULE__)) do
    case GenServer.call(coordinator(service), {:reset, prefix}, 100) do
      {:transient, error} -> raise error
      result -> result
    end
  end

  @doc "Run a scoped callback after admission and bounded symlink resolution."
  def task(path, fun, opts \\ []) when is_function(fun, 0) do
    run(path, fn _resolved -> fun.() end, opts)
  end

  @doc false
  def run(path, fun, opts \\ []) when is_function(fun, 1) do
    case Process.get({__MODULE__, :lease}) do
      {server, ref} ->
        with {:ok, resolved} <-
               Shuttle.FileAccess.Resolver.resolve(
                 path,
                 server,
                 ref,
                 Keyword.get(opts, :follow_final, true)
               ) do
          fun.(resolved)
        else
          {:error, %Shuttle.FileAccess.Error{} = error} -> raise error
          error -> error
        end
        |> inline_result(server, ref)

      nil ->
        await(path, fun, opts)
    end
  end

  defp await(path, fun, opts) do
    service = Keyword.get(opts, :service, Shuttle.Env.server(__MODULE__))
    info = service_info(service)
    timeout = Keyword.get(opts, :timeout, info.timeout)
    deadline = System.monotonic_time(:millisecond) + timeout
    server = info.pid
    reply = :erlang.alias()
    ref = make_ref()
    monitor = Process.monitor(server)
    GenServer.cast(server, {:run, ref, reply, self(), deadline, path, fun, opts})

    try do
      receive do
        {^ref, {:raised, kind, error, stack}} ->
          :erlang.raise(kind, error, stack)

        {^ref, {:transient, error}} ->
          raise error

        {^ref, {:result, result}} ->
          result

        {:DOWN, ^monitor, :process, ^server, reason} ->
          raise Shuttle.FileAccess.Error, reason: :busy, path: path, cause: reason
      after
        max(deadline - System.monotonic_time(:millisecond), 0) ->
          :erlang.unalias(reply)
          GenServer.cast(server, {:expire, ref})
          raise Shuttle.FileAccess.Error, reason: :timeout, path: path
      end
    after
      :erlang.unalias(reply)
      Process.demonitor(monitor, [:flush])
    end
  end

  defp inline_result({:error, reason} = result, server, ref) when reason in [:eacces, :eperm] do
    case GenServer.call(server, {:inline_result, ref, result}) do
      {:transient, error} -> raise error
      result -> result
    end
  end

  defp inline_result(result, _server, _ref), do: result

  def read(path, opts \\ []), do: run(path, &raw_read/1, opts)

  def read!(path, opts \\ []) do
    case read(path, opts) do
      {:ok, bytes} -> bytes
      {:error, reason} -> raise File.Error, reason: reason, action: "read file", path: path
    end
  end

  @doc "Write and close a raw file within one native-I/O lease."
  def write(path, bytes, modes \\ []) do
    run(
      path,
      fn resolved ->
        with {:ok, fd} <- :file.open(native(resolved), [:write, :binary, :raw] ++ modes) do
          try do
            :file.write(fd, bytes)
          after
            :file.close(fd)
          end
        end
      end,
      follow_final: :exclusive not in modes
    )
  end

  @doc "Open, use and close a raw descriptor in its leased worker."
  def open(path, modes, fun) when is_function(fun, 1) do
    run(
      path,
      fn resolved ->
        with {:ok, fd} <- :file.open(native(resolved), [:raw | modes]) do
          try do
            {:ok, fun.(fd)}
          after
            :file.close(fd)
          end
        end
      end,
      follow_final: :exclusive not in modes
    )
  end

  def touch(path) do
    run(path, fn resolved ->
      now = :calendar.local_time()

      case :prim_file.write_file_info(native(resolved), file_info_record(atime: now, mtime: now)) do
        {:error, :enoent} -> write(resolved, "")
        result -> result
      end
    end)
  end

  def rm_rf(path) do
    run(path, fn resolved -> remove_tree(resolved, []) end, follow_final: false)
  end

  defp remove_tree(path, removed) do
    case lstat(path) do
      {:error, :enoent} ->
        {:ok, removed}

      {:ok, %File.Stat{type: :directory}} ->
        with {:ok, names} <- ls(path),
             {:ok, removed} <-
               Enum.reduce_while(names, {:ok, removed}, fn name, {:ok, acc} ->
                 case remove_tree(Path.join(path, name), acc) do
                   {:ok, acc} -> {:cont, {:ok, acc}}
                   error -> {:halt, error}
                 end
               end),
             :ok <- rmdir(path),
             do: {:ok, [path | removed]}

      {:ok, _} ->
        with :ok <- rm(path), do: {:ok, [path | removed]}

      {:error, reason} ->
        {:error, reason, path}
    end
  end

  def write!(path, bytes, modes \\ []), do: bang(write(path, bytes, modes), "write file", path)
  def read_link!(path), do: bang(read_link(path), "read link", path)

  def mkdir(path), do: run(path, &:prim_file.make_dir(native(&1)))

  def mkdir_p(path) do
    run(path, fn resolved -> raw_mkdir_p(resolved) end)
  end

  def mkdir_p!(path), do: bang(mkdir_p(path), "make directory", path)

  defp raw_mkdir_p(path) do
    case :prim_file.make_dir(native(path)) do
      :ok ->
        :ok

      {:error, :eexist} ->
        case :file.read_file_info(native(path), [:raw]) do
          {:ok, record} ->
            if File.Stat.from_record(record).type == :directory, do: :ok, else: {:error, :eexist}

          error ->
            error
        end

      {:error, :enoent} ->
        with :ok <- raw_mkdir_p(Path.dirname(path)), do: raw_mkdir_p(path)

      error ->
        error
    end
  end

  def chmod(path, mode),
    do: run(path, &:prim_file.write_file_info(native(&1), file_info_record(mode: mode)))

  def chmod!(path, mode), do: bang(chmod(path, mode), "change mode", path)
  def rm(path), do: run(path, &:prim_file.delete(native(&1)), follow_final: false)
  def rm!(path), do: bang(rm(path), "remove file", path)
  def rmdir(path), do: run(path, &:prim_file.del_dir(native(&1)))

  def rename(source, destination) do
    run(
      source,
      fn resolved ->
        run(destination, fn target -> :prim_file.rename(native(resolved), native(target)) end,
          follow_final: false
        )
      end,
      follow_final: false
    )
  end

  def rename!(source, destination), do: bang(rename(source, destination), "rename file", source)

  defp bang(:ok, _action, _path), do: :ok
  defp bang({:ok, value}, _action, _path), do: value

  defp bang({:error, reason}, action, path),
    do: raise(File.Error, reason: reason, action: action, path: path)

  def stat(path, opts \\ []), do: file_info(path, opts, :stat)
  def lstat(path, opts \\ []), do: file_info(path, opts, :lstat)

  defp file_info(path, opts, operation) do
    run(
      path,
      fn resolved ->
        args = [:raw, {:time, Keyword.get(opts, :time, :local)}]

        result =
          if operation == :stat,
            do: :file.read_file_info(native(resolved), args),
            else: :file.read_link_info(native(resolved), args)

        case result do
          {:ok, record} -> {:ok, File.Stat.from_record(record)}
          error -> error
        end
      end,
      Keyword.put(opts, :follow_final, operation == :stat)
    )
  end

  def exists?(path, opts \\ []) do
    case stat(path, opts) do
      {:ok, _} -> true
      _ -> false
    end
  end

  @doc "A lazy binary stream with per-read deadlines and deterministic descriptor cleanup."
  def stream!(path, modes \\ [], line_or_bytes \\ :line, opts \\ []) do
    Shuttle.FileAccess.Stream.open(path, modes, line_or_bytes, opts)
  end

  @doc "Path.wildcard-compatible discovery through a raw, leased filelib backend."
  def wildcard(pattern, opts \\ []) do
    run(
      pattern,
      fn _resolved ->
        key = {Shuttle.FileAccess.WildcardBackend, :match_dot}
        previous = Process.put(key, Keyword.get(opts, :match_dot, false))

        try do
          :filelib.wildcard(native(pattern), Shuttle.FileAccess.WildcardBackend)
          |> Enum.map(&to_string/1)
        after
          if is_nil(previous), do: Process.delete(key), else: Process.put(key, previous)
        end
      end,
      opts
    )
  end

  def regular?(path, opts \\ []), do: type?(path, :regular, opts)
  def dir?(path, opts \\ []), do: type?(path, :directory, opts)

  defp type?(path, type, opts) do
    case stat(path, opts) do
      {:ok, %File.Stat{type: ^type}} -> true
      _ -> false
    end
  end

  # OTP exposes no :raw option for these two operations. prim_file is the
  # native implementation also used by :file's raw operations, and avoids
  # serializing a protected-folder wait through file_server_2.
  def ls(path, opts \\ []) do
    run(
      path,
      fn resolved ->
        case :prim_file.list_dir(native(resolved)) do
          {:ok, names} ->
            permission_proof()
            {:ok, Enum.map(names, &to_string/1)}

          error ->
            error
        end
      end,
      opts
    )
  end

  def read_link(path, opts \\ []) do
    run(
      path,
      fn resolved ->
        case :prim_file.read_link(native(resolved)) do
          {:ok, target} -> {:ok, to_string(target)}
          error -> error
        end
      end,
      Keyword.put(opts, :follow_final, false)
    )
  end

  @doc "Find an executable without entering the shared Erlang file server."
  def find_executable(program, opts \\ []) do
    paths =
      if String.contains?(program, "/"),
        do: [program],
        else:
          Keyword.get(opts, :search_path, Shuttle.Env.get("PATH", ""))
          |> String.split(":")
          |> Enum.map(&Path.join(&1, program))

    {found, transient} =
      Enum.reduce_while(paths, {nil, nil}, fn path, {_, first_error} ->
        try do
          case stat(path, opts) do
            {:ok, %File.Stat{type: :regular, mode: mode}} ->
              if Bitwise.band(mode, 0o111) != 0,
                do: {:halt, {path, first_error}},
                else: {:cont, {nil, first_error}}

            _ ->
              {:cont, {nil, first_error}}
          end
        rescue
          error in Shuttle.FileAccess.Error -> {:cont, {nil, first_error || error}}
        end
      end)

    cond do
      found -> found
      transient -> raise transient
      true -> nil
    end
  end

  @doc false
  def raw_read(path) do
    result =
      with {:ok, fd} <- :file.open(native(path), [:read, :binary, :raw]) do
        try do
          read_all(fd, [])
        after
          :file.close(fd)
        end
      end

    if match?({:ok, _}, result), do: permission_proof()
    result
  end

  @doc false
  def permission_proof do
    case Process.get({__MODULE__, :lease}) do
      {journal, ref} ->
        GenServer.call(
          journal,
          {:permission_proof, ref, System.monotonic_time()}
        )

      nil ->
        :ok
    end
  end

  defp read_all(fd, acc) do
    case :file.read(fd, 64 * 1024) do
      {:ok, bytes} -> read_all(fd, [bytes | acc])
      :eof -> {:ok, acc |> Enum.reverse() |> IO.iodata_to_binary()}
      error -> error
    end
  end

  @doc false
  def native(path), do: String.to_charlist(path)

  @doc false
  def coordinator(service), do: service_info(service).pid

  @doc false
  def journal(service), do: journal_info(service_info(service).supervisor).pid

  @doc false
  def journal_info(supervisor), do: :persistent_term.get({__MODULE__, :journal, supervisor})

  @doc false
  def service_info(service) do
    :persistent_term.get({__MODULE__, :service, service}, nil) ||
      raise(Shuttle.FileAccess.Error, reason: :busy, cause: :unavailable)
  end
end

defmodule Shuttle.FileAccess.Journal do
  @moduledoc false
  use GenServer
  require Logger
  alias Shuttle.FileAccess.Error

  def start_link(args), do: GenServer.start_link(__MODULE__, args)

  @impl true
  def init({supervisor, opts}) do
    timeout = Keyword.get(opts, :timeout, 1_500)
    info = %{pid: self(), timeout: timeout}
    :persistent_term.put({Shuttle.FileAccess, :journal, supervisor}, info)
    name = Keyword.get(opts, :name, Shuttle.FileAccess)
    lifetime = {Shuttle.FileAccess, :journal_lifetime, name || supervisor}
    capacity = Keyword.get(opts, :capacity, 2)

    quarantined =
      if :persistent_term.get(lifetime, false) do
        Map.new(1..capacity, &{&1, %{cause: :journal_restart}})
      else
        %{}
      end

    :persistent_term.put(lifetime, true)

    {:ok,
     %{
       supervisor: supervisor,
       name: name,
       workers: :persistent_term.get({Shuttle.FileAccess, :workers, supervisor}),
       capacity: Keyword.get(opts, :capacity, 2),
       timeout: Keyword.get(opts, :timeout, 1_500),
       roots: Keyword.get(opts, :protected_roots, Shuttle.FileAccess.protected_roots()),
       jobs: %{},
       quarantined: quarantined,
       blocked: %{},
       aliases: %{}
     }}
  end

  @impl true
  def handle_cast({:run, ref, reply, owner, deadline, path, fun, opts}, state) do
    root = root_for(state, path)

    cond do
      not Process.alive?(owner) or deadline <= System.monotonic_time(:millisecond) ->
        send(reply, {ref, {:transient, %Error{reason: :timeout, path: path}}})
        {:noreply, state}

      root && Map.has_key?(state.blocked, root) ->
        send(
          reply,
          {ref,
           {:transient, %Error{reason: :blocked, path: root, cause: state.blocked[root].cause}}}
        )

        {:noreply, state}

      occupied(state) >= state.capacity ->
        send(reply, {ref, {:transient, %Error{reason: :busy, path: path}}})
        {:noreply, state}

      true ->
        server = self()
        workers = workers(state)
        timeout = max(deadline - System.monotonic_time(:millisecond), 0)

        case Task.Supervisor.start_child(
               workers,
               fn ->
                 Process.put(:"$callers", [owner])
                 Process.put({Shuttle.FileAccess, :lease}, {server, ref})

                 result =
                   try do
                     if not Process.alive?(owner) or
                          deadline <= System.monotonic_time(:millisecond),
                        do: raise(Error, reason: :timeout, path: path)

                     with {:ok, resolved} <-
                            Shuttle.FileAccess.Resolver.resolve(
                              path,
                              server,
                              ref,
                              Keyword.get(opts, :follow_final, true)
                            ) do
                       {:result, fun.(resolved)}
                     else
                       {:error, %Error{} = error} -> {:transient, error}
                       error -> {:result, error}
                     end
                   rescue
                     error -> {:raised, :error, error, __STACKTRACE__}
                   catch
                     kind, error -> {:raised, kind, error, __STACKTRACE__}
                   end

                 send(server, {:finished, ref, result})
               end,
               shutdown: :infinity
             ) do
          {:ok, pid} ->
            monitor = Process.monitor(pid)
            timer = Process.send_after(self(), {:expire, ref}, timeout)

            job = %{
              reply: reply,
              path: path,
              root: root,
              pid: pid,
              monitor: monitor,
              timer: timer,
              deadline: deadline,
              reader: false,
              timed_out: false,
              timeout_root: nil,
              reported_failure: nil,
              reported_failure_id: nil
            }

            {:noreply, put_in(state.jobs[ref], job)}

          {:error, :max_children} ->
            send(reply, {ref, {:transient, %Error{reason: :busy, path: path}}})
            {:noreply, state}
        end
    end
  end

  def handle_cast({:expire, ref}, state), do: handle_info({:expire, ref}, state)

  def handle_cast({:reader_block, ref, failure_id, cause}, state),
    do: {:noreply, block_reader(state, ref, failure_id, cause)}

  @impl true
  def terminate(_reason, state) do
    :persistent_term.erase({Shuttle.FileAccess, :journal, state.supervisor})
  end

  @impl true
  def handle_call({:reader_ready, ref, reader}, _from, state) do
    case state.jobs[ref] do
      %{timed_out: false, deadline: deadline} = job ->
        if deadline > System.monotonic_time(:millisecond) do
          cancel_timer(job.timer)
          send(job.reply, {ref, {:result, {:ok, reader}}})
          {:reply, :ok, put_in(state.jobs[ref], %{job | timer: nil, reader: true})}
        else
          {:noreply, state} = handle_info({:expire, ref}, state)
          {:reply, :expired, state}
        end

      _ ->
        {:reply, :expired, state}
    end
  end

  def handle_call({:permission_proof, ref, proven_at}, _from, state) do
    state =
      case state.jobs[ref] do
        %{root: root} when not is_nil(root) ->
          case state.blocked[root] do
            %{since: since} when proven_at >= since ->
              %{state | blocked: Map.delete(state.blocked, root)}

            _ ->
              state
          end

        _ ->
          state
      end

    {:reply, :ok, state}
  end

  def handle_call({:reader_block, ref, failure_id, cause}, _from, state),
    do: {:reply, :ok, block_reader(state, ref, failure_id, cause)}

  def handle_call({:inline_result, ref, result}, _from, state) do
    case state.jobs[ref] do
      nil ->
        {:reply, result, state}

      job ->
        {state, reply} = completion(state, %{job | timed_out: false}, {:result, result})

        result =
          case reply do
            {:result, value} -> value
            other -> other
          end

        {:reply, result, state}
    end
  end

  def handle_call({:path, ref, physical, logical}, _from, state) do
    root = root_for(state, physical) || (logical && root_for(state, logical))

    continuing =
      case state.jobs[ref] do
        %{timeout_root: ^root, timed_out: true} when not is_nil(root) -> true
        _ -> false
      end

    state =
      if root do
        Enum.reduce([logical, physical], state, fn prefix, state ->
          if prefix && prefix != root && root_for(state, prefix) != root,
            do: put_in(state.aliases[prefix], root),
            else: state
        end)
      else
        state
      end

    state = if Map.has_key?(state.jobs, ref), do: put_in(state.jobs[ref].root, root), else: state

    if root && Map.has_key?(state.blocked, root) && not continuing do
      {:reply, {:error, %Error{reason: :blocked, path: root, cause: state.blocked[root].cause}},
       state}
    else
      {:reply, :ok, state}
    end
  end

  def handle_call(:status, _from, state) do
    blocked =
      Enum.map(state.blocked, fn {prefix, entry} ->
        %{prefix: prefix, cause: entry.cause, blocked_at: entry.blocked_at}
      end)
      |> Enum.sort_by(& &1.prefix)

    {:reply,
     %{
       capacity: state.capacity,
       active: occupied(state),
       quarantined: map_size(state.quarantined),
       available: true,
       blocked_prefixes: blocked
     }, state}
  end

  def handle_call({:reset, prefix}, _from, state) do
    blocked = if prefix == :all, do: %{}, else: Map.delete(state.blocked, prefix)
    {:reply, :ok, %{state | blocked: blocked}}
  end

  @impl true
  def handle_info({:expire, ref}, state) do
    case state.jobs[ref] do
      nil ->
        {:noreply, state}

      %{reader: true} ->
        {:noreply, state}

      %{timed_out: true} ->
        {:noreply, state}

      job ->
        state = block(state, job.root, :timeout)
        send(job.reply, {ref, {:transient, %Error{reason: :timeout, path: job.root || job.path}}})

        {:noreply,
         %{
           state
           | jobs: Map.put(state.jobs, ref, %{job | timed_out: true, timeout_root: job.root})
         }}
    end
  end

  def handle_info({:finished, ref, result}, state) do
    case Map.pop(state.jobs, ref) do
      {nil, _} ->
        {:noreply, state}

      {job, jobs} ->
        cancel_timer(job.timer)
        Process.demonitor(job.monitor, [:flush])
        state = %{state | jobs: jobs}
        {state, result} = completion(state, job, result)
        send(job.reply, {ref, result})
        {:noreply, state}
    end
  end

  def handle_info({:DOWN, monitor, :process, _pid, reason}, state) do
    case Enum.find(state.jobs, fn {_ref, job} -> job.monitor == monitor end) do
      nil ->
        {:noreply, state}

      {ref, job} ->
        cancel_timer(job.timer)
        send(job.reply, {ref, {:transient, %Error{reason: :busy, path: job.path, cause: reason}}})
        state = block(state, job.root, :worker_down)
        lost = %{pid: job.pid, path: job.path, cause: reason}

        {:noreply,
         %{
           state
           | jobs: Map.delete(state.jobs, ref),
             quarantined: Map.put(state.quarantined, ref, lost)
         }}
    end
  end

  defp completion(state, %{root: root} = job, {:result, {:error, reason}})
       when not is_nil(root) and reason in [:eacces, :eperm] do
    state = if job.reported_failure == reason, do: state, else: block(state, root, reason)
    {state, {:transient, %Error{reason: :blocked, path: root, cause: reason}}}
  end

  defp completion(state, job, {:result, {:error, reason}}) when reason in [:eacces, :eperm],
    do: {state, {:transient, %Error{reason: :denied, path: job.path, cause: reason}}}

  defp completion(state, _job, result), do: {state, result}

  defp cancel_timer(nil), do: :ok
  defp cancel_timer(timer), do: Process.cancel_timer(timer)

  defp block_reader(state, ref, failure_id, cause) do
    case state.jobs[ref] do
      nil ->
        state

      %{reported_failure_id: ^failure_id} ->
        state

      job ->
        state = block(state, job.root, cause)

        put_in(state.jobs[ref], %{
          job
          | timed_out: true,
            timeout_root: job.root,
            reported_failure: cause,
            reported_failure_id: failure_id
        })
    end
  end

  defp block(state, nil, _cause), do: state

  defp block(state, root, cause) do
    if Map.has_key?(state.blocked, root) do
      put_in(state.blocked[root], %{
        state.blocked[root]
        | cause: cause,
          since: System.monotonic_time()
      })
    else
      Logger.warning(
        "Filesystem access blocked for #{root} (#{cause}). " <>
          "Grant the shuttle launcher Files & Folders access or Full Disk Access in " <>
          "macOS System Settings → Privacy & Security, then restart the daemon or complete the pending request."
      )

      put_in(state.blocked[root], %{
        cause: cause,
        since: System.monotonic_time(),
        blocked_at: DateTime.utc_now() |> DateTime.to_iso8601()
      })
    end
  end

  defp root_for(state, path) do
    Enum.find(state.roots, &within?(path, &1)) ||
      Enum.find_value(state.aliases, fn {prefix, root} -> if within?(path, prefix), do: root end)
  end

  defp within?(path, prefix), do: path == prefix or String.starts_with?(path, prefix <> "/")

  defp workers(state), do: state.workers
  defp occupied(state), do: map_size(state.jobs) + map_size(state.quarantined)
end

defmodule Shuttle.FileAccess.Resolver do
  @moduledoc false

  defp join_logical(nil, _part), do: nil
  defp join_logical(logical, part), do: Path.join(logical, part)

  # Each native pathname operation is preceded by a cheap lease-journal check.
  # Symlinks are walked component-by-component, including directory symlinks;
  # their logical prefixes let subsequent requests fail before touching disk.
  def resolve(path, server, ref, follow_final) do
    absolute =
      if Path.type(path) == :absolute do
        path
      else
        {:ok, cwd} = :prim_file.get_cwd()
        Path.join(to_string(cwd), path)
      end

    walk(Path.split(absolute), "/", "/", server, ref, follow_final, 0)
  end

  defp walk(_, _, _, _, _, _, count) when count > 40, do: {:error, :eloop}
  defp walk([], physical, _logical, _server, _ref, _follow, _count), do: {:ok, physical}

  defp walk(["/" | rest], physical, logical, server, ref, follow, count),
    do: walk(rest, physical, logical, server, ref, follow, count)

  defp walk(["." | rest], physical, logical, server, ref, follow, count),
    do: walk(rest, physical, logical, server, ref, follow, count)

  defp walk([".." | rest], physical, logical, server, ref, follow, count),
    do:
      walk(rest, Path.dirname(physical), join_logical(logical, ".."), server, ref, follow, count)

  defp walk([part | rest], physical, logical, server, ref, follow, count) do
    physical = Path.join(physical, part)
    logical = join_logical(logical, part)

    with :ok <- GenServer.call(server, {:path, ref, physical, logical}) do
      if rest == [] and not follow do
        {:ok, physical}
      else
        case :prim_file.read_link(Shuttle.FileAccess.native(physical)) do
          {:ok, target} ->
            target = to_string(target)

            target =
              if Path.type(target) == :absolute,
                do: target,
                else: Path.join(Path.dirname(physical), target)

            with {:ok, resolved} <-
                   walk(Path.split(target), "/", nil, server, ref, true, count + 1),
                 :ok <- GenServer.call(server, {:path, ref, resolved, logical}) do
              walk(rest, resolved, logical, server, ref, follow, count + 1)
            end

          {:error, reason} when reason in [:einval, :enoent, :enotdir] ->
            walk(rest, physical, logical, server, ref, follow, count)

          error ->
            error
        end
      end
    end
  end
end
