#!/usr/bin/env python3
"""
Fill data/<PHASE>.json with LINEARISED branch-along-pseudotime shapes (a stand-in).

The real branch shapes are geodesic shootings of the knot score vectors written by
tools/export_branch_pseudotime_scores.py, which need deformetrica. Until those are shot,
this script makes the same JSON entries from data already in the viewer: it takes the mode
displacement fields (mode k already stored at +/- n_sd) and adds them up in proportion to
the branch's PC scores at each knot,

    d(branch, knot) ~= sum_k  a_k * delta_k    with  a_k = score_k / (n_sd * SD_k),

using the +n_sd field where a_k >= 0 and the -n_sd field where a_k < 0, so the asymmetry
each geodesic mode already carries is kept. This is the small-deformation (tangent-space)
approximation of the SSM. It is not a substitute for shooting -- it is linear where the
model is not, and it is truncated to the modes the viewer stores (22 for ED, 18 for ES) --
but it is built from the real tree, the real branch scores and the real mode geometry, so
the shapes it produces are the right ones to about the accuracy of the linearisation, and
the viewer can be developed and judged against them.

Entries written per tag: branches[<name>] = {"pt": [...], "d": [[...], ...]}, the same
shape tools/build_web_meshes.py writes from shot meshes, so swapping in the real meshes
changes no viewer code. The JSON records provenance in "branch_source".

Run (project venv):
  venv_TRED_REMIT_analysis/bin/python3 tools/build_branch_knots_linear.py --phase ES
"""
from __future__ import annotations

import argparse
import json
import os

import numpy as np
import pandas as pd

from export_branch_pseudotime_scores import branch_knot_scores

_BASE = "/media/croderog/Bob/shape_analysis/TRED_REMIT"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--phase", required=True, choices=["ED", "ES"])
    ap.add_argument("--tree_dir", default=f"{_BASE}/DDRTree_EDES_ortho/All_Visits")
    ap.add_argument("--pca_csv", default=None, help="defaults to PCA_<phase>/PCA.csv")
    ap.add_argument("--n_knots", type=int, default=3)
    ap.add_argument("--span", default="5,95")
    ap.add_argument("--data_dir", default="data")
    args = ap.parse_args(argv)

    pca_csv = args.pca_csv or f"{_BASE}/PCA_{args.phase}/PCA.csv"
    span = [float(x) for x in args.span.split(",")]
    path = os.path.join(args.data_dir, f"{args.phase}.json")
    with open(path) as fh:
        data = json.load(fh)
    n_sd = float(data.get("n_sd", 3.0))
    stored_modes = sorted(int(k) for k in next(iter(data["tags"].values())).get("modes", {}))
    if not stored_modes:
        raise SystemExit(f"{path} has no mode fields to build the linearisation from")

    print(f"[{args.phase}] {n_sd} SD mode fields for modes {stored_modes[0]}..{stored_modes[-1]}"
          f" ({len(stored_modes)} of them)")
    pc_cols, per_branch, cohort = branch_knot_scores(args.tree_dir, pca_csv,
                                                     args.n_knots, span)

    sd = pd.read_csv(pca_csv, index_col="ID")[pc_cols].std(axis=0).values
    # mode k (1-based) <-> PC column k-1
    idx = np.array([k - 1 for k in stored_modes])
    denom = n_sd * sd[idx]

    items = {f"Branch_{b}": (per_branch[b][0], per_branch[b][1][:, idx]) for b in per_branch}
    items["cohort_mean_233"] = (None, cohort[idx][None, :])

    covered = (np.abs(cohort[idx]) ** 2).sum() / (np.abs(cohort) ** 2).sum()
    print(f"  truncation: stored modes carry {covered:.1%} of the cohort-mean score energy")

    for tag, entry in data["tags"].items():
        modes = entry.get("modes", {})
        n = len(entry["mean"])
        plus = {k: np.asarray(modes[str(k)]["plus"], dtype=float)
                for k in stored_modes if str(k) in modes}
        minus = {k: np.asarray(modes[str(k)]["minus"], dtype=float)
                 for k in stored_modes if str(k) in modes}
        out = {}
        for name, (knots, scores) in items.items():
            fields = []
            for row in scores:
                acc = np.zeros(n)
                for j, k in enumerate(stored_modes):
                    if k not in plus:
                        continue
                    a = row[j] / denom[j]
                    acc += a * plus[k] if a >= 0 else (-a) * minus[k]
                fields.append(np.rint(acc).astype(int).tolist())
            out[name] = {"pt": None if knots is None else [round(float(k), 6) for k in knots],
                         "d": fields}
        entry["branches"] = out

    data["branches"] = list(items)
    data["branch_source"] = "linearised (tangent-space stand-in, not geodesic shooting)"
    data["branch_knots"] = args.n_knots
    with open(path, "w") as fh:
        json.dump(data, fh)
    print(f"  wrote {path} ({os.path.getsize(path) / 1e6:.1f} MB); "
          f"branches: {', '.join(items)}")

    # Keep the manifest in step so the viewer offers the new branch list.
    man_path = os.path.join(args.data_dir, "manifest.json")
    with open(man_path) as fh:
        man = json.load(fh)
    man["phases"][args.phase]["branches"] = list(items)
    man["phases"][args.phase]["branch_source"] = "linearised"
    with open(man_path, "w") as fh:
        json.dump(man, fh, indent=2)
    print(f"  wrote {man_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
