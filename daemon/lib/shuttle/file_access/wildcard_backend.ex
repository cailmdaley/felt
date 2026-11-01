defmodule Shuttle.FileAccess.WildcardBackend do
  @moduledoc false
  alias Shuttle.FileAccess, as: Access

  # filelib expects native file_info records and charlist names. Every pathname
  # is resolved and checked inside the existing lease; permission failures
  # raise rather than being swallowed as empty discovery results by filelib.
  def read_file_info(path) do
    Access.run(to_string(path), fn resolved ->
      :file.read_file_info(Access.native(resolved), [:raw])
    end)
  end

  def read_link_info(path) do
    Access.run(
      to_string(path),
      fn resolved ->
        :file.read_link_info(Access.native(resolved), [:raw])
      end,
      follow_final: false
    )
  end

  def list_dir(path) do
    case Access.ls(to_string(path)) do
      {:ok, names} ->
        names =
          if Process.get({__MODULE__, :match_dot}, false),
            do: names,
            else: Enum.reject(names, &String.starts_with?(&1, "."))

        {:ok, Enum.map(names, &Access.native/1)}

      error ->
        error
    end
  end
end
