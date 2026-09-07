#!/usr/bin/env python3
"""
Export PC score vectors sampled ALONG each ortho-tree branch, for geodesic shooting.

The old export gave one mean score vector per branch, so the viewer could only show a
branch as a single shape. To let the viewer walk a branch from proximal to distal, each
branch is instead sampled at K pseudotime knots.

At a knot the score vector is read off a straight-line fit of the branch members' scores
against pseudotime, not from the members near that knot. Within a branch the scores are
close to linear in pseudotime: on the rebuilt tree a quadratic term recovers at most 6.8%
of the linear residual variance in ED and 7.9% in ES, worst branch of six. A fit also uses
all the members rather than the handful sitting near a knot, so it is both the better
estimate and far less noisy at the branch ends where members thin out.

The bound depends on the smallest branch. The pre-rebuild seven-branch tree had a branch of
ten members where the quadratic recovered 13.2% (ED) and 19.9% (ES); the rebuilt tree's
smallest branch holds 27, and no branch exceeds 7.9%.

Knots are spaced evenly between two percentiles of the members' pseudotime (default the
5th and 95th), so they stay inside the observed range without being dragged by the tails.
They are NOT placed at percentiles themselves: pseudotime is a node property and the
terminal node of a branch carries many samples at once, so percentile knots collapse onto
each other (on the current tree the 50th and 90th percentile coincide for four of the six
branches). With an odd K the middle knot is the branch midpoint, which is what the viewer
shows first when a branch is picked.

Row order in the output CSV (the Shooting_<index> order downstream):
  0                     template          all-zero scores -> the SSM template / mean shape
  1 .. B*K              Branch_b__k<j>    branch b at knot j, b outer / j inner
  B*K + 1               cohort_mean_<n>   mean scores over all <n> tree observations

Run (project venv):
  venv_TRED_REMIT_analysis/bin/python3 tools/export_branch_pseudotime_scores.py --phase ES
"""
from __future__ import annotations

import argparse
import json
import os

import numpy as np
import pandas as pd

_BASE = "/media/croderog/Bob/shape_analysis/TRED_REMIT"


def branch_knot_scores(tree_dir, pca_csv, n_knots, span_pcts):
    """-> (pc_cols, {branch_id: (pseudotimes[K], scores[K, n_pc])}, cohort_mean[n_pc])."""
    assign = pd.read_csv(f"{tree_dir}/sample_branch_assignments.csv")
    assign["branch"] = assign["branch_id"].astype(int)
    ptime = pd.read_csv(f"{tree_dir}/pseudotime.csv").set_index("sample_id")["pseudotime"]
    pca = pd.read_csv(pca_csv, index_col="ID")
    pc_cols = [c for c in pca.columns if str(c).upper().startswith("PC")]

    a = assign.set_index("sample_id")
    common = pca.index.intersection(a.index).intersection(ptime.index)
    br = a.loc[common, "branch"]
    pt = ptime.loc[common]
    scores = pca.loc[common, pc_cols]
    print(f"  {len(common)} observations with scores, pseudotime and a branch; "
          f"{len(pc_cols)} PCs")

    out = {}
    for b in sorted(br.unique()):
        m = br.index[br == b]
        t = pt.loc[m].values
        X = scores.loc[m].values
        lo, hi = np.percentile(t, span_pcts)
        knots = np.linspace(lo, hi, n_knots)
        design = np.vstack([np.ones_like(t), t]).T
        coef, *_ = np.linalg.lstsq(design, X, rcond=None)          # [intercept; slope]
        fitted = np.vstack([np.ones_like(knots), knots]).T @ coef
        out[int(b)] = (knots, fitted)
        drift = np.linalg.norm(fitted[-1] - fitted[0])
        # members nearest each knot, as a check that no knot is left unsupported
        support = np.bincount(np.abs(t[:, None] - knots[None, :]).argmin(axis=1),
                              minlength=n_knots)
        print(f"    Branch_{b}: n={len(m):3d}  pt {t.min():.3f}..{t.max():.3f}  "
              f"knots {np.round(knots, 3).tolist()}  nearest-member support "
              f"{support.tolist()}  proximal->distal drift {drift:.1f}")
    return pc_cols, out, scores.mean().values, len(common)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--phase", required=True, choices=["ED", "ES"])
    ap.add_argument("--tree_dir", default=f"{_BASE}/DDRTree_EDES_ortho/All_Visits")
    ap.add_argument("--pca_csv", default=None, help="defaults to PCA_<phase>/PCA.csv")
    ap.add_argument("--n_knots", type=int, default=3,
                    help="knots per branch, evenly spaced across --span (odd keeps a midpoint)")
    ap.add_argument("--span", default="5,95",
                    help="member-pseudotime percentiles bounding the knots")
    ap.add_argument("--out_csv", default=None,
                    help="defaults to DDRTree_EDES_ortho/branch_pt_<phase>_scores.csv")
    ap.add_argument("--out_json", default=None,
                    help="knot bookkeeping for the viewer build; defaults next to --out_csv")
    args = ap.parse_args(argv)

    pca_csv = args.pca_csv or f"{_BASE}/PCA_{args.phase}/PCA.csv"
    out_csv = args.out_csv or f"{_BASE}/DDRTree_EDES_ortho/branch_pt_{args.phase}_scores.csv"
    out_json = args.out_json or out_csv.replace(".csv", "_knots.json")
    span = [float(x) for x in args.span.split(",")]

    print(f"[{args.phase}] {args.n_knots} knots per branch, spanning percentiles {span}")
    pc_cols, per_branch, cohort, n_obs = branch_knot_scores(args.tree_dir, pca_csv,
                                                            args.n_knots, span)

    ids, rows, meta = ["template"], [np.zeros(len(pc_cols))], {}
    for b in sorted(per_branch):
        knots, fitted = per_branch[b]
        meta[f"Branch_{b}"] = {"pt": [round(float(k), 6) for k in knots],
                               "index": [len(ids) + j for j in range(len(knots))]}
        for j, (k, row) in enumerate(zip(knots, fitted)):
            ids.append(f"Branch_{b}__k{j}")
            rows.append(row)
    # The label carries the observation count, so a JSON built against one tree cannot
    # be mistaken for another: 233 was the pre-phantom-removal cohort, 193 is the rebuilt.
    cohort_label = f"cohort_mean_{n_obs}"
    meta[cohort_label] = {"pt": None, "index": [len(ids)]}
    ids.append(cohort_label)
    rows.append(cohort)

    out = pd.DataFrame(rows, columns=pc_cols)
    out.insert(0, "ID", ids)
    out.to_csv(out_csv, index=False)
    with open(out_json, "w") as fh:
        json.dump({"phase": args.phase, "n_knots": args.n_knots, "span_pcts": span,
                   "n_pc": len(pc_cols), "ids": ids, "branches": meta}, fh, indent=2)
    print(f"\nWrote {out_csv}  ({out.shape[0]} rows x {len(pc_cols)} PCs)")
    print(f"Wrote {out_json}")
    print("Shooting index -> item: " + ", ".join(f"{i}={n}" for i, n in enumerate(ids)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
