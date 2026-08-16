# design

Source artwork. Masters live here **untracked** (`/design/*.png` is ignored):
they are large, they change rarely, and every consumer in the repo is a small
derived asset committed alongside the code that references it.

## shuttle icon

`design/shuttle-icon-1024.png` — 1024×1024 master, 1.9MB. It was tracked at
`ui/public/shuttle-icon.png` until the favicon set was cut from it; recover it
from history with:

```bash
git cat-file blob 71b61fad8e13d9db7edf3daaf03b18fe4355dfc2 > design/shuttle-icon-1024.png
```

Derived, tracked, and served:

| asset | size | where |
| --- | --- | --- |
| `ui/public/favicon.ico` | 32×32 + 16×16 | `<link rel="icon">` in `ui/index.html` |
| `ui/public/apple-touch-icon.png` | 180×180 | `<link rel="apple-touch-icon">` |

Regenerate both with ImageMagick:

```bash
magick design/shuttle-icon-1024.png -strip -define icon:auto-resize=32,16 \
  ui/public/favicon.ico
magick design/shuttle-icon-1024.png -resize 180x180 -strip -colors 128 \
  PNG8:ui/public/apple-touch-icon.png
```

Anything added to `ui/public/` is copied wholesale into every vite bundle, and
`lib/shuttle_web/endpoint.ex`'s `Plug.Static` `only:` list decides what the
daemon actually serves — a file in `public/` that is not on that list 404s in
production.
