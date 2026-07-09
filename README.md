# TRED / REMIT cardiac SSM viewer

An interactive, static web viewer for the cardiac statistical shape model. Pick a phase
(end-diastole or end-systole) and a branch of the combined ortho DDRTree, see the mean
biventricular mesh, and drag a slider to morph the mean toward that branch. Each vertex is
coloured by how far it moves (purple = little, yellow = most), so regions that change more
stand out. Rotate and zoom freely, and hide individual surfaces (LV endo, RV free wall,
septum, epicardium, valves).

It is a single static page (Three.js, no build step) and runs on GitHub Pages.

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
js/main.js            viewer logic (load JSON, morph, colour, controls)
js/vendor/            Three.js + OrbitControls (pinned, r0.160.0)
data/manifest.json    phases / items / tags / colourmap / slider config
data/ES.json          end-systolic branch geometry (populated)
data/ED.json          end-diastolic branch geometry (add via the steps below)
tools/                data-preparation scripts
```

## Adding a phase (e.g. ED) or more meshes

The geometry JSON is generated from geodesic-shooting output meshes. To populate ED:

1. Export the ED branch-mean PC scores (already done once; re-run if the tree changes):
   ```bash
   venv_TRED_REMIT_analysis/bin/python3 tools/export_branch_mean_scores.py --phase ED
   ```
   writes `branch_mean_ED_scores.csv` next to the ortho tree output.
2. On the machine with the ED SSM and deformetrica, shoot the branch-mean meshes:
   ```bash
   python3 shape_analysis/shoot_branch_mean_shapes.py \
       --branch_scores_csv  /path/to/branch_mean_ED_scores.csv \
       --momenta_folder     /path/to/ED_SSM/output/ \
       --XML_folder         /path/to/ED_SSM/XML_files/ \
       --final_template_path /path/to/ED_SSM/output/ \
       --num_components all \
       --output_folder      /path/to/ED_SSM/PCA/branch_shapes
   ```
3. Copy the endpoint (`tp_10`) meshes to a folder, then convert:
   ```bash
   python3 tools/build_web_meshes.py --mesh_dir /path/to/ED_branch_meshes --phase ED --out_dir data
   ```
4. Commit `data/ED.json` and the updated `data/manifest.json`, and push.

The same route adds mode-sweep items later (shoot each mode at +/- SD, convert, extend the
manifest); the viewer already treats items generically.

## Data provenance

Branches are the five phenotypes of the combined ortho DDRTree (feature matrix
`[PC_ED | ES-perp]`, 233 observations). Each branch mesh is the geodesic-shooting
reconstruction of that branch's mean PC-score vector in the phase's SSM. Displacement is
measured against the SSM template (the `mean` reference, slider = 0).
