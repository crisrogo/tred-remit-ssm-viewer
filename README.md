# TRED / REMIT cardiac SSM viewer

An interactive, static web viewer for the cardiac statistical shape model. Choose what to
show first — the **DDRTree** (ortho-tree branches) or PCA **shape modes** — then drag a
slider to deform the mean biventricular mesh. Each vertex is coloured by how far it moves
(dark purple = little, yellow = most). Rotate freely, zoom, show or hide each surface and
its wireframe, and switch the background between dark and white.

The DDRTree is fitted on ED and ES **together** (feature matrix `[PC_ED | ES-perp]`), so the
two views differ in whether a phase has to be chosen at all:

- **DDRTree** shapes are always drawn end-systolic, so there is no phase toggle. A minimap
  of the tree shows which branch is selected and where on it you are; click or drag to move.
- **Modes** belong to one phase's own PCA, so ED and ES are separate models and the phase
  toggle appears. The slider sweeps -3 SD .. mean .. +3 SD.

Two things could vary in the tree view, but a **Vary** toggle exposes only one at a time:

- **Towards branch** — the target is pinned to the branch's midpoint in pseudotime, and the
  morph slider runs **0% (the ES template, the SSM mean shape) to 100% (that midpoint
  shape)**, moving every vertex that fraction of the way.
- **Along branch** — the morph is pinned at 100% and the pseudotime slider walks the branch
  proximal to distal, so the shape shown is always the branch's own, only at a different
  position along it.

They are deliberately not both live at once. Together they compound: the shape you are
morphing towards would itself slide as pseudotime changed, so "100%" would not name one
fixed target, and the morph slider would mean something different at every pseudotime.

The displacement colour scale is fixed across a whole branch, computed over all its knots,
so walking towards the distal end genuinely shows more movement rather than recolouring to
the same maximum. In "Towards branch" this means the midpoint shape does not quite reach the
top of the bar, which is the honest reading: the midpoint is less extreme than the tip.

A URL hash deep-links a view, carrying only the quantity that is live:
`#modes/ES/5/2` (ES mode 5 at +2 SD), `#branches/ES/Branch_3/along/1.102` (Branch 3 at
pseudotime 1.102), `#branches/ES/Branch_3/blend/0.60` (Branch 3, 60% of the way to its
midpoint shape).

It is a single static page (Three.js, no build step) and runs on GitHub Pages.

## What the panel controls

Hovering DDRTree or Modes gives a short definition of each, and the same applies to the
Vary and Background buttons.

Every surface carries two tickboxes, one for the filled shape and one for its wireframe.
The row above them, marked "all", turns a whole column on or off at once and shows a dash
while only some of that column is on. A wireframe shares the geometry of its surface, so it
follows the morph without any extra work, and its colour follows the background.

The background switches between dark, which is easier to explore in, and white, for figures
and screenshots.

In the tree view a second copy of the minimap sits over the 3D scene, top right, captioned
with the branch on screen. There the other branches are left faint, so the active one reads
at a glance; it takes clicks and drags exactly as the copy in the panel does.

The link to the paper and its citation at the foot of the panel are placeholders. They are
plain text in `index.html`, marked with a comment, and nothing else reads them.

## The displacement colour scale

Colours run along viridis, stored as 13 hex stops in `data/manifest.json` and expanded into
a 256-entry lookup table when the page loads. Viridis is perceptually uniform, so equal
steps in displacement look like equal steps in colour, which the two-colour ramp it replaced
did not manage: over 64 equal steps the size of a step varied by a factor of 3.55 there
against 2.06 here (CIEDE2000, a proxy for the CAM02-UCS metric viridis was designed in). It
also holds the two ends further apart, 100.3 against 66.7 CIEDE2000 from zero to maximum
displacement, with lightness running L* 14.9 to 90.9 rather than 44.2 to 90.3.

To reproduce those numbers, try a different colourmap, or change the stop count:

```bash
python3 tools/make_colourmap.py                              # report only
python3 tools/make_colourmap.py --write data/manifest.json   # report, then update the stops
```

`tools/build_web_meshes.py` keeps its own copy of the stops in `_CMAP`, which it writes back
into the manifest on every rebuild, so change both together.

## View locally

```bash
cd tred-remit-ssm-viewer
python3 -m http.server 8000
# open http://localhost:8000/  in a browser
```

A local server is required (ES-module imports and `fetch` do not work from `file://`).

## Publish on GitHub Pages

```bash
gh repo create tred-remit-ssm-viewer --public --source=. --push
# or: git remote add origin git@github.com:<user>/tred-remit-ssm-viewer.git && git push -u origin main
```

Then on GitHub: Settings -> Pages -> Build and deployment -> Deploy from a branch ->
`main` / `/ (root)`. The site appears at `https://<user>.github.io/tred-remit-ssm-viewer/`.

## Repository layout

