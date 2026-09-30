#!/usr/bin/env python3
"""
Convert the shot Bonsai clade-mean meshes (VTK) into data/bonsai_<PHASE>.json for the viewer.

The meshes come from shooting tools/export_bonsai_clade_scores.py output with
shape_analysis/shoot_branch_mean_shapes.py (--num_components all). Row order, hence
Shooting_<index>: 0 template (all-zero scores), 1..7 = C1..C7, 8 = cohort mean.

The clades are stored as integer displacements from the SAME mean shape that
data/<PHASE>.json already holds (built by tools/build_web_meshes.py from the mode sweep), so the
viewer draws them on the geometry it has loaded. Before writing anything the script checks that
this shooting's template (Shooting_0) is that mean: same vertex count per surface, and the same
centred coordinates to the 0.01 mm rounding the viewer stores. It refuses otherwise.

It also adds `"bonsai": {"ES": [...], "ED": [...]}` to data/manifest.json, listing the clades
each phase holds; nothing else in the manifest changes.

Run (system python3 with pyvista, as build_web_meshes.py):
  python3 tools/build_bonsai_meshes.py --phase ES \
      --clade_dir /media/croderog/Bob/shape_analysis/TRED_REMIT/Bonsai_EDES_ortho/viewer/meshes_ES
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re

import numpy as np
import pyvista as pv


def _tag(path):
    m = re.search(r"aligned_(.+?)__tp_", os.path.basename(path))
    return m.group(1) if m else os.path.basename(path)


def _index(path):
    return int(re.search(r"Shooting_(\d+)__", os.path.basename(path)).group(1))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--phase", required=True, choices=["ED", "ES"])
    ap.add_argument("--clade_dir", required=True, help="dir of Shooting_*tp_10*.vtk")
    ap.add_argument("--n_clades", type=int, default=7)
    ap.add_argument("--n_scans", type=int, default=232, help="for the cohort-mean label")
    ap.add_argument("--out_dir", default="data")
    args = ap.parse_args(argv)

    # Read the shot meshes: tag -> {shooting index -> points}
    files = sorted(glob.glob(os.path.join(args.clade_dir, "Shooting_*tp_10*.vtk")))
    by_tag = {}
    for f in files:
        by_tag.setdefault(_tag(f), {})[_index(f)] = pv.read(f).points
    names = ["template"] + [f"C{i}" for i in range(1, args.n_clades + 1)] + \
            [f"cohort_mean_{args.n_scans}"]
    for t, d in by_tag.items():
        if sorted(d) != list(range(len(names))):
            raise SystemExit(f"{t}: expected Shooting_0..{len(names) - 1}, found {sorted(d)}")

    # The phase JSON the viewer already loads: its mean shape and displacement scale
    with open(os.path.join(args.out_dir, f"{args.phase}.json")) as fh:
        phase = json.load(fh)
    scale = phase["scale"]
    tags = sorted(phase["tags"])
    if sorted(by_tag) != tags:
        raise SystemExit(f"surfaces differ: {sorted(by_tag)} against {tags}")

    # Same centring as build_web_meshes.py: the template's centroid over all surfaces
    all_tmpl = np.vstack([by_tag[t][0] for t in tags])
    centroid = all_tmpl.mean(axis=0)
    worst = 0.0
    for t in tags:
        mean = np.array(phase["tags"][t]["mean"]).reshape(-1, 3)
        mine = (by_tag[t][0] - centroid).round(2)
        if mine.shape != mean.shape:
            raise SystemExit(f"{t}: {len(mine)} vertices against {len(mean)} in {args.phase}.json")
        worst = max(worst, float(np.abs(mine - mean).max()))
    if worst > 0.011:
        raise SystemExit(f"template differs from the {args.phase}.json mean by {worst:.3f} mm")
    print(f"[{args.phase}] template matches {args.phase}.json mean (max diff {worst:.3f} mm)")

    # Integer displacement of each clade from the template, in 1/scale mm
    out_tags = {}
    for t in tags:
        tpl = by_tag[t][0]
        out_tags[t] = {"clades": {n: ((by_tag[t][i] - tpl) * scale).round().astype(int)
                                  .ravel().tolist()
                                  for i, n in enumerate(names) if i > 0}}
        disp = [np.linalg.norm(by_tag[t][i] - tpl, axis=1).max() for i in range(1, len(names))]
        print(f"  {t}: max displacement per item (mm) " +
              ", ".join(f"{n} {d:.2f}" for n, d in zip(names[1:], disp)))
    out = {"phase": args.phase, "scale": scale, "clades": names[1:], "tags": out_tags}
    path = os.path.join(args.out_dir, f"bonsai_{args.phase}.json")
    with open(path, "w") as fh:
        json.dump(out, fh, separators=(",", ":"))
    print(f"  wrote {path} ({os.path.getsize(path) / 1e6:.2f} MB)")

    man_path = os.path.join(args.out_dir, "manifest.json")
    with open(man_path) as fh:
        manifest = json.load(fh)
    manifest.setdefault("bonsai", {})[args.phase] = names[1:]
    with open(man_path, "w") as fh:
        json.dump(manifest, fh, indent=2)
    print(f"  added bonsai.{args.phase} to {man_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
