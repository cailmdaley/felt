defmodule Shuttle.DispatchImagesTest do
  use ExUnit.Case, async: true

  alias Shuttle.DispatchImages
  alias Shuttle.Test.Env

  @moduletag :tmp_dir
  @png <<0x89, "PNG", 0x0D, 0x0A, 0x1A, 0x0A, "pixels">>

  setup %{tmp_dir: dir} do
    Env.put_env("SHUTTLE_DATA_DIR", dir)
    %{dir: dir}
  end

  test "no images leaves the message alone" do
    assert DispatchImages.attach("hi", nil) == {:ok, "hi"}
    assert DispatchImages.attach(nil, []) == {:ok, nil}
  end

  test "lands each image content-addressed and names its path after the message", %{dir: dir} do
    image = %{"name" => "../../evil.sh", "data" => Base.encode64(@png)}
    assert {:ok, message} = DispatchImages.attach("look at this", [image, image])
    path = Path.join([dir, "images", Base.encode16(:crypto.hash(:sha256, @png), case: :lower) <> ".png"])
    assert message == "look at this\n\n[Image: #{path}]\n[Image: #{path}]"
    assert File.read!(path) == @png
    assert {:ok, "[Image: " <> _} = DispatchImages.attach(nil, [image])
  end

  test "refuses what is not an image" do
    assert {:error, _} = DispatchImages.attach("x", [%{"data" => Base.encode64("#!/bin/sh")}])
    assert {:error, _} = DispatchImages.attach("x", [%{"data" => "not base64!"}])
    assert {:error, _} = DispatchImages.attach("x", "nope")
    assert {:error, _} = DispatchImages.attach("x", List.duplicate(%{"data" => Base.encode64(@png)}, 9))
  end
end
