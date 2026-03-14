# Tapestry Viewer Setup

The tapestry viewer is a static site that renders felt DAGs as navigable graphs. It lives in a standalone repo that you clone once; `felt tapestry export` writes data into it.

## First Time

```bash
felt tapestry export    # auto-clones the template if ~/.felt/tapestries/ doesn't exist
```

Or manually:

```bash
git clone --depth 1 https://github.com/cailmdaley/tapestries.git ~/.felt/tapestries
```

## Exporting

From any project with `.felt/` fibers and `tapestry:` tags:

```bash
felt tapestry export                  # writes to ~/.felt/tapestries/data/{project}/
felt tapestry export --all-fibers     # include all fibers for sidebar
felt tapestry export --force          # re-copy all artifacts
felt tapestry export --name foo       # override project name
felt tapestry export --out /path/     # override output directory
```

## Serving Locally

```bash
npx serve -s ~/.felt/tapestries
```

Open `http://localhost:3000`. The landing page lists available tapestries from `data/manifest.json`.

## GitHub Pages

1. Create a new repo from the [tapestries template](https://github.com/cailmdaley/tapestries)
2. Enable Pages: Settings → Pages → Deploy from branch `main`, folder `/`
3. Export and push:

```bash
felt tapestry export --out /path/to/your-repo/data/myproject
cd /path/to/your-repo
git add -A && git commit -m "update tapestry" && git push
```

Your tapestries will be at `https://<user>.github.io/<repo>/`.

## Data Layout

```
~/.felt/tapestries/
  index.html                    # viewer (from template, rarely changes)
  assets/                       # JS/CSS bundles
  data/
    manifest.json               # city list (auto-updated by export)
    myproject/
      tapestry.json             # DAG: nodes, links, evidence, staleness
      tapestry/                 # artifact images
        specname/
          figure.png
      files/                    # linked files (optional)
```

## Keeping History Small

Artifact images accumulate. To cap repo size, periodically squash history:

```bash
cd ~/.felt/tapestries
KEEP=5
COUNT=$(git rev-list --count HEAD)
if [ "$COUNT" -gt "$KEEP" ]; then
  CUTPOINT=$(git rev-list HEAD | sed -n "${KEEP}p")
  REMOTE_URL=$(git remote get-url origin)
  git replace --graft "$CUTPOINT"
  git filter-repo --force --quiet
  git remote add origin "$REMOTE_URL"
  git push --force --set-upstream origin main
fi
```
