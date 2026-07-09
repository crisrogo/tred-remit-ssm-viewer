#!/usr/bin/env python3
"""
Convert shot SSM branch meshes (VTK) into the compact JSON the web viewer loads.

For one phase (ED or ES) this reads the geodesic-shooting output meshes
(Shooting_<i>__...aligned_<tag>__tp_10__...vtk), and, per surface tag, writes the triangle
faces once, the template (mean) vertices, and each item's vertices. All shapes are shot from
the same template, so topology is shared and the viewer can morph mean -> item per vertex.

Shooting index -> item name (from the branch-mean export):
  0 = template (the mean; t=0 reference), 1..5 = Branch_0..4, 6 = cohort_mean_233.

Output:
  data/<PHASE>.json     one phase's geometry
  data/manifest.json    merged index of phases / items / tags / colourmap / slider

Run (system python3 with pyvista):
  python3 tools/build_web_meshes.py \
      --mesh_dir /media/croderog/Bob/shape_analysis/TRED_REMIT/DDRTree_EDES_ortho/branch_meshes \
      --phase ES --out_dir data
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re

import numpy as np
import pyvista as pv

# Shooting index -> item label (must match export_branch_mean_*_scores.py row order).
_INDEX_ITEM = {0: "template", 1: "Branch_0", 2: "Branch_1", 3: "Branch_2",
               4: "Branch_3", 5: "Branch_4", 6: "cohort_mean_233"}
_CMAP = ["#7A5E8A", "#F5E740"]  # project displacement anchors: low -> high


def _tag(path):
    m = re.search(r"aligned_(.+?)__tp_", os.path.basename(path))
    return m.group(1) if m else os.path.basename(path)


def _index(path):
    m = re.search(r"Shooting_(\d+)__", os.path.basename(path))
    return int(m.group(1)) if m else -1


def _faces(mesh):
    """Flat triangle index list from a pyvista PolyData (all cells triangles)."""
    f = mesh.faces.reshape(-1, 4)
    assert (f[:, 0] == 3).all(), "non-triangle face encountered"
    return f[:, 1:].astype(int).ravel().tolist()


def build_phase(mesh_dir, phase, out_dir, decimals=3):
    files = sorted(glob.glob(os.path.join(mesh_dir, "Shooting_*tp_10*.vtk")))
    if not files:
        raise SystemExit(f"No Shooting_*tp_10*.vtk meshes in {mesh_dir}")

    # group: tag -> {index -> mesh}
    by_tag = {}
    for f in files:
        by_tag.setdefault(_tag(f), {})[_index(f)] = pv.read(f)
    tags = sorted(by_tag)
    print(f"[{phase}] tags: {tags}")

    # Global centroid + radius from the template (index 0) across all tags, for centring
    # and camera framing.
    all_tmpl = np.vstack([by_tag[t][0].points for t in tags])
    centroid = all_tmpl.mean(axis=0)
    radius = float(np.linalg.norm(all_tmpl - centroid, axis=1).max())

    item_indices = sorted(i for i in _INDEX_ITEM if i != 0 and any(i in by_tag[t] for t in tags))
    items = [_INDEX_ITEM[i] for i in item_indices]

    tags_out = {}
    for t in tags:
        tmpl = (by_tag[t][0].points - centroid).round(decimals)
        entry = {"faces": _faces(by_tag[t][0]), "mean": tmpl.ravel().tolist(), "items": {}}
        for i in item_indices:
            if i in by_tag[t]:
                v = (by_tag[t][i].points - centroid).round(decimals)
                entry["items"][_INDEX_ITEM[i]] = v.ravel().tolist()
        tags_out[t] = entry
        print(f"  {t:<16} {by_tag[t][0].n_points} pts, {len(entry['items'])} items")

    phase_json = {"phase": phase, "radius": round(radius, 3),
                  "items": items, "tags": tags_out}
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, f"{phase}.json"), "w") as fh:
        json.dump(phase_json, fh)
    print(f"  wrote {out_dir}/{phase}.json")

    # Merge the manifest (keep other phases; scaffold known phases without data).
    man_path = os.path.join(out_dir, "manifest.json")
    manifest = {"phases": {}, "tags": tags, "colormap": _CMAP,
                "slider": {"min": 0, "max": 3, "step": 0.05, "default": 1.0},
                "title": "TRED / REMIT cardiac SSM viewer"}
    if os.path.exists(man_path):
        with open(man_path) as fh:
            manifest.update(json.load(fh))
    manifest.setdefault("phases", {})
    for p in ("ED", "ES"):
        manifest["phases"].setdefault(p, {"available": False, "items": []})
    manifest["phases"][phase] = {"available": True, "items": items}
    manifest["tags"] = tags
    manifest["colormap"] = _CMAP
    manifest["slider"] = {"min": 0, "max": 3, "step": 0.05, "default": 1.0}
    with open(man_path, "w") as fh:
        json.dump(manifest, fh, indent=2)
    print(f"  wrote {man_path}")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--mesh_dir", required=True, help="dir of Shooting_*tp_10*.vtk meshes")
    ap.add_argument("--phase", required=True, choices=["ED", "ES"])
    ap.add_argument("--out_dir", default="data", help="viewer data dir (default: data)")
    args = ap.parse_args(argv)
    build_phase(args.mesh_dir, args.phase, args.out_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
