import sys
import argparse
import numpy as np
import networkx as nx
import logging
import xml.etree.ElementTree as ET
import io
from shapely.geometry import MultiLineString, LineString, Point
from shapely.ops import unary_union
from shapely.strtree import STRtree
from svgpathtools import svg2paths, Path, Line, Arc, wsvg
from scipy.spatial import KDTree

# Set up logging
logger = logging.getLogger(__name__)

# Monkeypatch Path.d to resolve a svgpathtools truncation bug.
# When use_closed_attrib=True, Path.d() aggressively replaces the last segment with 'Z'.
# If the last segment is an Arc/Bezier, it is incorrectly discarded and replaced by a straight Line.
# Workaround: temporarily append a zero-length Line so THAT is replaced by 'Z', preserving the curve.
original_d = Path.d


def new_d(self, *args, **kwargs):
    if self.isclosed():
        kwargs["use_closed_attrib"] = True
        if len(self) > 0 and not isinstance(self[-1], Line):
            # Temporarily append a zero-length line so svgpathtools replaces THAT with Z,
            # preserving the actual final curved segment.
            self.append(Line(self[-1].end, self[-1].end))
            res = original_d(self, *args, **kwargs)
            self.pop()
            return res
    return original_d(self, *args, **kwargs)


Path.d = new_d




def build_graph(segments, epsilon=0.01):
    raw_points = []
    for seg in segments:
        if isinstance(seg, LineString):
            coords = list(seg.coords)
            raw_points.append(tuple(coords[0]))
            raw_points.append(tuple(coords[-1]))
        else:
            raw_points.append((seg.start.real, seg.start.imag))
            raw_points.append((seg.end.real, seg.end.imag))

    unique_points = list(set(raw_points))
    pts_arr = np.array(unique_points)

    if len(pts_arr) > 0:
        tree = KDTree(pts_arr)
        pairs = tree.query_pairs(epsilon)

        P_graph = nx.Graph()
        P_graph.add_nodes_from(range(len(pts_arr)))
        P_graph.add_edges_from(pairs)

        snap_map = {}
        for comp in nx.connected_components(P_graph):
            comp_indices = list(comp)
            representative = tuple(np.mean(pts_arr[comp_indices], axis=0))
            for idx in comp_indices:
                snap_map[unique_points[idx]] = representative
    else:
        snap_map = {}

    G = nx.MultiGraph()
    for seg in segments:
        if isinstance(seg, LineString):
            coords = list(seg.coords)
            p0 = snap_map[tuple(coords[0])]
            p1 = snap_map[tuple(coords[-1])]
        else:
            p0 = snap_map[(seg.start.real, seg.start.imag)]
            p1 = snap_map[(seg.end.real, seg.end.imag)]
        G.add_edge(p0, p1, geom=seg)
    return G, snap_map


def chain_paths(G, snap_map):
    paths = []
    H = G.copy()

    while H.number_of_edges() > 0:
        odd_nodes = [n for n, d in H.degree() if d % 2 == 1]
        start = odd_nodes[0] if odd_nodes else next(iter(H.nodes))

        path_geoms = []
        current = start

        while True:
            edges = list(H.edges(current, keys=True, data=True))
            if not edges:
                break

            best_edge = edges[0]
            if len(edges) > 1:
                for e in edges:
                    u, v, k, d = e
                    H.remove_edge(u, v, key=k)
                    is_bridge = not nx.has_path(H, u, v) if u != v else False
                    H.add_edge(u, v, key=k, **d)
                    if not is_bridge:
                        best_edge = e
                        break

            u, v, k, d = best_edge
            geom = d["geom"]

            if isinstance(geom, LineString):
                coords = list(geom.coords)
                geom_p0 = snap_map[tuple(coords[0])]
            else:
                geom_p0 = snap_map[(geom.start.real, geom.start.imag)]

            if geom_p0 != current:
                if isinstance(geom, LineString):
                    geom = LineString(list(geom.coords)[::-1])
                else:
                    geom = geom.reversed()

            path_geoms.append(geom)
            H.remove_edge(u, v, key=k)
            current = u if current == v else v

        paths.append(path_geoms)
        H.remove_nodes_from(list(nx.isolates(H)))
    return paths


