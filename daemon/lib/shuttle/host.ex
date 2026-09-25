defmodule Shuttle.Host do
  @moduledoc """
  What kind of machine this daemon runs on, and where it therefore listens.

  Source: `~/.config/felt/host.json` (or `$FELT_HOST_FILE`) →

      {"class": "single-user", "listen": "tcp://127.0.0.1:4000"}

  | class | who else has a shell here | default listen |
  |---|---|---|
  | `single-user` | nobody — a laptop, a personal VM | `tcp://127.0.0.1:<port>` |
  | `shared-multi-user` | other accounts — a cluster login node | `unix://<data_dir>/sock/daemon.sock` |
  | `exposed` | a listener other machines can reach sits in front | `unix://<data_dir>/sock/daemon.sock` |

  Loopback TCP is private only when every process on the machine is yours. On
  a shared host any account can connect to `127.0.0.1:4000` and drive the
  fleet, so the class that admits other accounts binds a unix socket inside a
  `0700` directory instead, and the kernel's file permissions become the
  access check.

  A missing file, or a file with no `class`, is a `single-user` host — the correct
  reading for a laptop that has never been told otherwise. A malformed file
  raises with its path, at boot: guessing the class of a machine whose
  operator tried to name it would pick the permissive answer for the one host
  that said it needed the strict one.

  The Go CLI (`felt shuttle host`) reads the same file and applies the same
  listen rule; `test/fixtures/host/` is read by both suites so the two cannot
  drift.

  ## Listen resolution

    1. `SHUTTLE_LISTEN`
    2. the file's `listen`
    3. the class default above, where `<port>` is `SHUTTLE_PORT`, else the
       endpoint config's port, else 4000

  Only two forms are accepted: `tcp://127.0.0.1:PORT` and `unix:///absolute/path`.
  A unix path with a `..` segment or a trailing `/` is refused; `//` and `/./`
  are cleaned away, and the cleaned path is what is bound and reported. It
  must be shorter than 100 bytes — macOS caps `sun_path` at 104
  including the terminator, and a path that fits on Linux but not on a laptop
  is a config that works until it is copied. Any other address, including a
  non-loopback TCP one, is refused (and raises at boot): this daemon has no authentication of its own,
  so it never binds where another machine could reach it directly.
  """

  @type class :: :single_user | :shared_multi_user | :exposed
  @type listen :: {:tcp, {0..255, 0..255, 0..255, 0..255}, pos_integer()} | {:unix, String.t()}

  @typedoc """
  A refusal's kind — the contract `test/fixtures/host/expected.json` holds
  both readers to. Messages are for humans and may differ between languages.
  """
  @type error_kind ::
          :malformed
          | :bad_class
          | :bad_listen
          | :non_loopback
          | :bad_port
          | :socket_path_too_long
          | :relative_socket_path
          | :bad_socket_path
          | :duplicate_key
          | :unreadable

  @type settings :: %{
          class: class(),
          class_source: :file | :default,
          listen: listen(),
          listen_source: :env | :file | :class_default
        }

  @config_env "FELT_HOST_FILE"
  @default_config_path "~/.config/felt/host.json"
  @max_unix_path_bytes 100
  @default_port 4000

  @classes %{
    "single-user" => :single_user,
    "shared-multi-user" => :shared_multi_user,
    "exposed" => :exposed
  }

  @doc "Path host.json is read from: `$FELT_HOST_FILE`, else `~/.config/felt/host.json`."
  @spec config_path() :: String.t()
  def config_path do
    case System.get_env(@config_env) do
      v when is_binary(v) and v != "" -> Path.expand(v)
      _ -> Path.expand(@default_config_path)
    end
  end

  @doc "The wire name of a class — the string host.json and the API use."
  @spec class_name(class()) :: String.t()
  for {name, atom} <- @classes do
    def class_name(unquote(atom)), do: unquote(name)
  end

  @doc """
  Resolve the class and listen address from the environment and host.json.

  `{:ok, settings}` or `{:error, kind, message}`. `fallback_port` is the
  endpoint config's port, used by the single-user default when `SHUTTLE_PORT`
  is unset.
  """
  @spec resolve(pos_integer()) :: {:ok, settings()} | {:error, error_kind(), String.t()}
  def resolve(fallback_port \\ @default_port) do
    path = config_path()

    with {:ok, doc} <- read_document(path),
         {:ok, class, class_source} <- file_class(doc, path),
         {:ok, file_listen} <- string_key(doc, "listen", path),
         {:ok, listen, listen_source} <- resolve_listen(file_listen, class, path, fallback_port) do
      {:ok,
       %{class: class, class_source: class_source, listen: listen, listen_source: listen_source}}
    end
  end

  @doc "`resolve/1`, raising `ArgumentError` with the message on a refusal."
  @spec resolve!(pos_integer()) :: settings()
  def resolve!(fallback_port \\ @default_port) do
    case resolve(fallback_port) do
      {:ok, settings} -> settings
      {:error, _kind, message} -> raise ArgumentError, message
    end
  end

  @doc "This host's class, read fresh. Raises on a malformed host.json."
  @spec class() :: class()
  def class, do: resolve!().class

  @doc "The resolved listen address as a string, read fresh. Raises on invalid input."
  @spec listen() :: String.t()
  def listen, do: resolve!().listen |> format_listen()

  # `{:ok, map}` — `%{}` when the file is absent, so an absent file and an
  # empty object resolve identically.
  #
  # Decoded with ordered objects so a repeated top-level key is visible: JSON
  # parsers disagree on which copy wins, so the CLI and the daemon could each
  # read a different class out of the same bytes. Invalid UTF-8 anywhere in
  # the file is malformed, not just inside the values read here.
  defp read_document(path) do
    case File.read(path) do
      {:ok, content} ->
        with true <-
               String.valid?(content) || {:error, :malformed, "parsing #{path}: invalid UTF-8"},
             {:ok, doc} <- decode_document(content, path) do
          top_level(doc, path)
        end

      {:error, :enoent} ->
        {:ok, %{}}

      {:error, reason} ->
        {:error, :unreadable, "reading #{path}: #{:file.format_error(reason)}"}
    end
  end

  defp decode_document(content, path) do
    case Jason.decode(content, objects: :ordered_objects) do
      {:ok, doc} -> {:ok, doc}
      {:error, error} -> {:error, :malformed, "parsing #{path}: #{Exception.message(error)}"}
    end
  end

  defp top_level(%Jason.OrderedObject{values: pairs}, path) do
    keys = Enum.map(pairs, &elem(&1, 0))

    case keys -- Enum.uniq(keys) do
      [] -> {:ok, Map.new(pairs)}
      [key | _] -> {:error, :duplicate_key, ~s(#{path}: key "#{key}" appears more than once)}
    end
  end

  defp top_level(_doc, path), do: {:error, :malformed, "parsing #{path}: not a JSON object"}

  # A key that is present must be a string; absent is `nil`.
  defp string_key(doc, key, path) do
    case Map.fetch(doc, key) do
      :error -> {:ok, nil}
      {:ok, value} when is_binary(value) -> {:ok, value}
      {:ok, _} -> {:error, :malformed, ~s(#{path}: "#{key}" must be a string)}
    end
  end

  # An absent class is single-user; a present one must name a class exactly,
  # so `""` is refused rather than read as absent.
  defp file_class(doc, path) do
    with {:ok, value} <- string_key(doc, "class", path) do
      case value do
        nil ->
          {:ok, :single_user, :default}

        name ->
          case Map.fetch(@classes, name) do
            {:ok, class} ->
              {:ok, class, :file}

            :error ->
              {:error, :bad_class,
               ~s(#{path}: class "#{name}" is not one of single-user, shared-multi-user, exposed)}
          end
      end
    end
  end

  defp resolve_listen(file_listen, class, path, fallback_port) do
    env_listen = System.get_env("SHUTTLE_LISTEN")

    cond do
      present?(env_listen) ->
        with {:ok, listen} <- prefix(parse_listen(env_listen), "$SHUTTLE_LISTEN: "),
             do: {:ok, listen, :env}

      present?(file_listen) ->
        with {:ok, listen} <- prefix(parse_listen(file_listen), "#{path}: "),
             do: {:ok, listen, :file}

      true ->
        with {:ok, listen} <- class_default(class, fallback_port),
             do: {:ok, listen, :class_default}
    end
  end

  defp class_default(:single_user, fallback_port) do
    case System.get_env("SHUTTLE_PORT") do
      value when is_binary(value) ->
        if String.trim(value) == "" do
          {:ok, {:tcp, {127, 0, 0, 1}, fallback_port}}
        else
          with {:ok, port} <- prefix(parse_port(String.trim(value)), "$SHUTTLE_PORT: "),
               do: {:ok, {:tcp, {127, 0, 0, 1}, port}}
        end

      nil ->
        {:ok, {:tcp, {127, 0, 0, 1}, fallback_port}}
    end
  end

  # The data dir and `/sock/daemon.sock` joined as strings and validated like
  # any other socket path, so a `..` in SHUTTLE_DATA_DIR is refused rather
  # than cleaned away, and a relative one stays relative (and is refused).
  defp class_default(_socket_class, _fallback_port) do
    case unix_listen(data_dir() <> "/sock/daemon.sock") do
      {:ok, listen} ->
        {:ok, listen}

      {:error, kind, message} ->
        {:error, kind,
         message <> ~s(; set SHUTTLE_LISTEN or host.json "listen" to a usable unix:// path)}
    end
  end

  # SHUTTLE_DATA_DIR (trimmed, a leading `~` expanded, never made absolute
  # against the working directory), else `~/.shuttle` — the Go reader's rule.
  defp data_dir do
    case System.get_env("SHUTTLE_DATA_DIR") |> Kernel.||("") |> String.trim() do
      "" -> Path.join(System.user_home!(), ".shuttle")
      "~" -> System.user_home!()
      "~/" <> rest -> Path.join(System.user_home!(), rest)
      dir -> dir
    end
  end

  defp present?(value), do: is_binary(value) and String.trim(value) != ""

  defp prefix({:error, kind, message}, lead), do: {:error, kind, lead <> message}
  defp prefix(ok, _lead), do: ok

  @doc """
  Parse one listen address: `tcp://127.0.0.1:PORT` or `unix:///absolute/path`
  (under 100 bytes). Surrounding whitespace is ignored. `{:ok, listen}` or
  `{:error, kind, message}`.
  """
  @spec parse_listen(String.t()) :: {:ok, listen()} | {:error, error_kind(), String.t()}
  def parse_listen(raw) when is_binary(raw) do
    case String.trim(raw) do
      "tcp://" <> authority = value ->
        tcp_listen(value, authority)

      "unix://" <> path ->
        unix_listen(path)

      value ->
        {:error, :bad_listen,
         ~s(listen "#{value}": want tcp://127.0.0.1:PORT or unix://ABSOLUTE_PATH)}
    end
  end

  defp tcp_listen(value, authority) do
    case String.split(authority, ":", parts: 2) do
      [host, port_text] ->
        cond do
          String.contains?(port_text, ":") ->
            {:error, :bad_listen, ~s(listen "#{value}": want tcp://127.0.0.1:PORT)}

          host != "127.0.0.1" ->
            {:error, :non_loopback,
             ~s(listen "#{value}" binds "#{host}"; only 127.0.0.1 is allowed ) <>
               "(use a unix socket to be private from other local users)"}

          true ->
            with {:ok, port} <- prefix(parse_port(port_text), ~s(listen "#{value}": )),
                 do: {:ok, {:tcp, {127, 0, 0, 1}, port}}
        end

      _ ->
        {:error, :bad_listen, ~s(listen "#{value}": want tcp://127.0.0.1:PORT)}
    end
  end

  # Absolute, free of `..` segments and a trailing `/` (both refused, since
  # cleaning them away would bind somewhere other than what was written),
  # then cleaned of `//` and `/./`; the cleaned form is what is bound, what is
  # reported, and what the length limit applies to.
  defp unix_listen(path) do
    segments = String.split(path, "/")

    cond do
      not String.starts_with?(path, "/") ->
        {:error, :relative_socket_path, ~s(socket path "#{path}" is not absolute)}

      ".." in segments or String.ends_with?(path, "/") ->
        {:error, :bad_socket_path, ~s(socket path "#{path}" has a '..' segment or a trailing '/')}

      true ->
        clean = "/" <> (segments |> Enum.reject(&(&1 in ["", "."])) |> Enum.join("/"))

        if byte_size(clean) >= @max_unix_path_bytes do
          {:error, :socket_path_too_long,
           ~s(socket path "#{clean}" is #{byte_size(clean)} bytes; ) <>
             "it must be under #{@max_unix_path_bytes} (macOS truncates sun_path at 104)"}
        else
          {:ok, {:unix, clean}}
        end
    end
  end

  # Decimal digits only, in 1..65535 — "+4000" and "4_000" are refused.
  defp parse_port(text) do
    if Regex.match?(~r/\A[0-9]+\z/, text) and String.to_integer(text) in 1..65_535 do
      {:ok, String.to_integer(text)}
    else
      {:error, :bad_port, ~s(port "#{text}" must be an integer between 1 and 65535)}
    end
  end

  @doc """
  Make a unix socket path safe to bind, or raise.

  The socket's directory is the access check — anyone who can traverse it can
  connect — so the guarantee is only as strong as the path to it. Every
  directory on that path is checked the way OpenSSH's StrictModes checks a
  home directory:

    * Each ancestor, walked component by component with symlinks resolved
      physically (a link's target is walked with the same rules), must be
      owned by this process's effective uid or by root, and must not be
      writable by group or others unless its sticky bit is set (`/tmp`). An
      ancestor anyone else can write is one where the socket directory can be
      swapped for a symlink to theirs between this check and the bind. A
      missing ancestor is created, and its group/other write bits cleared.
    * The socket directory itself must be a real directory (never a symlink)
      owned by the effective uid with mode exactly `0700`. When absent it is
      created and then chmodded — after an lstat confirms the thing at the
      path is the directory just made. An existing one that fails is refused
      rather than repaired: someone chose that mode or owner.
    * A socket file already at the path is removed only when a connect to it
      is refused outright (`:econnrefused`) — the kernel's word that nothing
      listens. A live one means another daemon holds the address; any other
      answer (a timeout, a permission error) is not evidence of absence, and
      the file is left alone.
    * Anything at the path that is not a socket is left alone and refused.

  `opts[:euid]` overrides the effective uid (tests).
  """
  @spec prepare_unix_socket!(String.t(), keyword()) :: :ok
  def prepare_unix_socket!(path, opts \\ []) do
    euid = Keyword.get_lazy(opts, :euid, &effective_uid/0)
    dir = Path.dirname(path)
    parent = secure_ancestors!(Path.dirname(dir), euid)
    ensure_socket_dir!(Path.join(parent, Path.basename(dir)), euid)
    clear_stale_socket!(path)
  end

  @doc """
  Restrict a bound socket to its owner (`0600`). The directory's `0700`
  already keeps other accounts out; this makes the socket say so too, whatever
  umask the daemon was started under. Raises when the path is not a socket.
  """
  @spec restrict_bound_socket!(String.t()) :: :ok
  def restrict_bound_socket!(path) do
    case File.lstat(path) do
      {:ok, %File.Stat{type: :other}} ->
        File.chmod!(path, 0o600)

      {:ok, %File.Stat{type: type}} ->
        raise ArgumentError, "#{path} is a #{type}, not the bound socket"

      {:error, reason} ->
        raise ArgumentError, "#{path}: #{:file.format_error(reason)}"
    end
  end

  @max_symlinks 40

  # Walk `path` from `/`, returning its physical location. `current` is always
  # a real, already-checked directory, so `..` is its physical parent.
  defp secure_ancestors!(path, euid) do
    check_ancestor!("/", euid)
    walk!("/", tl(Path.split(Path.expand(path))), euid, 0)
  end

  defp walk!(current, [], _euid, _links), do: current
  defp walk!(current, ["." | rest], euid, links), do: walk!(current, rest, euid, links)

  defp walk!(current, [".." | rest], euid, links),
    do: walk!(Path.dirname(current), rest, euid, links)

  defp walk!(_current, _parts, _euid, links) when links > @max_symlinks,
    do:
      raise(
        ArgumentError,
        "refusing to listen: more than #{@max_symlinks} symlinks on the socket path"
      )

  defp walk!(current, [name | rest], euid, links) do
    candidate = Path.join(current, name)

    case File.lstat(candidate) do
      {:ok, %File.Stat{type: :symlink}} ->
        target = File.read_link!(candidate)

        case Path.split(target) do
          ["/" | parts] ->
            walk!("/", parts ++ rest, euid, links + 1)

          parts ->
            walk!(current, parts ++ rest, euid, links + 1)
        end

      {:ok, %File.Stat{type: :directory}} ->
        check_ancestor!(candidate, euid)
        walk!(candidate, rest, euid, links)

      {:ok, %File.Stat{type: type}} ->
        raise ArgumentError,
              "refusing to listen under #{candidate}: it is a #{type}, not a directory"

      {:error, :enoent} ->
        create_ancestor!(candidate, euid)
        walk!(candidate, rest, euid, links)

      {:error, reason} ->
        raise ArgumentError,
              "refusing to listen under #{candidate}: #{:file.format_error(reason)}"
    end
  end

  defp create_ancestor!(dir, euid) do
    case File.mkdir(dir) do
      :ok ->
        case File.lstat(dir) do
          {:ok, %File.Stat{type: :directory, uid: ^euid, mode: mode}} ->
            File.chmod!(dir, Bitwise.band(mode, 0o7755))

          _ ->
            raise ArgumentError, "refusing to listen under #{dir}: it changed while being created"
        end

      {:error, :eexist} ->
        :ok

      {:error, reason} ->
        raise ArgumentError, "refusing to listen under #{dir}: #{:file.format_error(reason)}"
    end

    check_ancestor!(dir, euid)
  end

  defp check_ancestor!(dir, euid) do
    case File.lstat(dir) do
      {:ok, %File.Stat{type: :directory, uid: uid, mode: mode}} ->
        perms = Bitwise.band(mode, 0o7777)
        writable? = Bitwise.band(perms, 0o022) != 0
        sticky? = Bitwise.band(perms, 0o1000) != 0

        cond do
          uid not in [euid, 0] ->
            raise ArgumentError,
                  "refusing to listen under #{dir}: it is owned by uid #{uid}, " <>
                    "neither this daemon's uid #{euid} nor root"

          writable? and not sticky? ->
            raise ArgumentError,
                  "refusing to listen under #{dir}: its mode is #{format_mode(perms)}, " <>
                    "writable by group or others, so the socket directory beneath it " <>
                    "could be swapped for someone else's"

          true ->
            :ok
        end

      {:ok, %File.Stat{type: type}} ->
        raise ArgumentError, "refusing to listen under #{dir}: it is a #{type}, not a directory"

      {:error, reason} ->
        raise ArgumentError, "refusing to listen under #{dir}: #{:file.format_error(reason)}"
    end
  end

  defp ensure_socket_dir!(dir, euid) do
    case File.lstat(dir) do
      {:error, :enoent} ->
        case File.mkdir(dir) do
          :ok ->
            case File.lstat(dir) do
              {:ok, %File.Stat{type: :directory, uid: ^euid}} -> File.chmod!(dir, 0o700)
              _ -> raise_socket_dir(dir, "it changed while being created")
            end

          {:error, :eexist} ->
            :ok

          {:error, reason} ->
            raise_socket_dir(dir, :file.format_error(reason))
        end

      _ ->
        :ok
    end

    check_socket_dir!(dir, euid)
  end

  defp check_socket_dir!(dir, euid) do
    case File.lstat(dir) do
      {:ok, %File.Stat{type: :directory, mode: mode, uid: uid}} ->
        perms = Bitwise.band(mode, 0o7777)

        cond do
          uid != euid ->
            raise_socket_dir(dir, "it is owned by uid #{uid}, not this daemon's uid #{euid}")

          perms != 0o700 ->
            raise_socket_dir(
              dir,
              "its mode is #{format_mode(perms)}, and it must be 0700 — " <>
                "anyone who can traverse it can connect to the daemon (chmod 700 #{dir})"
            )

          true ->
            :ok
        end

      {:ok, %File.Stat{type: type}} ->
        raise_socket_dir(dir, "it is a #{type}, not a directory")

      {:error, reason} ->
        raise_socket_dir(dir, :file.format_error(reason))
    end
  end

  defp raise_socket_dir(dir, why),
    do: raise(ArgumentError, "refusing to listen in socket directory #{dir}: #{why}")

  defp format_mode(perms), do: "0" <> String.pad_leading(Integer.to_string(perms, 8), 3, "0")

  defp clear_stale_socket!(path) do
    case File.lstat(path) do
      {:error, :enoent} ->
        :ok

      {:ok, %File.Stat{type: :other}} ->
        case :gen_tcp.connect({:local, path}, 0, [:binary, active: false], 1_000) do
          {:ok, socket} ->
            :gen_tcp.close(socket)
            raise ArgumentError, "another daemon is listening on unix://#{path}"

          {:error, :econnrefused} ->
            File.rm!(path)
            :ok

          {:error, reason} ->
            raise ArgumentError,
                  "cannot tell whether unix://#{path} is live (#{inspect(reason)}); " <>
                    "leaving it in place — remove it by hand if no daemon holds it"
        end

      {:ok, %File.Stat{type: type}} ->
        raise ArgumentError,
              "refusing to listen on unix://#{path}: a #{type} is already there, not a stale socket"

      {:error, reason} ->
        raise ArgumentError, "refusing to listen on unix://#{path}: #{:file.format_error(reason)}"
    end
  end

  # The BEAM exposes no geteuid. `id -u` is POSIX and runs once per boot.
  defp effective_uid do
    {out, 0} = System.cmd("id", ["-u"])
    out |> String.trim() |> String.to_integer()
  end

  @doc "The string form of a parsed listen address."
  @spec format_listen(listen()) :: String.t()
  def format_listen({:tcp, ip, port}), do: "tcp://#{:inet.ntoa(ip)}:#{port}"
  def format_listen({:unix, path}), do: "unix://" <> path
end
