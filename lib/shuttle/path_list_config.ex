defmodule Shuttle.PathListConfig do
  @moduledoc """
  The one storage mechanism behind felt's path-list config files.

  Two files answer two different questions — `~/.config/felt/stores.json` (where
  the daemon enumerates fibers) and `~/.config/felt/projects.json` (which
  checkouts a human can file into) — and they must stay separate lists. But they
  are stored identically, and this module is that storage, parameterized by
  `{env_var, config_env_var, default_path, json_key}`:

    * `<ENV>` (comma-separated) wins over the file when non-empty;
    * `<ENV>_FILE` overrides the file's location;
    * the file decodes from `%{"<key>" => [path, ...]}` **or** a bare JSON
      array; anything else, or an absent/unreadable file, reads as `[]`;
    * writes are atomic (tmp + rename), and saving `[]` deletes the file;
    * every path is trimmed, expanded, and de-duplicated, in that order.

  That shape is Go-parity surface: `cmd/shuttle_stores.go` reimplements it and
  `cmd/shuttle_status_test.go` pins it. It is not free to change here alone.

  Callers stay the named modules (`Shuttle.FeltStores`, `Shuttle.Projects`);
  they keep their own moduledocs, function names, and any caching. This module
  owns only how a list of paths becomes bytes and back.

  `Shuttle.Remotes` is deliberately NOT a client: it holds structured entry maps
  with `Application.get_env` precedence and no compact env form, and its writer
  lives in Go.
  """

  @type spec :: %{
          env: String.t(),
          config_env: String.t(),
          default_path: String.t(),
          json_key: String.t()
        }

  @type path_list :: [String.t()]

  @doc "The list from `<ENV>` when set and non-empty, else from the file."
  @spec configured(spec()) :: path_list()
  def configured(spec) do
    case from_env(spec) do
      [_ | _] = paths -> paths
      [] -> registered(spec)
    end
  end

  @doc "The persisted list, or `[]` when the file is absent or unparseable."
  @spec registered(spec()) :: path_list()
  def registered(spec) do
    path = config_path(spec)
    key = spec.json_key

    with true <- File.exists?(path),
         {:ok, content} <- File.read(path),
         {:ok, decoded} <- Jason.decode(content) do
      case decoded do
        %{^key => paths} when is_list(paths) -> normalize(paths)
        paths when is_list(paths) -> normalize(paths)
        _ -> []
      end
    else
      _ -> []
    end
  end

  @doc """
  Persist the list atomically. An empty list deletes the file.
  Returns `{:ok, normalized}` or `{:error, reason}`.
  """
  @spec save(spec(), path_list()) :: {:ok, path_list()} | {:error, term()}
  def save(spec, paths) when is_list(paths) do
    normalized = normalize(paths)
    path = config_path(spec)

    try do
      case normalized do
        [] ->
          case File.rm(path) do
            :ok -> {:ok, normalized}
            {:error, :enoent} -> {:ok, normalized}
            {:error, reason} -> {:error, {:file_error, reason}}
          end

        _ ->
          File.mkdir_p!(Path.dirname(path))
          tmp = path <> ".tmp"
          File.write!(tmp, encode(spec, normalized))
          File.rename!(tmp, path)
          {:ok, normalized}
      end
    rescue
      error -> {:error, error}
    end
  end

  @doc "Where the file lives: `<ENV>_FILE` when set, else the default."
  @spec config_path(spec()) :: String.t()
  def config_path(spec) do
    case System.get_env(spec.config_env) do
      v when is_binary(v) and v != "" -> Path.expand(v)
      _ -> Path.expand(spec.default_path)
    end
  end

  @doc "The compact comma-separated `<ENV>` form, or `[]`."
  @spec from_env(spec()) :: path_list()
  def from_env(spec) do
    case System.get_env(spec.env) do
      v when is_binary(v) and v != "" -> v |> String.split(",") |> normalize()
      _ -> []
    end
  end

  # `version` leads, then the list — the file is hand-editable, so the key
  # order is stated here rather than left to whatever order a map iterates in.
  defp encode(spec, normalized) do
    body =
      normalized
      |> Enum.map_join(",\n", &("    " <> Jason.encode!(&1)))

    ~s({\n  "version": 1,\n  "#{spec.json_key}": [\n#{body}\n  ]\n}\n)
  end

  @doc "Trim, drop blanks and non-strings, expand, de-duplicate — in that order."
  @spec normalize(list()) :: path_list()
  def normalize(paths) do
    paths
    |> Enum.filter(&is_binary/1)
    |> Enum.map(&String.trim/1)
    |> Enum.reject(&(&1 == ""))
    |> Enum.map(&Path.expand/1)
    |> Enum.uniq()
  end
end
