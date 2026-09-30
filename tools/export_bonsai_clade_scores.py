#!/usr/bin/env python3
"""
Export clade-mean PC score vectors of the Bonsai tree for one phase (ED or ES), for shooting.

Per Bonsai clade (the seven clades carried forward by bonsai/3_structure_and_stability.py in
TRED_REMIT_analysis, named C1..C7 by size in Bonsai_EDES_ortho/figures/clade_names.csv), take the
mean of its members' raw PC scores from that phase's PCA.csv, over every column the file holds, so
the mean shape is exact in the full basis. Feed the result through
shape_analysis/shoot_branch_mean_shapes.py (against that phase's SSM, --num_components all), then
tools/build_web_meshes.py.

Row order (the Shooting_<index> order downstream):
  0 template, 1..7 = C1..C7, 8 = cohort_mean_<n observations>.

The clades are a description of where scans sit on the tree, not sub-phenotypes: they are no
better separated than clades cut from trees fitted to data without structure, and they change when
a fifth of the patients is left out (bonsai/VERIFY_bonsai_companion.md, B3).

Run (project venv of TRED_REMIT_analysis):
  venv_TRED_REMIT_analysis/bin/python3 tools/export_bonsai_clade_scores.py --phase ES
"""
from __future__ import annotations

import argparse
import os

import numpy as np
import pandas as pd

_BASE = "/media/croderog/Bob/shape_analysis/TRED_REMIT"
_BONSAI = f"{_BASE}/Bonsai_EDES_ortho"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--phase", required=True, choices=["ED", "ES"])
    ap.add_argument("--clades_csv", default=f"{_BONSAI}/results/structure/carried_forward_clades.csv")
    ap.add_argument("--names_csv", default=f"{_BONSAI}/figures/clade_names.csv")
    ap.add_argument("--pca_csv", default=None, help="defaults to PCA_<phase>/PCA.csv")
    ap.add_argument("--out_csv", default=None,
                    help="defaults to Bonsai_EDES_ortho/viewer/clade_mean_<phase>_scores.csv")
    args = ap.parse_args(argv)

    pca_csv = args.pca_csv or f"{_BASE}/PCA_{args.phase}/PCA.csv"
    out_csv = args.out_csv or f"{_BONSAI}/viewer/clade_mean_{args.phase}_scores.csv"

    # Clade of every scan, renamed C1..C7
    clades = pd.read_csv(args.clades_csv, index_col="ID")["k7"]
    names = pd.read_csv(args.names_csv).set_index("bonsai_label")["name"]
    clades = clades.map(names)
    pca = pd.read_csv(pca_csv, index_col="ID")
    pc_cols = [c for c in pca.columns if str(c).upper().startswith("PC")]
    missing = clades.index.difference(pca.index)
    if len(missing):
        raise SystemExit(f"{len(missing)} clade members have no {args.phase} PC scores, "
                         f"e.g. {list(missing[:3])}")
    scores = pca.loc[clades.index, pc_cols]
    print(f"[{args.phase}] {len(scores)} observations; {len(pc_cols)} PCs")

    ids, rows = ["template"], [np.zeros(len(pc_cols))]
    for c in sorted(clades.unique(), key=lambda x: int(x[1:])):
        members = clades.index[clades == c]
        ids.append(c)
        rows.append(scores.loc[members].mean().values)
        print(f"  {c}: {len(members)} obs")
    ids.append(f"cohort_mean_{len(scores)}")
    rows.append(scores.mean().values)

    out = pd.DataFrame(rows, columns=pc_cols)
    out.insert(0, "ID", ids)
    os.makedirs(os.path.dirname(out_csv), exist_ok=True)
    if os.path.exists(out_csv):
        raise SystemExit(f"{out_csv} exists; not overwriting")
    out.to_csv(out_csv, index=False)
    print(f"\nWrote {out_csv}  ({out.shape[0]} rows x {len(pc_cols)} PCs)")
    print("Shooting index -> item: " + ", ".join(f"{i}={n}" for i, n in enumerate(ids)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
