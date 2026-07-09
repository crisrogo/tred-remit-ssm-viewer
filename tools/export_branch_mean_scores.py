#!/usr/bin/env python3
"""
Export branch-mean PC score vectors for one phase (ED or ES) of the combined ortho DDRTree.

Per ortho-tree branch, take the mean of its members' raw PC scores from that phase's
PCA.csv. Feed the result through shape_analysis/shoot_branch_mean_shapes.py (against that
phase's SSM) to shoot the branch-mean meshes, then tools/build_web_meshes.py to add the
phase to the viewer.

Row order (the Shooting_<index> order downstream):
  0 template, 1..5 = Branch_0..4, 6 = cohort_mean_233.

Run (project venv):
  venv_TRED_REMIT_analysis/bin/python3 tools/export_branch_mean_scores.py --phase ED
"""
from __future__ import annotations

import argparse

import numpy as np
import pandas as pd

_BASE = "/media/croderog/Bob/shape_analysis/TRED_REMIT"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--phase", required=True, choices=["ED", "ES"])
    ap.add_argument("--tree_dir", default=f"{_BASE}/DDRTree_EDES_ortho/All_Visits")
    ap.add_argument("--pca_csv", default=None, help="defaults to PCA_<phase>/PCA.csv")
    ap.add_argument("--out_csv", default=None,
                    help="defaults to DDRTree_EDES_ortho/branch_mean_<phase>_scores.csv")
    args = ap.parse_args(argv)

    pca_csv = args.pca_csv or f"{_BASE}/PCA_{args.phase}/PCA.csv"
    out_csv = args.out_csv or f"{_BASE}/DDRTree_EDES_ortho/branch_mean_{args.phase}_scores.csv"

    assign = pd.read_csv(f"{args.tree_dir}/sample_branch_assignments.csv")
    assign["branch"] = assign["branch_id"].astype(int)
    pca = pd.read_csv(pca_csv, index_col="ID")
    pc_cols = [c for c in pca.columns if str(c).upper().startswith("PC")]

    common = pca.index.intersection(assign.set_index("sample_id").index)
    br = assign.set_index("sample_id").loc[common, "branch"]
    scores = pca.loc[common, pc_cols]
    print(f"[{args.phase}] {len(common)} observations with PC scores; {len(pc_cols)} PCs")

    ids, rows = ["template"], [np.zeros(len(pc_cols))]
    for b in sorted(br.unique()):
        members = br.index[br == b]
        ids.append(f"Branch_{b}"); rows.append(scores.loc[members].mean().values)
        print(f"  Branch {b}: {len(members)} obs")
    ids.append("cohort_mean_233"); rows.append(scores.mean().values)

    out = pd.DataFrame(rows, columns=pc_cols); out.insert(0, "ID", ids)
    out.to_csv(out_csv, index=False)
    print(f"\nWrote {out_csv}  ({out.shape[0]} rows x {len(pc_cols)} PCs)")
    print("Shooting index -> item: " + ", ".join(f"{i}={n}" for i, n in enumerate(ids)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
