#!/usr/bin/env python3
"""
Build data/tree.json: the DDRTree skeleton the viewer draws as a minimap.

The combined ortho tree (feature matrix [PC_ED | ES-perp]) is a graph of
principal-curve nodes. This script reads the tree as the DDRTree run left it and packs the
parts the viewer needs: node coordinates, edges, per-node pseudotime and branch id, the
ordered proximal -> distal node path of each branch, and the sample scatter.

Two facts about the tree are exploited (both verified on the current run):
  - pseudotime is a NODE property (every sample at a node shares it) and equals the 2D
    geodesic distance from the root, so the ~40 nodes that carry no sample still get an
    exact pseudotime rather than an interpolated guess;
  - no node mixes branches, so a majority vote per node is in fact unanimous. Sample-free
    nodes inherit the branch of their nearest assigned neighbour along the graph, and are
    left unassigned (-1, drawn grey) when two branches are equidistant, which is what the
    junctions are.

Run (project venv):
  venv_TRED_REMIT_analysis/bin/python3 tools/build_tree_map.py
"""
from __future__ import annotations

import argparse
import json
import os
from collections import deque

import numpy as np
import pandas as pd

_BASE = "/media/croderog/Bob/shape_analysis/TRED_REMIT"
# DDRTree/six_panel_figure.py:_BRANCH_PALETTE — keep the viewer and the paper figures
# showing each branch in the same colour.
_PALETTE = ["#3A7B8E", "#5A8A5A", "#7A5E8A", "#C08030", "#A8455C", "#3A4E8A"]
# A correct root reproduces every sampled node's pseudotime to machine precision, so this
# tolerance only has to sit clear of floating-point noise.
_ROOT_TOL = 1e-9


def _neighbours(edges, n_nodes):
    adj = [[] for _ in range(n_nodes)]
    for u, v in edges:
        adj[u].append(v)
        adj[v].append(u)
    return adj


def _geodesic(root, adj, xy):
    """2D geodesic distance from `root` to every node; the graph is a tree, so one pass."""
    dist = np.full(len(adj), np.inf)
    dist[root] = 0.0
    q = deque([root])
    while q:
        n = q.popleft()
        for m in adj[n]:
            if np.isinf(dist[m]):
                dist[m] = dist[n] + float(np.linalg.norm(xy[m] - xy[n]))
                q.append(m)
    return dist


def _find_root(node_pt, adj, xy):
    """-> (root, residual). The root is the node whose geodesic distances reproduce the
    sampled nodes' pseudotime, which is NOT always a node that carries a sample: on the
    rebuilt tree it is node 34, and taking the sampled node of least pseudotime instead
    put every sample-free node out by exactly the 0.0595 that separates the two."""
    sampled = np.where(~np.isnan(node_pt))[0]
    resid = np.array([np.abs(node_pt[sampled] - _geodesic(r, adj, xy)[sampled]).max()
                      for r in range(len(adj))])
    root = int(np.argmin(resid))
    return root, float(resid[root])


