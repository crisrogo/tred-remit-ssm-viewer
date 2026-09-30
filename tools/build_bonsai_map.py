#!/usr/bin/env python3
"""
Build data/bonsai.json: the Bonsai tree of the 232 development scans, laid out for the viewer's
Bonsai map.

The tree comes from TRED_REMIT_analysis/bonsai (run `default`, parsed into tree_edges.csv and
tree_vertices.csv). It is drawn with the same equal-angle layout as the paper figure
(bonsai/7_figures.py): each subtree gets an angular wedge in proportion to its number of leaves,
and each vertex sits at its parent plus the branch length along the middle of its wedge. Branch
lengths are to scale; the angles carry no information.

Each leaf carries its clade (C1..C7, named by size in Bonsai_EDES_ortho/figures/clade_names.csv),
cohort, outcome subgroup and visit, so the map can be coloured by any of them. Colours are the
project palette (TRED_REMIT_analysis CLAUDE.md): clades use the DDRTree branch set plus olive.

Output:
  {"nodes": [[x, y], ...], "edges": [[u, v], ...],
   "leaves": [[x, y, clade, cohort, subgroup, visit, id], ...],
   "legend": {"clade": {...}, "cohort": {...}, "outcome": {...}, "visit": {...}},
   "clades": {"C1": {"n": 56, "TRED-HF": 40, "REMIT-DCM": 16}, ...}}

Run (project venv of TRED_REMIT_analysis):
  venv_TRED_REMIT_analysis/bin/python3 tools/build_bonsai_map.py
"""
from __future__ import annotations

import argparse
import json
import os

import numpy as np
import pandas as pd

_BONSAI = "/media/croderog/Bob/shape_analysis/TRED_REMIT/Bonsai_EDES_ortho"

# Palette: TRED_REMIT_analysis CLAUDE.md. No new hex.
_CLADE_PALETTE = ["#3A7B8E", "#5A8A5A", "#7A5E8A", "#C08030", "#A8455C", "#3A4E8A", "#6E7B2E"]
_COHORT = {"TRED": ("TRED-HF", "#BF7055"), "REMIT": ("REMIT-DCM", "#5489A8")}
_SUBGROUP = {"TRED-HF relapsers": "#BF7055", "TRED-HF non-relapsers": "#DBA88E",
             "REMIT-DCM remitters": "#5489A8", "REMIT-DCM non-remitters": "#9BBDD4",
             "TRED-HF, withdrew": "#7F8797"}
_VISIT = {1: "#3A7B8E", 2: "#BF7055", 3: "#5A8A5A", 4: "#7A5E8A"}


def equal_angle_layout(edges, verts):
    """Equal-angle layout from vertex 0 -> {vertInd: (x, y)} (as bonsai/7_figures.py)."""
    adj = {}
    for u, v, w in edges[["u", "v", "length"]].itertuples(index=False):
        adj.setdefault(u, []).append((v, w))
        adj.setdefault(v, []).append((u, w))
    leaf = dict(zip(verts["vertInd"], verts["is_leaf"]))
    root = 0
    parent, order, stack = {root: None}, [], [root]
    while stack:
        x = stack.pop()
        order.append(x)
        for y, _ in adj[x]:
            if y not in parent:
                parent[y] = x
                stack.append(y)
    n_leaves = {}
    for x in reversed(order):
        n_leaves[x] = int(leaf[x]) + sum(n_leaves[y] for y, _ in adj[x] if parent.get(y) == x)
    pos = {root: np.zeros(2)}
    wedge = {root: (0.0, 2 * np.pi)}
    for x in order:
        a0, a1 = wedge[x]
        start = a0
        for y, w in adj[x]:
            if parent.get(y) != x:
                continue
            span = (a1 - a0) * n_leaves[y] / max(1, n_leaves[x] - int(leaf[x]))
            wedge[y] = (start, start + span)
            theta = start + span / 2
            pos[y] = pos[x] + w * np.array([np.cos(theta), np.sin(theta)])
            start += span
    return pos


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bonsai_dir", default=_BONSAI)
    ap.add_argument("--out", default="data/bonsai.json")
    args = ap.parse_args(argv)

    parsed = os.path.join(args.bonsai_dir, "runs", "default", "parsed")
    edges = pd.read_csv(os.path.join(parsed, "tree_edges.csv"))
    verts = pd.read_csv(os.path.join(parsed, "tree_vertices.csv"))
    clades = pd.read_csv(os.path.join(args.bonsai_dir, "results", "structure",
                                      "carried_forward_clades.csv"), index_col="ID")["k7"]
    names = pd.read_csv(os.path.join(args.bonsai_dir, "figures", "clade_names.csv")).set_index(
        "bonsai_label")["name"]
    info = pd.read_csv(os.path.join(args.bonsai_dir, "results", "template_movement",
                                    "per_scan.csv"), index_col="ID").loc[clades.index]
    info["clade"] = clades.map(names)
    info["subgroup"] = info["subgroup"].fillna("TRED-HF, withdrew")

    pos = equal_angle_layout(edges, verts)
    # Renumber vertices 0..n-1 in vertInd order, rounded to keep the file small
    order = sorted(pos)
    index = {v: i for i, v in enumerate(order)}
    nodes = [[round(float(pos[v][0]), 4), round(float(pos[v][1]), 4)] for v in order]
    edge_list = [[index[u], index[v]] for u, v in edges[["u", "v"]].itertuples(index=False)]

    clade_order = [f"C{i + 1}" for i in range(len(names))]
    sub_order = list(_SUBGROUP)
    leaf_v = verts[verts["is_leaf"]].set_index("vertName")["vertInd"]
    leaves = []
    for sid, r in info.iterrows():
        x, y = nodes[index[leaf_v[sid]]]
        leaves.append([x, y, clade_order.index(r["clade"]), 0 if r["cohort"] == "TRED" else 1,
                       sub_order.index(r["subgroup"]), int(r["visit"]), sid])

    legend = {
        "clade": [[c, _CLADE_PALETTE[i]] for i, c in enumerate(clade_order)],
        "cohort": [[_COHORT[c][0], _COHORT[c][1]] for c in ("TRED", "REMIT")],
        "outcome": [[s, _SUBGROUP[s]] for s in sub_order],
        "visit": [[f"Visit {v}", _VISIT[v]] for v in sorted(info["visit"].unique().astype(int))],
    }
    clade_info = {}
    for c in clade_order:
        g = info[info["clade"] == c]
        clade_info[c] = {"n": int(len(g)), "TRED-HF": int((g["cohort"] == "TRED").sum()),
                         "REMIT-DCM": int((g["cohort"] == "REMIT").sum())}
    out = {"nodes": nodes, "edges": edge_list, "leaves": leaves, "legend": legend,
           "clades": clade_info, "n_scans": int(len(info)),
           "n_patients": int(info["pid"].nunique())}
    with open(args.out, "w") as fh:
        json.dump(out, fh, separators=(",", ":"))
    print(f"wrote {args.out}: {len(nodes)} vertices, {len(edge_list)} edges, {len(leaves)} leaves "
          f"({os.path.getsize(args.out) / 1e3:.0f} kB)")
    for c, d in clade_info.items():
        print(f"  {c}: {d}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
