defmodule ShuttleWeb.AttachmentsControllerTest do
  use ExUnit.Case
  import Shuttle.Test.ApiConn
  import Shuttle.Test.EnvHelpers
  import Phoenix.ConnTest

  @endpoint ShuttleWeb.Endpoint

  @png <<0x89, "PNG", 0x0D, 0x0A, 0x1A, 0x0A, "a tiny png body">>

  defmodule ForwardClient do
    use Agent

    def start_link(response),
      do: Agent.start_link(fn -> %{response: response, last: nil} end, name: __MODULE__)

    def last, do: Agent.get(__MODULE__, & &1.last)

    def post(url, body, _content_type, timeout_ms) do
      Agent.update(__MODULE__, &Map.put(&1, :last, %{url: url, body: body, timeout: timeout_ms}))
      Agent.get(__MODULE__, & &1.response)
    end
  end

  setup do
    root =
      System.tmp_dir!()
      |> Path.join("shuttle-attachments-#{System.unique_integer([:positive])}")
      |> Path.expand()

    store = Path.join(root, "loom")
    fiber_dir = Path.join([store, ".felt", "tests", "paste"])
    File.mkdir_p!(fiber_dir)
    File.write!(Path.join(fiber_dir, "paste.md"), "---\nname: Paste\n---\n\n")

    data_dir = Path.join(root, "data")
    previous = Map.new(~w(SHUTTLE_STORES SHUTTLE_DATA_DIR), &{&1, System.get_env(&1)})
    System.put_env("SHUTTLE_STORES", store)
    System.put_env("SHUTTLE_DATA_DIR", data_dir)

    on_exit(fn ->
      Enum.each(previous, fn {key, value} -> restore_env(key, value) end)
      File.rm_rf(root)
    end)

    %{data_dir: data_dir, root: root}
  end

  defp image(bytes \\ @png, mime \\ "image/png", name \\ "shot.png") do
    %{
      "name" => name,
      "mime" => mime,
      "data" => Base.encode64(bytes),
      "sha256" => sha(bytes)
    }
  end

  defp sha(bytes), do: :crypto.hash(:sha256, bytes) |> Base.encode16(case: :lower)

  defp upload(body), do: post(api_conn(), "/api/v1/attachments", Jason.encode!(body))

  test "writes the image on this host and returns its absolute path", %{data_dir: data_dir} do
    conn = upload(%{"fiber" => "tests/paste", "attachments" => [image()]})

    assert conn.status == 200
    assert %{"files" => [file]} = Jason.decode!(conn.resp_body)
    assert file["name"] == "shot.png"
    assert file["sha256"] == sha(@png)
    assert file["size"] == byte_size(@png)

    path = file["path"]
    assert Path.type(path) == :absolute
    assert String.starts_with?(path, Path.join(data_dir, "attachments") <> "/")
    assert Path.basename(path) == binary_part(sha(@png), 0, 16) <> ".png"
    assert File.read!(path) == @png

    assert {:ok, %File.Stat{mode: mode}} = File.stat(path)
    assert Bitwise.band(mode, 0o777) == 0o600
    assert {:ok, %File.Stat{mode: dir_mode}} = File.stat(Path.dirname(path))
    assert Bitwise.band(dir_mode, 0o777) == 0o700

    # Nothing but the image is left behind in the directory.
    assert File.ls!(Path.dirname(path)) == [Path.basename(path)]
  end

  test "a re-send is idempotent: same path, one file" do
    body = %{"fiber" => "tests/paste", "attachments" => [image(), image()]}
    first = Jason.decode!(upload(body).resp_body)["files"]
    second = Jason.decode!(upload(body).resp_body)["files"]

    assert [%{"path" => path}, %{"path" => path}] = first
    assert Enum.map(second, & &1["path"]) == [path, path]
    assert File.ls!(Path.dirname(path)) == [Path.basename(path)]
  end

  test "keeps request order and maps each mime to its extension" do
    jpeg = <<0xFF, 0xD8, 0xFF, 0xE0, "jpeg">>
    gif = "GIF89a" <> "gif body"
    webp = "RIFF" <> <<0, 0, 0, 0>> <> "WEBP" <> "body"

    conn =
      upload(%{
        "fiber" => "tests/paste",
        "attachments" => [
          image(jpeg, "image/jpeg", "a.jpg"),
          image(gif, "image/gif", "b.gif"),
          image(webp, "image/webp", "c.webp")
        ]
      })

    assert conn.status == 200
    files = Jason.decode!(conn.resp_body)["files"]
    assert Enum.map(files, &Path.extname(&1["path"])) == [".jpg", ".gif", ".webp"]
    assert Enum.map(files, & &1["name"]) == ["a.jpg", "b.gif", "c.webp"]
  end

  describe "rejections" do
    test "an unknown fiber is a 404 and writes nothing", %{data_dir: data_dir} do
      conn = upload(%{"fiber" => "tests/nope", "attachments" => [image()]})
      assert conn.status == 404
      assert Jason.decode!(conn.resp_body)["error"] =~ "not found"
      refute File.exists?(Path.join(data_dir, "attachments"))
    end

    test "a missing fiber is a 400" do
      conn = upload(%{"attachments" => [image()]})
      assert conn.status == 400
      assert Jason.decode!(conn.resp_body)["error"] =~ "fiber"
    end

    test "a non-image mime is a 400" do
      conn = upload(%{"fiber" => "tests/paste", "attachments" => [image("hi", "text/plain")]})
      assert conn.status == 400
      assert Jason.decode!(conn.resp_body)["error"] =~ "not an accepted image type"
    end

    test "bytes that are not the declared image type are a 400" do
      conn = upload(%{"fiber" => "tests/paste", "attachments" => [image("not a png")]})
      assert conn.status == 400
      assert Jason.decode!(conn.resp_body)["error"] =~ "not a image/png image"
    end

    test "an oversized image is a 400" do
      big = @png <> :binary.copy(<<0>>, Shuttle.Attachments.max_file_bytes())
      conn = upload(%{"fiber" => "tests/paste", "attachments" => [image(big)]})
      assert conn.status == 400
      assert Jason.decode!(conn.resp_body)["error"] =~ "larger than"
    end

    test "more than the per-send limit is a 400" do
      many = List.duplicate(image(), Shuttle.Attachments.max_files() + 1)
      conn = upload(%{"fiber" => "tests/paste", "attachments" => many})
      assert conn.status == 400
      assert Jason.decode!(conn.resp_body)["error"] =~ "at most 8 images"
    end

    test "a total over the batch limit is a 400" do
      # Three images under the per-image limit whose sum is over the total.
      chunk = @png <> :binary.copy(<<0>>, div(Shuttle.Attachments.max_total_bytes(), 3) + 1024)

      images =
        for n <- 1..3 do
          image(chunk <> <<n>>)
        end

      conn = upload(%{"fiber" => "tests/paste", "attachments" => images})
      assert conn.status == 400
      assert Jason.decode!(conn.resp_body)["error"] =~ "the limit is"
    end

    test "a sha256 that does not match the bytes is a 400", %{data_dir: data_dir} do
      wrong = Map.put(image(), "sha256", String.duplicate("0", 64))
      conn = upload(%{"fiber" => "tests/paste", "attachments" => [image(), wrong]})
      assert conn.status == 400
      assert Jason.decode!(conn.resp_body)["error"] =~ "image 2: sha256 does not match"
      # The batch is all-or-nothing: the valid first image was not written.
      refute File.exists?(Path.join(data_dir, "attachments"))
    end

    test "bad base64 is a 400" do
      bad = Map.put(image(), "data", "%%%not base64%%%")
      conn = upload(%{"fiber" => "tests/paste", "attachments" => [bad]})
      assert conn.status == 400
      assert Jason.decode!(conn.resp_body)["error"] =~ "not valid base64"
    end

    test "an empty or missing attachment list is a 400" do
      assert upload(%{"fiber" => "tests/paste", "attachments" => []}).status == 400
      assert upload(%{"fiber" => "tests/paste"}).status == 400
    end
  end

  test "refuses to write through a symlinked attachments directory", %{
    data_dir: data_dir,
    root: root
  } do
    elsewhere = Path.join(root, "elsewhere")
    File.mkdir_p!(elsewhere)
    File.mkdir_p!(data_dir)
    File.ln_s!(elsewhere, Path.join(data_dir, "attachments"))

    conn = upload(%{"fiber" => "tests/paste", "attachments" => [image()]})
    assert conn.status == 500
    assert Jason.decode!(conn.resp_body)["error"] =~ "not a directory"
    assert File.ls!(elsewhere) == []
  end

  test "forwards a remote-origin upload to the owning daemon, origin stripped" do
    start_supervised!(
      {ForwardClient,
       {:ok, 200, Jason.encode!(%{"files" => [%{"path" => "/remote/attachments/x.png"}]})}}
    )

    previous_remotes = Application.get_env(:shuttle, :remotes)
    previous_client = Application.get_env(:shuttle, :write_forward_client)
    Application.put_env(:shuttle, :remotes, [%{name: "cluster", url: "http://localhost:4001"}])
    Application.put_env(:shuttle, :write_forward_client, ForwardClient)

    on_exit(fn ->
      restore_app_env(:remotes, previous_remotes)
      restore_app_env(:write_forward_client, previous_client)
    end)

    conn =
      upload(%{"fiber" => "tests/remote-only", "origin" => "cluster", "attachments" => [image()]})

    assert conn.status == 200

    assert Jason.decode!(conn.resp_body) == %{
             "files" => [%{"path" => "/remote/attachments/x.png"}]
           }

    last = ForwardClient.last()
    assert last.url == "http://localhost:4001/api/v1/attachments"
    assert last.timeout >= 120_000
    forwarded = Jason.decode!(last.body)
    refute Map.has_key?(forwarded, "origin")
    assert forwarded["fiber"] == "tests/remote-only"
    assert [%{"sha256" => sha}] = forwarded["attachments"]
    assert sha == sha(@png)
  end

  test "a failed forward is a 502 naming the origin" do
    start_supervised!({ForwardClient, {:error, :econnrefused}})

    previous_remotes = Application.get_env(:shuttle, :remotes)
    previous_client = Application.get_env(:shuttle, :write_forward_client)
    Application.put_env(:shuttle, :remotes, [%{name: "cluster", url: "http://localhost:4001"}])
    Application.put_env(:shuttle, :write_forward_client, ForwardClient)

    on_exit(fn ->
      restore_app_env(:remotes, previous_remotes)
      restore_app_env(:write_forward_client, previous_client)
    end)

    conn = upload(%{"fiber" => "tests/paste", "origin" => "cluster", "attachments" => [image()]})
    assert conn.status == 502
    assert Jason.decode!(conn.resp_body)["error"] =~ "cluster"
  end

  test "the endpoint parses a body larger than the default 8 MB ceiling" do
    chunk = @png <> :binary.copy(<<1>>, 7 * 1024 * 1024)
    images = [image(chunk <> "a"), image(chunk <> "b")]
    conn = upload(%{"fiber" => "tests/paste", "attachments" => images})
    assert conn.status == 200
  end
end
