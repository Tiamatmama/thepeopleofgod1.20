#!/usr/bin/env python3
"""Blind-test vote aggregator (zero dependencies, Python 3.10).

Fresh implementation (method-ref only). It does not reproduce, and must not be
compared against, any historical aggregate output.
"""
import argparse
import json
import math
import os
import sys


def fail(code, message):
    print(f"ERROR {message}", file=sys.stderr)
    if code == 1:
        print("SUMMARY status=NO_DATA")
    sys.exit(code)


def norm_sf(z):
    return 0.5 * (1.0 + math.erf(abs(z) / math.sqrt(2.0)))


def sign_test_p(pos, neg):
    nn = pos + neg
    if nn == 0:
        return 1.0
    tail = sum(math.comb(nn, k) for k in range(0, min(pos, neg) + 1))
    return min(1.0, 2.0 * tail / (2 ** nn))


def parse_arms(text):
    if text is None:
        return None
    arms = [part.strip() for part in text.split(",")]
    if any(not arm for arm in arms):
        fail(2, "--arms contains an empty arm name")
    if len(set(arms)) != len(arms):
        fail(2, "--arms contains duplicate arm names")
    return arms


def parse_floor(text):
    if text is None:
        return None
    arms = [part.strip() for part in text.split(",")]
    if len(arms) != 2 or any(not arm for arm in arms):
        fail(2, "--floor must be exactly two comma-separated arm names")
    if arms[0] == arms[1]:
        fail(2, "--floor arms must be different")
    return arms[0], arms[1]


def list_vote_files(input_dir):
    try:
        entries = sorted(os.scandir(input_dir), key=lambda e: e.name)
    except OSError as exc:
        fail(2, f"cannot read input directory: {exc}")
    files = []
    root_real = os.path.realpath(input_dir)
    for entry in entries:
        if not entry.name.endswith(".jsonl"):
            continue
        if entry.is_symlink():
            fail(2, f"symlink not allowed: {entry.name}")
        real = os.path.realpath(entry.path)
        if real != root_real and not real.startswith(root_real + os.sep):
            fail(2, f"path escapes input directory: {entry.name}")
        if not entry.is_file():
            fail(2, f"not a regular file: {entry.name}")
        files.append(entry.path)
    return files