def filter_redundant_segments(segments, epsilon=0.1):
    if not segments:
        return []

    logger.debug(f"Deduplicating {len(segments)} segments")

    # Create discretized shapely geoms for the spatial index
    shapely_geoms = []
    for seg in segments:
        if isinstance(seg, Line):
            shapely_geoms.append(
                LineString(
                    [(seg.start.real, seg.start.imag), (seg.end.real, seg.end.imag)]
                )
            )
        else:
            length = seg.length()
            # Use enough samples to represent the shape for distance checks
            num_samples = max(10, int(np.ceil(length / 2.0)))
            pts = [
                (seg.point(t / num_samples).real, seg.point(t / num_samples).imag)
                for t in range(num_samples + 1)
            ]
            shapely_geoms.append(LineString(pts))

    tree = STRtree(shapely_geoms)
    to_remove = set()

    # Pre-calculate lengths to speed up comparisons
    lengths = [seg.length() for seg in segments]

    for i, seg_i in enumerate(segments):
        if i in to_remove:
            continue

        geom_i = shapely_geoms[i]
        # Query for neighbors that intersect the bounding box of seg_i
        candidates = tree.query(geom_i, predicate="intersects")

        for j in candidates:
            if i == j or j in to_remove:
                continue

            l_i = lengths[i]
            l_j = lengths[j]

            # seg_i can only be contained in seg_j if it's not significantly longer
            if l_i > l_j + epsilon:
                continue

            geom_j = shapely_geoms[j]

            # Sampling check: is all of seg_i on seg_j?
            is_contained = True
            # Sample 5 points (start, 25%, mid, 75%, end)
            for t in [0, 0.25, 0.5, 0.75, 1.0]:
                p = seg_i.point(t)
                if geom_j.distance(Point(p.real, p.imag)) > epsilon:
                    is_contained = False
                    break

            if is_contained:
                # If lengths are nearly identical, keep the one with the smaller index
                if abs(l_i - l_j) < epsilon:
                    if i > j:
                        to_remove.add(i)
                        break
                else:
                    # seg_i is strictly a sub-segment
                    to_remove.add(i)
                    break

    filtered = [segments[i] for i in range(len(segments)) if i not in to_remove]
    logger.debug(f"Removed {len(to_remove)} redundant segments")
    return filtered


def load_svg_cleaned(input_svg):
    """Loads SVG paths while removing <defs> sections to avoid spurious paths."""
    tree = ET.parse(input_svg)
    root = tree.getroot()

    # Remove all <defs> elements
    ns = {"svg": "http://www.w3.org/2000/svg"}
    ET.register_namespace("", ns["svg"])

    # Find and remove defs
    for defs in root.findall(".//{http://www.w3.org/2000/svg}defs") + root.findall(
        ".//defs"
    ):
        for parent in root.findall(".//*"):
            if defs in parent:
                parent.remove(defs)
        if defs in root:
            root.remove(defs)

    bio = io.BytesIO()
    tree.write(bio)
    bio.seek(0)

    paths, attributes = svg2paths(bio)
    return paths, attributes


def process_svg(paths, args):
    # Flatten all segments
    all_segments = []
    for path in paths:
        for seg in path:
            all_segments.append(seg)

    # Always filter redundancies first to handle duplicates and contained paths
    segments = filter_redundant_segments(all_segments, epsilon=args.snap_tolerance)

    logger.debug(f"Preserved {len(segments)} original segments")

    logger.info("Building graph and chaining paths")
    G, snap_map = build_graph(segments, epsilon=args.snap_tolerance)
    logger.debug(
        f"Graph has {G.number_of_nodes()} nodes and {G.number_of_edges()} edges"
    )

    chained_node_paths = chain_paths(G, snap_map)
    logger.info(f"Chained into {len(chained_node_paths)} continuous paths")

    out_paths = []
    for path_geoms in chained_node_paths:
        svg_path = Path()
        for i, geom in enumerate(path_geoms):
            start_tuple = (geom.start.real, geom.start.imag)
            end_tuple = (geom.end.real, geom.end.imag)
            new_start = complex(*snap_map.get(start_tuple, start_tuple))
            new_end = complex(*snap_map.get(end_tuple, end_tuple))

            if len(svg_path) > 0:
                new_start = svg_path[-1].end
            if i == len(path_geoms) - 1:
                first_start = svg_path[0].start if len(svg_path) > 0 else new_start
                if abs(new_end - first_start) <= args.snap_tolerance:
                    new_end = first_start
            if new_start == new_end:
                continue

            if isinstance(geom, Line):
                geom = Line(new_start, new_end)
            elif isinstance(geom, Arc):
                geom = Arc(
                    new_start,
                    geom.radius,
                    geom.rotation,
                    geom.large_arc,
                    geom.sweep,
                    new_end,
                )
            elif hasattr(geom, "control1") and hasattr(
                geom, "control2"
            ):  # CubicBezier
                from svgpathtools import CubicBezier

                geom = CubicBezier(new_start, geom.control1, geom.control2, new_end)
            elif hasattr(geom, "control"):  # QuadraticBezier
                from svgpathtools import QuadraticBezier

                geom = QuadraticBezier(new_start, geom.control, new_end)
            svg_path.append(geom)
        if len(svg_path) > 0:
            out_paths.append(svg_path)
    return out_paths


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input_svg")
    parser.add_argument("output_svg")
    parser.add_argument(
        "--snap-tolerance",
        type=float,
        default=0.1,
        help="Epsilon distance for node snapping",
    )
    parser.add_argument(
        "-v",
        "--verbose",
        action="count",
        default=0,
        help="Verbosity level (-v for INFO, -vv for DEBUG)",
    )
    args = parser.parse_args()

    if args.verbose == 0:
        log_level = logging.WARNING
    elif args.verbose == 1:
        log_level = logging.INFO
    else:
        log_level = logging.DEBUG

    logging.basicConfig(level=log_level, format="%(levelname)s: %(message)s")

    logger.info(f"Reading {args.input_svg}")
    try:
        paths, attributes = load_svg_cleaned(args.input_svg)
    except Exception as e:
        logger.error(f"Error parsing SVG: {e}")
        sys.exit(1)

    logger.info("Extracting segments")
    out_paths = process_svg(paths, args)
    logger.info(f"Writing output SVG to {args.output_svg}")
    wsvg(out_paths, filename=args.output_svg)


if __name__ == "__main__":
    main()
