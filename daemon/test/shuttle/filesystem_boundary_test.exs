defmodule Shuttle.FilesystemBoundaryTest do
  use ExUnit.Case, async: true

  test "Poller filesystem refusals cross the HTTP result boundary as 503s" do
    for reason <- [:filesystem_unavailable, :store_inventory_unavailable] do
      message = "filesystem blocked at /protected/project"
      result = {:error, {reason, message}}

      assert {503, %{reason: code, message: ^message}} =
               ShuttleWeb.DispatchReply.render("tests/held", result)

      assert code == to_string(reason)

      conn =
        ShuttleWeb.RelayHelpers.send_cli_result(Plug.Test.conn(:post, "/"), "shuttle", result)

      assert conn.status == 503
      assert conn.resp_body == message
    end
  end

  test "daemon filesystem calls go through the bounded access layer" do
    violations =
      Path.wildcard("lib/**/*.ex")
      |> Enum.reject(&String.starts_with?(&1, "lib/mix/"))
      |> Enum.flat_map(fn path ->
        {_ast, calls} =
          path
          |> File.read!()
          |> Code.string_to_quoted!()
          |> Macro.prewalk([], fn
            {{:., _, [{:__aliases__, _, [:File]}, name]}, meta, args} = node, acc
            when name != :posix and is_list(args) ->
              {node, [{path, meta[:line], name} | acc]}

            {{:., _, [{:__aliases__, _, [:Path]}, :wildcard]}, meta, _args} = node, acc ->
              {node, [{path, meta[:line], :wildcard} | acc]}

            {{:., _, [:prim_file, name]}, meta, _args} = node, acc ->
              if access_layer?(path) do
                {node, acc}
              else
                {node, [{path, meta[:line], name} | acc]}
              end

            {{:., _, [:file, :open]}, meta, [_path, modes]} = node, acc ->
              if access_layer?(path) or (is_list(modes) and :raw in modes) do
                {node, acc}
              else
                {node, [{path, meta[:line], :non_raw_open} | acc]}
              end

            node, acc ->
              {node, acc}
          end)

        calls
      end)

    assert violations == [], "Unbounded filesystem calls: #{inspect(violations)}"
  end

  defp access_layer?(path),
    do:
      path == "lib/shuttle/file_access.ex" or
        String.starts_with?(path, "lib/shuttle/file_access/")
end
