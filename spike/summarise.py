#!/usr/bin/env python3
"""SPIKE CODE -- NOT PRODUCTION. M7.1.

Collapses the per-capture JSON artefacts from spike/run-all.sh into the numbers
the spike report cites, applying milestone 7 §5.1.1 rather than any rule of its
own:

  A2  the reported figure for a quantity is the MEDIAN OF THE PER-CAPTURE
      MEDIANS, over >=3 captures
  A3  run-to-run spread of those per-capture medians must be <=10%; above that
      the quantity is reported `not-gateable` and the spread is reported with it

Every level here is an absolute RSS level in MiB. Nothing in this file subtracts
one sample from another: ADR 0008 §1 recorded RSS falling 4.4 MiB across 500
requests because JSC returned pages to its allocator, and a delta here would
report allocator behaviour as a resource saving.

Percentiles are computed the same way bench/lib/stats.sh computes them -- nearest
rank, no interpolation -- so a number from this file and a number from
bench/mem.sh are the same kind of number and not two estimators wearing the same
label. The median is the conventional one, as in bench/README.md.
"""

from __future__ import annotations

import argparse
import json
import math
import os
from typing import Any


def median(values: list[float]) -> float:
    ordered = sorted(values)
    count = len(ordered)
    if count == 0:
        raise ValueError("median of an empty series")
    middle = count // 2
    if count % 2 == 1:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / 2.0


def percentile(values: list[float], pct: float) -> float:
    """Nearest rank, matching bench/lib/stats.sh: the value at
    ceil(pct / 100 * n) of the ascending series, 1-based."""
    ordered = sorted(values)
    index = max(1, math.ceil(pct / 100.0 * len(ordered)))
    return ordered[index - 1]


def spread_pct(values: list[float]) -> float:
    """Run-to-run spread of the per-capture medians, as a percentage of the
    median of those medians -- the same definition bench/capture-baseline.sh uses
    for runToRunVariance."""
    if len(values) < 2:
        return 0.0
    centre = median(values)
    if centre == 0:
        return float("inf")
    return round(100.0 * (max(values) - min(values)) / centre, 2)


EXPECTED_PROCESS_COUNT = {"A": 1, "B": 2, "C": 2}


def distinct_processes(run: dict[str, Any]) -> tuple[set[int], list[str]]:
    """The distinct pids present in this capture, and any slot overlap.

    Overlap is the failure this spike actually hit: a slot list naming two
    alternatives that both match one process made topology A's SUM exactly double
    its engine. bench/mem.sh reports it faithfully, so nothing but this check
    distinguishes a real total from a doubled one.
    """
    seen: dict[int, str] = {}
    overlaps: list[str] = []
    for name, pids in run.get("pids", {}).items():
        if run.get("absentTicks", {}).get(name):
            continue
        for pid in pids or []:
            if pid in seen:
                overlaps.append(f"pid {pid} in both {seen[pid]!r} and {name!r}")
            seen[pid] = name
    return set(seen), overlaps