```
index.html            page + control panel
css/style.css         styling
js/main.js            viewer logic (load JSON, morph, colour, minimap, controls)
js/vendor/            Three.js + OrbitControls (pinned, r0.160.0)
data/manifest.json    phases / items / tags / colourmap / slider config
data/tree.json        DDRTree skeleton for the minimap (nodes, edges, branches, pseudotime)
data/ED.json          end-diastolic geometry (mean, branch knots, mode sweeps)
data/ES.json          end-systolic geometry
tools/                data-preparation scripts (and make_colourmap.py)
```

## Rebuilding the data when the tree changes

The tree is refitted often, and the viewer's branch geometry goes stale when it is: the
branch count, membership and pseudotime all move. Three things have to be rebuilt.

**1. The minimap** — cheap, reads the DDRTree output directly:

```bash
venv_TRED_REMIT_analysis/bin/python3 tools/build_tree_map.py
# --tree_dir defaults to DDRTree_EDES_ortho/All_Visits
```

**2. The branch score knots** — one PC-score row per branch per pseudotime knot:

```bash
venv_TRED_REMIT_analysis/bin/python3 tools/export_branch_pseudotime_scores.py --phase ES
# writes branch_pt_ES_scores.csv + branch_pt_ES_scores_knots.json
```

The tree view only ever renders end-systolic, so only ES has to be shot. The ED exporter
still works (`--phase ED`) should the ED branch shapes ever be wanted.

Each branch is sampled at `--n_knots` points (default 3: proximal, mid, distal) spaced
evenly between the 5th and 95th percentile of its members' pseudotime. The score at a knot
comes from a straight-line fit of the members' scores against pseudotime; within a branch
the relationship is linear to a good approximation (a quadratic term recovers under 4% of
the residual variance in either phase), so the fit is both more accurate and much less noisy
than averaging the few members sitting near a knot. Percentiles are used only for the
endpoints, not for the knots themselves: pseudotime is a node property and a branch's
terminal node carries many samples at once, so percentile knots collapse onto each other.

**3. The meshes** — geodesic shooting, on the machine holding the SSM and deformetrica:

```bash
python3 shape_analysis/shoot_branch_mean_shapes.py \
    --branch_scores_csv   /path/to/branch_pt_ES_scores.csv \
    --momenta_folder      /path/to/ES_SSM/output/ \
    --XML_folder          /path/to/ES_SSM/XML_files/ \
    --final_template_path /path/to/ES_SSM/output/ \
    --num_components all \
    --output_folder       /path/to/ES_SSM/PCA/branch_pt_shapes
```

Copy the endpoint (`tp_10`) meshes to one folder, then convert, passing the knots JSON so
each `Shooting_<i>` file is tied back to its branch and pseudotime:

```bash
python3 tools/build_web_meshes.py --phase ES \
    --branch_dir   /path/to/ES_branch_pt_meshes \
    --branch_knots /path/to/branch_pt_ES_scores_knots.json \
    --mode_dir     /path/to/ES_mode_meshes --out_dir data
```

Passing only one of `--branch_dir` / `--mode_dir` keeps the other kind from the JSON already
in `data/`, as long as it was built against the same template.

Mode meshes are shot the same way from `DDRTree/export_mode_scores.py --phase ES` output;
they only need rebuilding when the SSM itself changes, not when the tree is refitted.

Finally commit `data/ED.json`, `data/ES.json`, `data/tree.json` and `data/manifest.json`.

## Branch shapes currently in the viewer

`data/manifest.json` records `branch_source` per phase. `"shot"` means real geodesic
shootings. `"linearised"` means a stand-in built by `tools/build_branch_knots_linear.py`,
which sums the stored mode displacement fields in proportion to the branch's PC scores:

```
d(branch, knot) ~= sum_k  a_k * delta_k    with  a_k = score_k / (n_sd * SD_k)
```

taking the `+n_sd` field where `a_k >= 0` and the `-n_sd` field where it is negative, so each
mode's own asymmetry is kept. This is the small-deformation approximation of the SSM: built
from the real tree, the real branch scores and the real mode geometry, but linear where the
model is not, and truncated to the modes the viewer stores (22 for ED, 18 for ES, carrying
92% and 98% of the cohort-mean score energy). Checked against the shot `cohort_mean_233`
mesh, which does not depend on how the tree is partitioned, it agrees to 0.39 mm rms and
1.35 mm maximum. Good enough to develop and judge the viewer against; not a substitute for
shooting, and the viewer says so in its status line while it is in use.

## Data provenance

Branches are the phenotypes of the combined ortho DDRTree (feature matrix
`[PC_ED | ES-perp]`, 233 observations, currently six branches). Pseudotime is the geodesic
distance from the root node along the tree; it is a node property, so `tools/build_tree_map.py`
recovers it exactly for the nodes that carry no sample. Displacement is measured against the
SSM template (the `mean` reference, morph slider = 0).
