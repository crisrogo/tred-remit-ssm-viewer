#!/usr/bin/env python3
"""
Emit the displacement colourmap the viewer uses, and check that it is perceptually uniform.

The viewer colours every vertex by how far it moves, so the colour bar has to be read
quantitatively: equal steps in displacement must look like equal steps in colour, and the
two ends must be far apart enough to tell "barely moves" from "moves most" at a glance.
A two-colour ramp interpolated in sRGB does neither, so the viewer stores a list of hex
stops sampled from viridis (purple -> blue -> green -> yellow), which is uniform by
construction in CAM02-UCS.

The stop count is a compromise: enough stops that piecewise-linear sRGB interpolation
between them is indistinguishable from true viridis, few enough that the list stays
readable in data/manifest.json. This script reports the error so the choice is checkable.

Perceptual differences here are CIEDE2000 (skimage), used as a proxy for the CAM02-UCS
metric viridis was actually designed in. Around 1.0 is the just-noticeable difference.

Run (any environment with matplotlib + scikit-image):
  python3 tools/make_colourmap.py                 # report + the 13 stops the viewer uses
  python3 tools/make_colourmap.py --n_stops 21    # try a different stop count
  python3 tools/make_colourmap.py --write data/manifest.json   # update the manifest in place
"""
from __future__ import annotations

import argparse
import json

import matplotlib
import numpy as np
from skimage.color import deltaE_ciede2000, rgb2lab

# The ramp the viewer replaced, kept so the report says what was gained.
_OLD = ["#7A5E8A", "#F5E740"]


def sample_stops(name, n_stops):
    """n_stops evenly spaced colours from a matplotlib colourmap, rounded to 8-bit hex."""
    cmap = matplotlib.colormaps[name]
    rgb = np.array([cmap(x)[:3] for x in np.linspace(0, 1, n_stops)])
    return ["#%02X%02X%02X" % tuple(np.round(c * 255).astype(int)) for c in rgb]


def to_rgb(hex_stops):
    return np.array([[int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)] for h in hex_stops])


def piecewise(stops_rgb, g):
    """Interpolate the stop list linearly in sRGB, exactly as the viewer's LUT does."""
    n = len(stops_rgb) - 1
    pos = np.clip(g * n, 0, n)
    i = np.clip(np.floor(pos).astype(int), 0, n - 1)
    w = (pos - i)[:, None]
    return stops_rgb[i] * (1 - w) + stops_rgb[i + 1] * w


def step_deltas(rgb):
    """CIEDE2000 between neighbouring samples: how big each equal slider step looks."""
    lab = rgb2lab(rgb[None, :, :])
    return deltaE_ciede2000(lab[:, :-1], lab[:, 1:])[0]


def report(label, hex_stops, n_steps):
    """Print the numbers that decide whether a ramp is readable as a scale."""
    g = np.linspace(0, 1, n_steps + 1)
    rgb = piecewise(to_rgb(hex_stops), g)
    lab = rgb2lab(rgb[None, :, :])[0]
    d = step_deltas(rgb)
    ends = deltaE_ciede2000(lab[None, 0:1], lab[None, -1:])[0][0]
    print(f"\n{label}  ({len(hex_stops)} stops)")
    print(f"  step dE00 over {n_steps} equal steps : "
          f"min {d.min():.3f}  mean {d.mean():.3f}  max {d.max():.3f}  "
          f"max/min {d.max() / d.min():.2f}   (1.00 = perfectly uniform)")
    print(f"  lightness L*                       : "
          f"{lab[0, 0]:.1f} -> {lab[-1, 0]:.1f}  (range {lab[:, 0].max() - lab[:, 0].min():.1f})")
    print(f"  end-to-end dE00 (0 vs max displ.)   : {ends:.1f}")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cmap", default="viridis", help="matplotlib colourmap to sample")
    ap.add_argument("--n_stops", type=int, default=13,
                    help="number of hex stops to store in the manifest (default 13)")
    ap.add_argument("--n_steps", type=int, default=64,
                    help="slider steps used for the uniformity report (default 64)")
    ap.add_argument("--write", default=None,
                    help="path to a manifest.json whose 'colormap' key to overwrite")
    args = ap.parse_args(argv)

    print("=" * 74)
    print(f"Displacement colourmap: {args.cmap}, {args.n_stops} stops")
    print("=" * 74)

    # How many stops are enough? Compare the piecewise-linear ramp against the true
    # colourmap at 256 samples. The floor is 8-bit hex quantisation, about 0.6 dE00.
    truth = np.array([matplotlib.colormaps[args.cmap](x)[:3] for x in np.linspace(0, 1, 256)])
    g = np.linspace(0, 1, 256)
    print("\nApproximation error of the stored stop list vs the true colourmap:")
    print("  stops   max dE00   mean dE00")
    for n in sorted({5, 7, 9, 11, 13, 17, 21, 33, args.n_stops}):
        approx = piecewise(to_rgb(sample_stops(args.cmap, n)), g)
        d = deltaE_ciede2000(rgb2lab(approx[None, :, :]), rgb2lab(truth[None, :, :]))[0]
        mark = "  <- chosen" if n == args.n_stops else ""
        print(f"  {n:5d}   {d.max():8.3f}   {d.mean():9.3f}{mark}")

    stops = sample_stops(args.cmap, args.n_stops)
    report("Previous ramp (2-colour sRGB interpolation)", _OLD, args.n_steps)
    report(f"New ramp ({args.cmap})", stops, args.n_steps)

    print("\nStops for data/manifest.json \"colormap\" and tools/build_web_meshes.py _CMAP:")
    print("  " + ", ".join(f'"{h}"' for h in stops))

    if args.write:
        with open(args.write) as fh:
            manifest = json.load(fh)
        manifest["colormap"] = stops
        with open(args.write, "w") as fh:
            json.dump(manifest, fh, indent=2)
        print(f"\n  wrote colormap ({len(stops)} stops) to {args.write}")


if __name__ == "__main__":
    main()
