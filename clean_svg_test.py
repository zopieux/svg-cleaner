import os
import pytest
from svgpathtools import Path, Line, Arc, wsvg
from clean_svg import process_svg, load_svg_cleaned

# Setup test directory
TEST_DIR = "/tmp/cad-svg-tests"
os.makedirs(TEST_DIR, exist_ok=True)


class Args:
    def __init__(self, snap_tolerance=0.1):
        self.snap_tolerance = snap_tolerance


def save_and_process(name, paths, snap_tolerance=0.1):
    before_path = os.path.join(TEST_DIR, f"{name}_before.svg")
    after_path = os.path.join(TEST_DIR, f"{name}_after.svg")

    # Save "before"
    wsvg(paths, filename=before_path)

    # Process
    args = Args(snap_tolerance=snap_tolerance)
    out_paths = process_svg(paths, args)

    # Save "after"
    wsvg(out_paths, filename=after_path)
    return out_paths


def test_arc_redundancy():
    # Nearly full circle, gap of 0.2
    a_full = Arc(10 + 0j, 10 + 10j, 0, 1, 1, 10.2 + 0j)
    # A sub-segment of that same arc
    a_sub = a_full.cropped(0.2, 0.5)
    paths = [Path(a_full), Path(a_sub)]

    # a_sub is contained in a_full
    out_paths = save_and_process("arc_redundant", paths, snap_tolerance=0.1)

    assert len(out_paths) == 1
    assert len(out_paths[0]) == 1
    # The sub-segment should be removed, leaving the larger arc
    assert out_paths[0][0].length() > 20


def test_minor_drift_chaining():
    # Two lines that should connect but have minor drift
    l1 = Line(0j, 10 + 10j)
    l2 = Line(10.05 + 10.05j, 20 + 20j)
    paths = [Path(l1), Path(l2)]

    out_paths = save_and_process("drift_chain", paths, snap_tolerance=0.1)

    assert len(out_paths) == 1
    assert len(out_paths[0]) == 2
    # Check if they are connected
    assert out_paths[0][0].end == out_paths[0][1].start


def test_closed_loop_with_drift():
    # Triangle that doesn't quite meet back at the start
    l1 = Line(0j, 10 + 0j)
    l2 = Line(10 + 0j, 5 + 10j)
    l3 = Line(5 + 10j, 0.05 + 0.05j)
    paths = [Path(l1), Path(l2), Path(l3)]

    out_paths = save_and_process("closed_drift", paths, snap_tolerance=0.1)

    assert len(out_paths) == 1
    assert out_paths[0].isclosed()
    assert "Z" in out_paths[0].d()


def test_arc_preservation_in_closed_loop():
    # A path ending with an arc back to start
    l1 = Line(0j, 10 + 0j)
    a1 = Arc(10 + 0j, 10 + 10j, 0, 0, 0, 0j)
    paths = [Path(l1), Path(a1)]

    out_paths = save_and_process("arc_closed", paths, snap_tolerance=0.1)

    assert len(out_paths) == 1
    assert isinstance(out_paths[0][-1], Arc)
    assert out_paths[0].isclosed()
    d_string = out_paths[0].d()
    assert "A" in d_string
    assert "Z" in d_string


def test_multigraph_parallel_edges():
    # Two distinct paths between same points (one straight, one curved)
    l1 = Line(0j, 10 + 0j)
    a1 = Arc(0j, 5 + 5j, 0, 0, 0, 10 + 0j)
    paths = [Path(l1), Path(a1)]

    out_paths = save_and_process("parallel_edges", paths, snap_tolerance=0.1)

    assert len(out_paths) == 1
    assert out_paths[0].isclosed()


def test_redundant_path_removal():
    # A-C and B-C (B-C is contained in A-C)
    l1 = Line(0j, 10 + 0j)  # A-C
    l2 = Line(5 + 0j, 10 + 0j)  # B-C
    paths = [Path(l1), Path(l2)]

    out_paths = save_and_process("redundant_removal", paths, snap_tolerance=0.1)

    # B-C should be removed, leaving only A-C
    assert len(out_paths) == 1
    assert len(out_paths[0]) == 1
    assert out_paths[0][0].length() == 10


def test_exact_duplicate_removal():
    l1 = Line(0j, 10 + 0j)
    l2 = Line(0j, 10 + 0j)
    paths = [Path(l1), Path(l2)]

    out_paths = save_and_process("exact_duplicate", paths, snap_tolerance=0.1)

    assert len(out_paths) == 1
    assert len(out_paths[0]) == 1


def test_zero_length_discard():
    # A tiny line that should be discarded
    l1 = Line(0j, 10 + 0j)
    l2 = Line(10 + 0j, 10.001 + 0.001j)  # extremely small
    l3 = Line(10.001 + 0.001j, 20 + 0j)
    paths = [Path(l1), Path(l2), Path(l3)]

    out_paths = save_and_process("zero_length", paths, snap_tolerance=0.1)

    assert len(out_paths) == 1
    assert len(out_paths[0]) == 2


def test_defs_removal():
    # SVG with a <defs> section containing a "spurious" path
    svg_content = """<svg xmlns="http://www.w3.org/2000/svg">
      <defs>
        <marker id="DistanceX">
          <path d="M 3,-3 L -3,3 M 0,-5 L 0,5" id="spurious" />
        </marker>
      </defs>
      <path d="M 0,0 L 10,10" id="legit" />
    </svg>"""

    input_path = os.path.join(TEST_DIR, "defs_test_before.svg")
    with open(input_path, "w") as f:
        f.write(svg_content)

    # Call load_svg_cleaned directly
    paths, _ = load_svg_cleaned(input_path)

    # Should only have 1 path (the legit one)
    assert len(paths) == 1
    assert len(paths[0]) == 1
    assert paths[0][0].start == 0j