def scan_votes(files, whitelist):
    counts = {}
    cell = {}
    per_q_rater = {}
    rater_total = {}
    rater_file = {}
    arms_seen = set()
    qs_seen = set()
    vote_count = 0

    for path in files:
        name = os.path.basename(path)
        file_rater = None
        records = 0
        try:
            fh = open(path, "r", encoding="utf-8")
        except OSError as exc:
            fail(2, f"cannot read {name}: {exc}")
        with fh:
            for lineno, line in enumerate(fh, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError as exc:
                    fail(2, f"bad JSON at {name}:{lineno}: {exc}")
                if not isinstance(record, dict):
                    fail(2, f"bad record at {name}:{lineno}: not an object")
                rater = record.get("rater")
                q = record.get("q")
                arm = record.get("arm")
                if not isinstance(rater, str) or not rater:
                    fail(2, f"bad record at {name}:{lineno}: missing/invalid rater")
                if not isinstance(q, str) or not q:
                    fail(2, f"bad record at {name}:{lineno}: missing/invalid q")
                if not isinstance(arm, str) or not arm:
                    fail(2, f"bad record at {name}:{lineno}: missing/invalid arm")
                if whitelist is not None and arm not in whitelist:
                    fail(2, f"unknown arm {arm!r} at {name}:{lineno}")

                if file_rater is None:
                    file_rater = rater
                elif rater != file_rater:
                    fail(2, f"mixed raters in {name}")
                previous = rater_file.get(rater)
                if previous is None:
                    rater_file[rater] = name
                elif previous != name:
                    fail(2, f"duplicate rater {rater!r} in {previous} and {name}")

                counts.setdefault(q, {})
                counts[q][arm] = counts[q].get(arm, 0) + 1
                cell[(q, rater, arm)] = cell.get((q, rater, arm), 0) + 1
                per_q_rater[(q, rater)] = per_q_rater.get((q, rater), 0) + 1
                rater_total[rater] = rater_total.get(rater, 0) + 1
                arms_seen.add(arm)
                qs_seen.add(q)
                vote_count += 1
                records += 1
        if records == 0:
            fail(2, f"empty votes file: {name}")

    return {
        "counts": counts,
        "cell": cell,
        "per_q_rater": per_q_rater,
        "rater_total": rater_total,
        "arms": sorted(arms_seen),
        "qs": sorted(qs_seen),
        "votes": vote_count,
        "raters": sorted(rater_total),
    }


def check_balanced(data):
    totals = data["rater_total"]
    if len(totals) > 1:
        low = min(totals.values())
        high = max(totals.values())
        if low != high:
            detail = " ".join(f"{r}={totals[r]}" for r in data["raters"])
            fail(1, f"unequal vote counts: {detail} diff={high - low}")

    for q in data["qs"]:
        per = [data["per_q_rater"].get((q, rater), 0) for rater in data["raters"]]
        low, high = min(per), max(per)
        if low != high:
            detail = " ".join(
                f"{rater}={data['per_q_rater'].get((q, rater), 0)}"
                for rater in data["raters"]
            )
            fail(1, f"unequal votes for q={q!r}: {detail} diff={high - low}")


def aggregate(data, floor):
    arms = data["arms"]
    raters = data["raters"]
    qs = data["qs"]
    if len(arms) < 2:
        fail(1, f"need at least 2 arms, got {len(arms)}")
    if not raters:
        fail(1, "no raters found")

    p0 = 1.0 / len(arms)
    result = {"raters": raters, "arms": arms, "qs": qs, "q": {}}
    for q in qs:
        counts = {arm: data["counts"][q].get(arm, 0) for arm in arms}
        total = sum(counts.values())
        if total <= 0:
            fail(1, f"no votes for q={q!r}")
        share = {arm: counts[arm] / total for arm in arms}
        if abs(sum(share.values()) - 1.0) > 1e-9:
            fail(1, f"share does not sum to 1 for q={q!r}")

        sd = math.sqrt(total * p0 * (1.0 - p0))
        z = {}
        p = {}
        for arm in arms:
            z[arm] = (counts[arm] - p0 * total) / sd if sd > 0 else 0.0
            p[arm] = min(1.0, 2.0 * (1.0 - norm_sf(z[arm])))

        entry = {
            "N": total,
            "p0": p0,
            "counts": counts,
            "share": share,
            "z": z,
            "p": p,
            "floor": None,
        }
        if floor is not None:
            a, b = floor
            diffs = [
                data["cell"].get((q, rater, a), 0)
                - data["cell"].get((q, rater, b), 0)
                for rater in raters
            ]
            pos = sum(1 for d in diffs if d > 0)
            neg = sum(1 for d in diffs if d < 0)
            entry["floor"] = {
                "pair": [a, b],
                "abs_share_gap": abs(share[a] - share[b]),
                "mean_vote_diff": sum(diffs) / len(raters),
                "positive_raters": pos,
                "negative_raters": neg,
                "sign_p": sign_test_p(pos, neg),
            }
        result["q"][q] = entry

    if len(raters) < 6:
        result["warnings"] = ["R<6: sign test is reference only"]
    else:
        result["warnings"] = []
    return result


def print_report(result):
    for q in result["qs"]:
        entry = result["q"][q]
        print(f"[{q}] N={entry['N']} p0={entry['p0']:.4f}")
        for arm in sorted(result["arms"], key=lambda a: -entry["counts"][a]):
            print(
                f"  {arm:10s} count={entry['counts'][arm]:3d} "
                f"share={entry['share'][arm]:6.1%} "
                f"z={entry['z'][arm]:+.2f} p={entry['p'][arm]:.3f}"
            )
        floor = entry["floor"]
        if floor is not None:
            note = " (reference only: R<6)" if len(result["raters"]) < 6 else ""
            print(
                f"  floor |{floor['pair'][0]}-{floor['pair'][1]}|="
                f"{floor['abs_share_gap']:.1%} "
                f"mean_diff={floor['mean_vote_diff']:+.2f} "
                f"sign {floor['positive_raters']}+/{floor['negative_raters']}- "
                f"p={floor['sign_p']:.3f}{note}"
            )
    for warning in result["warnings"]:
        print(f"WARNING {warning}")


def write_json(path, payload):
    tmp = path + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        os.replace(tmp, path)
    except OSError as exc:
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except OSError:
            pass
        fail(2, f"cannot write output: {exc}")


def main(argv=None):
    parser = argparse.ArgumentParser(prog="blindstats.py")
    parser.add_argument("--input", required=True, help="directory of *.jsonl vote files")
    parser.add_argument("--out", required=True, help="aggregate JSON output path")
    parser.add_argument("--arms", help="optional whitelist: arm1,arm2,...")
    parser.add_argument("--floor", help="optional noise-floor pair: armA,armB")
    args = parser.parse_args(argv)

    whitelist = parse_arms(args.arms)
    floor = parse_floor(args.floor)

    if not os.path.isdir(args.input):
        fail(2, f"input is not a directory: {args.input}")
    out_parent = os.path.dirname(os.path.abspath(args.out)) or os.getcwd()
    if not os.path.isdir(out_parent):
        fail(2, f"output directory does not exist: {out_parent}")
    if os.path.isdir(args.out):
        fail(2, f"output path is a directory: {args.out}")
    try:
        same = os.path.samefile(out_parent, args.input)
    except OSError as exc:
        fail(2, f"cannot compare input/output directories: {exc}")
    if same:
        fail(2, "output directory must differ from input directory")

    files = list_vote_files(args.input)
    if not files:
        fail(1, "no .jsonl vote files found")

    data = scan_votes(files, whitelist)
    if data["votes"] == 0:
        fail(1, "no votes found")

    if floor is not None:
        missing = [arm for arm in floor if arm not in data["arms"]]
        if missing:
            fail(2, f"--floor arm not in data: {','.join(missing)}")

    check_balanced(data)
    result = aggregate(data, floor)
    print_report(result)
    write_json(args.out, result)
    print(
        f"SUMMARY status=OK qs={len(result['qs'])} raters={len(result['raters'])} "
        f"arms={len(result['arms'])} votes={data['votes']}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