def _fill_branches(branch, adj):
    """Give every sample-free node the branch of its nearest assigned node; -1 on a tie."""
    out = list(branch)
    frontier = deque((n, branch[n]) for n in range(len(branch)) if branch[n] >= 0)
    seen = {n: branch[n] for n in range(len(branch)) if branch[n] >= 0}
    while frontier:
        n, b = frontier.popleft()
        for m in adj[n]:
            if m in seen:
                if seen[m] != b:
                    out[m] = -1          # reachable from two branches at equal cost
                continue
            seen[m] = b
            out[m] = b
            frontier.append((m, b))
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tree_dir", default=f"{_BASE}/DDRTree_EDES_ortho_rebuilt/All_Visits")
    ap.add_argument("--out", default="data/tree.json")
    args = ap.parse_args(argv)

    t = args.tree_dir
    pts = pd.read_csv(f"{t}/tree_points.csv", index_col="node_id").sort_index()
    edges = pd.read_csv(f"{t}/tree_edges.csv")[["u", "v"]].values.astype(int)
    s2n = pd.read_csv(f"{t}/sample_to_node.csv")
    assign = pd.read_csv(f"{t}/sample_branch_assignments.csv")
    ptime = pd.read_csv(f"{t}/pseudotime.csv")
    emb = pd.read_csv(f"{t}/embedding_2d.csv")
    stats = pd.read_csv(f"{t}/branch_statistics.csv")

    n_nodes = len(pts)
    xy = pts[["x", "y"]].values
    smp = s2n.merge(assign, on="sample_id").merge(ptime, on="sample_id")
    smp["branch_id"] = smp["branch_id"].astype(int)

    # Node pseudotime: from the samples where we have them, then by 2D geodesic from the
    # root for the rest (the two agree exactly on the nodes that carry samples).
    adj = _neighbours(edges, n_nodes)
    node_pt = np.full(n_nodes, np.nan)
    for node, sub in smp.groupby("node_id"):
        node_pt[int(node)] = sub["pseudotime"].iloc[0]
    root, resid = _find_root(node_pt, adj, xy)
    if resid > _ROOT_TOL:
        raise SystemExit(
            f"no node reproduces the sampled pseudotime as a geodesic distance (best is "
            f"node {root} at {resid:.3e} > {_ROOT_TOL:g}). Pseudotime is not the 2D "
            f"geodesic from a root on this tree, so the sample-free nodes cannot be "
            f"filled in and the minimap would be wrong.")
    dist = _geodesic(root, adj, xy)
    fixed = ~np.isnan(node_pt)
    node_pt = np.where(fixed, node_pt, dist)
    print(f"{n_nodes} nodes, {len(edges)} edges, root={root} "
          f"({'carries' if fixed[root] else 'carries no'} sample); "
          f"pseudotime vs 2D geodesic max |diff| on sampled nodes = {resid:.2e}")

    node_branch = np.full(n_nodes, -1, dtype=int)
    for node, sub in smp.groupby("node_id"):
        node_branch[int(node)] = int(sub["branch_id"].mode().iloc[0])
    n_seeded = int((node_branch >= 0).sum())
    node_branch = np.array(_fill_branches(node_branch.tolist(), adj))
    print(f"branch ids: {n_seeded} nodes from samples -> "
          f"{int((node_branch >= 0).sum())} after fill, "
          f"{int((node_branch < 0).sum())} left as junctions")

    branch_ids = sorted(smp["branch_id"].unique())
    st = stats.set_index("branch_id")
    # Sample counts come from the assignments. branch_statistics.csv counts a sample sitting
    # at a branch junction once in each branch, which overstates two branches and makes the
    # counts sum past the number of samples.
    n_in = smp["branch_id"].value_counts()
    branches = {}
    for b in branch_ids:
        members = np.where(node_branch == b)[0]
        path = members[np.argsort(node_pt[members])].tolist()   # proximal -> distal
        r = st.loc[b]
        branches[f"Branch_{b}"] = {
            "id": int(b),
            "path": path,
            "n_samples": int(n_in[b]),
            "n_nodes": int(r["n_nodes"]),
            "length": round(float(r["branch_length"]), 4),
            "pt_min": round(float(node_pt[path].min()), 6),
            "pt_max": round(float(node_pt[path].max()), 6),
            "color": _PALETTE[int(b) % len(_PALETTE)],
        }
        print(f"  Branch_{b}: {len(path)} nodes, {int(n_in[b])} samples, "
              f"pt [{branches[f'Branch_{b}']['pt_min']:.3f}, "
              f"{branches[f'Branch_{b}']['pt_max']:.3f}]")

    emb_by_id = emb.set_index("sample_id")
    smp_i = smp.set_index("sample_id")
    common = [s for s in emb_by_id.index if s in smp_i.index]
    samples = [[round(float(emb_by_id.loc[s, "Embedded_1"]), 4),
                round(float(emb_by_id.loc[s, "Embedded_2"]), 4),
                int(smp_i.loc[s, "branch_id"])] for s in common]

    out = {
        "n_samples": int(len(smp)),
        "root": root,
        "pt_min": round(float(node_pt.min()), 6),
        "pt_max": round(float(node_pt.max()), 6),
        "nodes": [[round(float(x), 5), round(float(y), 5), round(float(p), 6), int(b)]
                  for (x, y), p, b in zip(xy, node_pt, node_branch)],
        "edges": edges.tolist(),
        "branches": branches,
        "samples": samples,
    }
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w") as fh:
        json.dump(out, fh)
    print(f"wrote {args.out} ({os.path.getsize(args.out) / 1e3:.0f} kB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
