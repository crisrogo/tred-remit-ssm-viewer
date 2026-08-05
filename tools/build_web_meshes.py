#!/usr/bin/env python3
"""
Convert shot SSM meshes (VTK) into the compact JSON the web viewer loads.

A phase (ED or ES) can carry two kinds of items:
  - branches: ortho-tree branch shapes sampled along pseudotime (unidirectional,
              mean -> branch, with several knots from proximal to distal),
  - modes:    a PCA shape mode swept to +/- n_sd (bidirectional, -SD .. mean .. +SD).

Branch meshes come from shooting the knot score vectors of
tools/export_branch_pseudotime_scores.py; pass the `*_knots.json` it writes alongside so
the Shooting_<index> files can be tied back to (branch, knot pseudotime). Without that
file the older one-mesh-per-branch layout (Shooting_1.. = Branch_0..) is assumed and each
branch gets a single knot. Mode meshes come from a mode-sweep shooting (Shooting_0 = mean,
Shooting_2k-1 / 2k = mode k at -n_sd / +n_sd SD). All shapes are shot from the same SSM
template, so topology is shared and the viewer morphs per vertex.

Output:
  data/<PHASE>.json     one phase's geometry (tags -> faces, mean, branches{}, modes{})
  data/manifest.json    merged index of phases / branches / modes / colourmap

Run (system python3 with pyvista):
  python3 tools/build_web_meshes.py --phase ES \
      --branch_dir   /media/.../DDRTree_EDES_ortho/branch_pt_meshes_ES \
      --branch_knots /media/.../DDRTree_EDES_ortho/branch_pt_ES_scores_knots.json \
      --mode_dir     /media/.../DDRTree_EDES_ortho/mode_scores_ES --out_dir data
  python3 tools/build_web_meshes.py --phase ED \
      --mode_dir   /media/.../DDRTree_EDES_ortho/mode_scores_ED --out_dir data
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re

import numpy as np
import pyvista as pv

# Legacy branch shooting index -> item label (one mesh per branch, no pseudotime).
_BRANCH_ITEM = {1: "Branch_0", 2: "Branch_1", 3: "Branch_2", 4: "Branch_3",
                5: "Branch_4", 6: "cohort_mean_233"}
# Displacement ramp, low -> high: viridis sampled at 13 stops. Perceptually uniform, so
# equal steps in displacement look like equal steps in colour. Regenerate (and see the
# uniformity check) with tools/make_colourmap.py.
_CMAP = ["#440154", "#481F70", "#443983", "#3B528B", "#31688E", "#287C8E", "#21918C",
         "#20A486", "#35B779", "#5EC962", "#90D743", "#C8E020", "#FDE725"]


def _branch_layout(knots_json):
    """-> {item: {'pt': [...]|None, 'index': [shooting index per knot]}}."""
    if knots_json is None:
        return {name: {"pt": None, "index": [i]} for i, name in sorted(_BRANCH_ITEM.items())}
    with open(knots_json) as fh:
        meta = json.load(fh)["branches"]
    return {name: {"pt": m["pt"], "index": list(m["index"])} for name, m in meta.items()}


def _tag(path):
    m = re.search(r"aligned_(.+?)__tp_", os.path.basename(path))
    return m.group(1) if m else os.path.basename(path)


def _index(path):
    m = re.search(r"Shooting_(\d+)__", os.path.basename(path))
    return int(m.group(1)) if m else -1


def _faces(mesh):
    f = mesh.faces.reshape(-1, 4)
    assert (f[:, 0] == 3).all(), "non-triangle face encountered"
    return f[:, 1:].astype(int).ravel().tolist()


def _read_dir(mesh_dir):
    """tag -> {shooting_index -> pyvista mesh} for Shooting_*tp_10*.vtk in a dir."""
    files = sorted(glob.glob(os.path.join(mesh_dir, "Shooting_*tp_10*.vtk")))
    if not files:
        raise SystemExit(f"No Shooting_*tp_10*.vtk in {mesh_dir}")
    by_tag = {}
    for f in files:
        by_tag.setdefault(_tag(f), {})[_index(f)] = pv.read(f)
    return by_tag


def build_phase(phase, branch_dir, mode_dir, out_dir, scale=20, n_sd=3.0, branch_knots=None):
    branch = _read_dir(branch_dir) if branch_dir else None
    layout = _branch_layout(branch_knots) if branch is not None else {}
    mode = _read_dir(mode_dir) if mode_dir else None
    ref = mode if mode is not None else branch
    if ref is None:
        raise SystemExit("Provide at least one of --branch_dir / --mode_dir")
    tags = sorted(ref)
    print(f"[{phase}] tags: {tags}; branches={branch is not None}, modes={mode is not None}")

    # Centre + radius from the template (index 0) across all tags.
    all_tmpl = np.vstack([ref[t][0].points for t in tags])
    centroid = all_tmpl.mean(axis=0)
    radius = float(np.linalg.norm(all_tmpl - centroid, axis=1).max())

    # Store the mean shape as float, and each item as INTEGER displacement from the mean
    # (units of 1/scale mm). Most vertices barely move, so the deltas are tiny integers and
    # the JSON stays small; the viewer reconstructs pos = mean + t * delta / scale.
    tpl = {t: ref[t][0].points for t in tags}

    def mean_flat(t):
        return (tpl[t] - centroid).round(2).ravel().tolist()

    def delta_int(t, pts):
        return ((pts - tpl[t]) * scale).round().astype(int).ravel().tolist()

    tags_out = {}
    for t in tags:
        entry = {"faces": _faces(ref[t][0]), "mean": mean_flat(t)}
        npts = ref[t][0].n_points
        if branch is not None and t in branch:
            entry["branches"] = {}
            for name, spec in layout.items():
                got = [i for i in spec["index"]
                       if i in branch[t] and branch[t][i].n_points == npts]
                if len(got) != len(spec["index"]):
                    continue                       # a knot is missing: drop the whole item
                entry["branches"][name] = {
                    "pt": spec["pt"],
                    "d": [delta_int(t, branch[t][i].points) for i in spec["index"]],
                }
        if mode is not None and t in mode:
            entry["modes"] = {}
            for idx, m in mode[t].items():
                if idx == 0 or m.n_points != npts:
                    continue
                k = (idx + 1) // 2                     # 1,2->1 ; 3,4->2 ; ...
                sign = "minus" if idx % 2 == 1 else "plus"
                entry["modes"].setdefault(str(k), {})[sign] = delta_int(t, m.points)
        tags_out[t] = entry

    branch_list = [name for name in layout
                   if any(name in tags_out[t].get("branches", {}) for t in tags)]
    mode_set = set()
    if mode is not None:
        for t in tags:
            mode_set.update(int(k) for k in tags_out[t].get("modes", {}))
    mode_list = sorted(mode_set)
    print(f"  branches: {branch_list}")
    print(f"  modes: {len(mode_list)} ({mode_list[:5]}{'...' if len(mode_list) > 5 else ''})")

    # Only one kind of mesh given: keep the other kind from the JSON already on disk rather
    # than dropping it, as long as the template it was built against still matches.
    keep_kind = "modes" if mode is None else ("branches" if branch is None else None)
    out_path = os.path.join(out_dir, f"{phase}.json")
    if keep_kind and os.path.exists(out_path):
        with open(out_path) as fh:
            prev = json.load(fh)
        shared = [t for t in tags
                  if t in prev.get("tags", {})
                  and len(prev["tags"][t]["mean"]) == len(tags_out[t]["mean"])
                  and prev.get("scale") == scale
                  and keep_kind in prev["tags"][t]]
        if len(shared) == len(tags):
            for t in tags:
                tags_out[t][keep_kind] = prev["tags"][t][keep_kind]
            if keep_kind == "modes":
                mode_list = prev.get("modes", [])
            else:
                branch_list = prev.get("branches", [])
            print(f"  kept existing {keep_kind} from {out_path}")
        else:
            print(f"  WARNING: existing {keep_kind} in {out_path} do not match this "
                  f"template ({len(shared)}/{len(tags)} tags) and were dropped")

    phase_json = {"phase": phase, "radius": round(radius, 3), "n_sd": n_sd,
                  "scale": scale, "branches": branch_list, "modes": mode_list,
                  "branch_source": "shot" if branch is not None else None,
                  "branch_knots": max((len(layout[n]["index"]) for n in branch_list), default=0),
                  "tags": tags_out}
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, f"{phase}.json"), "w") as fh:
        json.dump(phase_json, fh)
    mb = os.path.getsize(os.path.join(out_dir, f"{phase}.json")) / 1e6
    print(f"  wrote {out_dir}/{phase}.json ({mb:.1f} MB)")

    # Merge manifest (keep the other phase; scaffold both known phases).
    man_path = os.path.join(out_dir, "manifest.json")
    manifest = {"phases": {}, "colormap": _CMAP,
                "slider": {"min": 0, "max": 3, "step": 0.05, "default": 1.0},
                "title": "TRED / REMIT cardiac SSM viewer"}
    if os.path.exists(man_path):
        with open(man_path) as fh:
            manifest.update(json.load(fh))
    manifest.setdefault("phases", {})
    for p in ("ED", "ES"):
        manifest["phases"].setdefault(p, {"available": False, "branches": [], "modes": []})
    keep = manifest["phases"].get(phase, {})
    manifest["phases"][phase] = {"available": True,
                                 "branches": branch_list or keep.get("branches", []),
                                 "modes": mode_list or keep.get("modes", []),
                                 "n_sd": n_sd}
    if branch is not None:
        manifest["phases"][phase]["branch_source"] = "shot"
    elif "branch_source" in keep:
        manifest["phases"][phase]["branch_source"] = keep["branch_source"]
    manifest["colormap"] = _CMAP
    manifest["slider"] = {"min": 0, "max": 3, "step": 0.05, "default": 1.0}
    with open(man_path, "w") as fh:
        json.dump(manifest, fh, indent=2)
    print(f"  wrote {man_path}")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--phase", required=True, choices=["ED", "ES"])
    ap.add_argument("--branch_dir", default=None, help="dir of branch Shooting_*tp_10*.vtk")
    ap.add_argument("--branch_knots", default=None,
                    help="*_knots.json from export_branch_pseudotime_scores.py")
    ap.add_argument("--mode_dir", default=None, help="dir of mode-sweep Shooting_*tp_10*.vtk")
    ap.add_argument("--n_sd", type=float, default=3.0, help="SD the mode meshes were shot at")
    ap.add_argument("--out_dir", default="data")
    args = ap.parse_args(argv)
    build_phase(args.phase, args.branch_dir, args.mode_dir, args.out_dir, n_sd=args.n_sd,
                branch_knots=args.branch_knots)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