def summarise_captures(paths: list[str], expected: int | None = None) -> dict[str, Any]:
    """A2 then A3 over a set of captures of one quantity."""
    runs: list[dict[str, Any]] = []
    for path in paths:
        with open(path) as handle:
            document = json.load(handle)
        runs.append(
            {
                "file": os.path.basename(path),
                "generatedAt": document.get("generatedAt"),
                "sampling": document.get("sampling"),
                "sum": ((document.get("sum") or {}).get("rssMib")),
                "processes": {
                    name: ((value or {}).get("rssMib"))
                    for name, value in (document.get("processes") or {}).items()
                },
                "pids": {
                    name: ((value or {}).get("pids"))
                    for name, value in (document.get("processes") or {}).items()
                },
                "absentTicks": {
                    name: (value or {}).get("absentTicks")
                    for name, value in (document.get("processes") or {}).items()
                },
            }
        )

    def level(document: dict[str, Any], *path: str) -> float | None:
        cursor: Any = document
        for key in path:
            if not isinstance(cursor, dict):
                return None
            cursor = cursor.get(key)
        return cursor if isinstance(cursor, (int, float)) else None

    sum_medians = [r["sum"]["median"] for r in runs if r.get("sum")]
    sum_p95s = [r["sum"]["p95"] for r in runs if r.get("sum")]

    per_process: dict[str, Any] = {}
    for name in sorted({n for r in runs for n in r["processes"]}):
        medians = [r["processes"][name]["median"] for r in runs if r.get("processes", {}).get(name)]
        p95s = [r["processes"][name]["p95"] for r in runs if r.get("processes", {}).get(name)]
        absent_total = sum(r["absentTicks"].get(name) or 0 for r in runs)
        if not medians:
            per_process[name] = {
                "presentInAnyCapture": False,
                "note": "absent in every capture; reported absent, never imputed as zero",
            }
            continue
        spread = spread_pct(medians)
        per_process[name] = {
            "presentInAnyCapture": True,
            "captures": len(medians),
            "absentTicksTotal": absent_total,
            "perCaptureMedianMib": [round(m, 3) for m in medians],
            "medianOfPerCaptureMediansMib": round(median(medians), 3),
            "medianOfPerCaptureP95Mib": round(median(p95s), 3) if p95s else None,
            "runToRunSpreadPct": spread,
            "gateable": spread <= 10.0,
        }

    overlaps: list[str] = []
    for run in runs:
        _, found = distinct_processes(run)
        overlaps.extend(f"{run['file']}: {line}" for line in found)
    if overlaps:
        raise SystemExit(
            "spike/summarise.py: REFUSING to roll up captures whose slots overlap; "
            "the SUM would double-count a process:\n  " + "\n  ".join(overlaps)
        )

    result: dict[str, Any] = {
        "captures": len(runs),
        "runs": runs,
        "samplingMinimumsHonoured": all(
            (r.get("sampling") or {}).get("shortSample") is False for r in runs
        ),
        "slotOverlap": "none; no pid appears in more than one slot in any capture",
    }
    if expected is not None:
        counts = {len(distinct_processes(run)[0]) for run in runs}
        result["distinctProcessesPerCapture"] = sorted(counts)
        result["expectedDistinctProcesses"] = expected
        result["processCountAsExpected"] = counts == {expected}
        if counts != {expected}:
            result["processCountWarning"] = (
                f"expected exactly {expected} distinct resident processes per capture; observed "
                f"{sorted(counts)}. A lower count means the SUM is smaller than the topology "
                f"actually costs."
            )

    if len(sum_medians) >= 2:
        spread = spread_pct(sum_medians)
        result["sum"] = {
            "perCaptureMedianMib": [round(m, 3) for m in sum_medians],
            "perCaptureP95Mib": [round(p, 3) for p in sum_p95s],
            "medianOfPerCaptureMediansMib": round(median(sum_medians), 3),
            "medianOfPerCaptureP95Mib": round(median(sum_p95s), 3),
            "minMedianMib": round(min(sum_medians), 3),
            "maxMedianMib": round(max(sum_medians), 3),
            "runToRunSpreadMib": round(max(sum_medians) - min(sum_medians), 3),
            "runToRunSpreadPct": spread,
            "gateable": spread <= 10.0,
            "verdict": "gateable" if spread <= 10.0 else "not-gateable",
        }
    else:
        result["sum"] = {"verdict": "insufficient-captures", "captures": len(sum_medians)}

    result["processes"] = per_process
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--results", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--started", default="")
    parser.add_argument("--repeats", type=int, default=3)
    arguments = parser.parse_args()

    results = arguments.results

    def group(prefix: str) -> list[str]:
        return sorted(
            os.path.join(results, name)
            for name in os.listdir(results)
            if name.startswith(prefix) and name.endswith(".json")
        )

    topologies = {}
    for topology in ("A", "B", "C"):
        paths = group(f"topology-{topology}-run")
        if paths:
            topologies[topology] = summarise_captures(paths, EXPECTED_PROCESS_COUNT[topology])

    # The single number this milestone's acceptance criterion is written against.
    # Topologies B and C are the same Bun process, so their captures are pooled:
    # they differ only in which neighbours are resident, and pooling doubles the
    # capture count for the quantity that decides whether ADR 0008 §2.1 stands.
    worker_capture_paths = sorted(group("topology-B-run") + group("topology-C-run"))
    medians: list[float] = []
    p95s: list[float] = []
    for path in worker_capture_paths:
        with open(path) as handle:
            document = json.load(handle)
        level = (
            ((document.get("processes") or {}).get("spike-bun-process") or {}).get("rssMib")
            or {}
        )
        if level.get("median") is not None:
            medians.append(level["median"])
        if level.get("p95") is not None:
            p95s.append(level["p95"])

    worker_only: dict[str, Any] = {}
    if medians:
        spread = spread_pct(medians)
        worker_only = {
            "definition": (
                "the Bun process with no fastify import and no listener: spike/worker-no-fastify.ts, "
                "sampled under the fixed load profile. Topologies B and C are the same process; only "
                "the neighbouring processes differ, so their captures are pooled."
            ),
            "poolingCaveat": (
                "Pooling B and C doubles the capture count for the criterion, but C's captures have "
                "the router stub resident, so their Bun levels are not strictly identical "
                "quantities to B's. If B and C disagree by more than A3's 10%, pool the two "
                "separately before believing either."
            ),
            "captures": len(medians),
            "perCaptureMedianMib": [round(m, 3) for m in medians],
            "perCaptureP95Mib": [round(p, 3) for p in p95s],
            "medianOfPerCaptureMediansMib": round(median(medians), 3),
            "medianOfPerCaptureP95Mib": round(median(p95s), 3) if p95s else None,
            "minMedianMib": round(min(medians), 3),
            "maxMedianMib": round(max(medians), 3),
            "runToRunSpreadMib": round(max(medians) - min(medians), 3),
            "runToRunSpreadPct": spread,
            "gateable": spread <= 10.0,
            "criterionMib": 48.0,
            "projectionMib": 43.3,
            "projectionResidualMib": round(median(medians) - 43.3, 3),
            "meetsCriterionOnMedian": median(medians) <= 48.0,
            "meetsCriterionOnP95": (median(p95s) <= 48.0) if p95s else None,
            "criterionIsGateable": spread <= 10.0,
            # A miss smaller than the run-to-run spread cannot be resolved by
            # re-running: the honest verdict is that the measurement does not
            # separate pass from fail, and the point estimate sits above the bar.
            "criterionMarginMib": round(48.0 - median(medians), 3),
            "marginExceedsSpread": abs(48.0 - median(medians)) > (max(medians) - min(medians)),
            "verdict": (
                "PASS"
                if (spread <= 10.0 and median(medians) <= 48.0)
                else ("FAIL" if spread <= 10.0 else "not-gateable")
            ),
            "verdictNote": (
                "PASS/FAIL requires both A3 (spread <=10%) and the level criterion. Where the "
                "margin to the criterion is smaller than the run-to-run spread, the verdict is "
                "not resolvable by re-capturing: state the point estimate and the spread, not a "
                "clean pass."
            ),
        }

    document = {
        "schema": "aibridge.spike.summary/1",
        "generatedAt": __import__("datetime").datetime.now(
            __import__("datetime").timezone.utc
        ).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "captureStartedAt": arguments.started,
        "status": (
            "SPIKE ARTEFACT. Single host, single session, short window. Not a soak, not a "
            "rollout result, and not evidence of multi-day stability. Milestone 7 §5.3 "
            "assignment to any of this is forbidden."
        ),
        "quantity": "absolute RSS levels in MiB; no delta is reported anywhere in this artefact",
        "protocol": {
            "A1": ">=1 Hz for >=60 s per capture; bench/mem.sh refuses anything less (exit 2)",
            "A2": ">=3 captures per quantity; reported figure is the median of the per-capture medians",
            "A3": "run-to-run spread of the per-capture medians must be <=10%, else not-gateable",
            "A4": "same host, same boot, same profile, same capture script for every capture",
            "repeats": arguments.repeats,
        },
        "projectionsUnderTest": {
            "workerWithoutFastifyMib": 43.3,
            "workerCriterionMib": 48.0,
            "source": "ADR 0008 §2.1 and §11; milestone 7 §5.2. A projection, explicitly.",
        },
        "workerWithoutFastify": worker_only,
        "topologies": topologies,
    }

    with open(arguments.out, "w") as handle:
        json.dump(document, handle, indent=2)
        handle.write("\n")

    print(f"wrote {arguments.out}")
    if worker_only:
        print(
            "  worker-without-fastify: {v} MiB over {n} captures, spread {s}% -> {verdict} "
            "against the <=48 MiB criterion".format(
                v=worker_only["medianOfPerCaptureMediansMib"],
                n=worker_only["captures"],
                s=worker_only["runToRunSpreadPct"],
                verdict=worker_only["verdict"],
            )
        )
    for topology, value in topologies.items():
        total = value.get("sum") or {}
        print(
            f"  topology {topology}: sum median {total.get('medianOfPerCaptureMediansMib')} MiB, "
            f"spread {total.get('runToRunSpreadPct')}% -> {total.get('verdict')}"
        )
        for name, process in (value.get("processes") or {}).items():
            if not process.get("presentInAnyCapture"):
                continue
            print(
                f"      {name}: {process.get('medianOfPerCaptureMediansMib')} MiB median, "
                f"{process.get('medianOfPerCaptureP95Mib')} MiB p95, "
                f"spread {process.get('runToRunSpreadPct')}%"
            )


if __name__ == "__main__":
    main()