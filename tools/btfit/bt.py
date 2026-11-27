#!/usr/bin/env python3
"""Bradley-Terry fit CLI (zero dependencies, Python 3.10).

Source: pairwise.py@60-63 (logaddexp) and pairwise.py@241-294 (bt_fit),
plus regression data from pairwise_report.json@487-503.

The local logaddexp is deliberate: the standard-library version only exists
in Python 3.11+, and the target runtime is 3.10.
"""
import argparse
import json
import math
import sys

ITERS_CAP = 100000
DEFAULT_ITERS = 5000
DEFAULT_L2 = 0.02
DEFAULT_MAX_ITEMS = 64


class InputError(Exception):
    """Bad input: exit 2, never a partial result."""


class NoConverge(Exception):
    """Valid input but the MM iteration did not settle: exit 1."""

    def __init__(self, used, delta):
        super().__init__(
            f"not converged after {used} iters (max|dtheta|={delta:.2e}, threshold 1e-8)"
        )
        self.used = used


def logaddexp(a, b):
    # Numerically stable log(e^a + e^b); frozen copy of pairwise.py@60-63.
    m = max(a, b)
    return m + math.log(math.exp(a - m) + math.exp(b - m))


def _no_duplicate_keys(pairs):
    out = {}
    for key, value in pairs:
        if key in out:
            raise InputError(f"duplicate key: {key!r}")
        out[key] = value
    return out


def load_w(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            text = fh.read()
    except OSError as exc:
        raise InputError(f"cannot read input: {exc}")
    try:
        data = json.loads(text, object_pairs_hook=_no_duplicate_keys)
    except InputError:
        raise
    except json.JSONDecodeError as exc:
        raise InputError(f"JSON parse error: {exc}")
    if not isinstance(data, dict):
        raise InputError("top-level JSON must be an object mapping 'A>B' to weight")
    return data


def derive_names(weights):
    # Step 2 of the frozen check order: name set (and therefore n) comes
    # from the keys before any matrix is allocated.
    names = set()
    for key in weights:
        for part in key.split(">"):
            if part:
                names.add(part)
    return sorted(names)


def build_matrix(weights, names):
    index = {name: i for i, name in enumerate(names)}
    size = len(names)
    mat = [[0.0] * size for _ in range(size)]
    for key, value in weights.items():
        parts = key.split(">")
        if len(parts) != 2 or not parts[0] or not parts[1]:
            raise InputError(
                f"invalid key {key!r}: expected exactly one '>' with non-empty names"
            )
        winner, loser = parts
        if winner == loser:
            raise InputError(f"self-loop not allowed: {key!r}")
        if isinstance(value, bool):
            raise InputError(f"weight must be a number, got bool at {key!r}")
        if not isinstance(value, (int, float)):
            raise InputError(
                f"weight must be a number, got {type(value).__name__} at {key!r}"
            )
        weight = float(value)
        if not math.isfinite(weight):
            raise InputError(f"weight must be finite at {key!r}")
        if weight < 0:
            raise InputError(f"weight must be >= 0 at {key!r}")
        mat[index[winner]][index[loser]] += weight
    return mat


def bt_fit(mat, l2, iters):
    """Return (theta, iters_used). Raises NoConverge instead of guessing."""
    size = len(mat)
    win = [sum(row) for row in mat]
    total = sum(win)
    if total <= 0:
        return [0.0] * size, 0
    eps = l2 * total / size
    active = [
        i
        for i in range(size)
        if win[i] > 0 or any(mat[j][i] > 0 for j in range(size))
    ] or list(range(size))

    def loglik(theta):
        value = 0.0
        for i in active:
            for j in active:
                if i != j and mat[i][j] > 0:
                    value += mat[i][j] * (theta[i] - logaddexp(theta[i], theta[j]))
            value += eps * theta[i] - eps * logaddexp(theta[i], 0.0)
        return value

    theta = [0.0] * size
    prev_ll = None
    delta = float("inf")
    used = 0
    for step in range(iters):
        new = list(theta)
        for i in active:
            den = sum(
                (mat[i][j] + mat[j][i]) / (math.exp(theta[i]) + math.exp(theta[j]))
                for j in active
                if j != i and (mat[i][j] + mat[j][i]) > 0
            )
            den += eps / (math.exp(theta[i]) + 1.0)
            new[i] = math.log(win[i] + eps) - math.log(den)
        mean = sum(new[i] for i in active) / len(active)
        new = [x - mean for x in new]
        cur_ll = loglik(new)
        if prev_ll is not None and cur_ll < prev_ll - 1e-9:
            raise RuntimeError(
                f"log-likelihood decreased {prev_ll:.6f} -> {cur_ll:.6f}; "
                "MM monotonicity is broken"
            )
        prev_ll = cur_ll
        delta = max(abs(new[i] - theta[i]) for i in active)
        theta = new
        used = step + 1
        if delta < 1e-8:
            break
    else:
        raise NoConverge(iters, delta)
    return theta, used


def _theta_text(names, theta):
    return " ".join(f"theta={name}:{theta[i]:.6f}" for i, name in enumerate(names))


def cmd_fit(args):
    if not math.isfinite(args.l2) or args.l2 <= 0:
        raise InputError(f"--l2 must be a finite number > 0, got {args.l2}")
    if args.iters <= 0:
        raise InputError(f"--iters must be > 0, got {args.iters}")
    if args.iters > ITERS_CAP:
        raise InputError(f"--iters {args.iters} exceeds hard cap {ITERS_CAP}")
    if args.max_items <= 0:
        raise InputError(f"--max-items must be > 0, got {args.max_items}")

    weights = load_w(args.input)
    if not weights:
        raise InputError("empty input: 0 arms")
    names = derive_names(weights)
    if len(names) > args.max_items:
        raise InputError(
            f"too many arms: max_items={args.max_items} measured_n={len(names)}"
        )
    mat = build_matrix(weights, names)

    total = sum(sum(row) for row in mat)
    degenerate = 1 if total <= 0 else 0
    if degenerate:
        theta, used = [0.0] * len(names), 0
        print(
            "WARNING all weights are zero: no comparisons, theta is a constant 0 vector",
            file=sys.stderr,
        )
    else:
        try:
            theta, used = bt_fit(mat, args.l2, args.iters)
        except NoConverge as exc:
            print(f"ERROR {exc}", file=sys.stderr)
            print(
                f"SUMMARY status=NO_CONVERGE n={len(names)} "
                f"iters_cap={ITERS_CAP} iters_used={exc.used} degenerate=0"
            )
            return 1
        except RuntimeError as exc:
            print(f"ERROR {exc}", file=sys.stderr)
            print(
                f"SUMMARY status=NO_CONVERGE n={len(names)} "
                f"iters_cap={ITERS_CAP} iters_used={used} degenerate=0"
            )
            return 1

    print(
        f"SUMMARY status=OK n={len(names)} iters_cap={ITERS_CAP} "
        f"iters_used={used} degenerate={degenerate} {_theta_text(names, theta)}"
    )
    return 0


def _tie_matrix(size, count):
    mat = [[0.0] * size for _ in range(size)]
    for i in range(size):
        for j in range(size):
            if i != j:
                mat[i][j] = float(count)
    return mat


def cmd_selftest():
    cases = []

    theta, _ = bt_fit(_tie_matrix(4, 20), DEFAULT_L2, DEFAULT_ITERS)
    cases.append(("all ties 20:20 -> all theta 0", max(abs(x) for x in theta) < 1e-6))

    mat = [[0.0, 11.0], [9.0, 0.0]]
    theta, _ = bt_fit(mat, DEFAULT_L2, DEFAULT_ITERS)
    gap = theta[0] - theta[1]
    cases.append(("11:9 -> gap=log(11/9)=0.201", abs(gap - math.log(11 / 9)) < 0.005))

    mat = _tie_matrix(4, 20)
    mat[0][1], mat[1][0] = 22.0, 18.0
    theta, _ = bt_fit(mat, DEFAULT_L2, DEFAULT_ITERS)
    gap = theta[0] - theta[1]
    cases.append(("all ties + (0,1) 22:18 -> gap ~ 0.098", 0.05 < gap < 0.15))

    mat = _tie_matrix(4, 20)
    for i in (0, 1):
        for j in (2, 3):
            mat[i][j], mat[j][i] = 20.0, 0.0
    theta, _ = bt_fit(mat, DEFAULT_L2, DEFAULT_ITERS)
    gap = (theta[0] + theta[1]) / 2 - (theta[2] + theta[3]) / 2
    symmetric = abs(theta[0] - theta[1]) < 1e-6 and abs(theta[2] - theta[3]) < 1e-6
    cases.append(("group 20:0 -> gap > 3.5 and symmetric", gap > 3.5 and symmetric))

    try:
        bt_fit([[0.0, 11.0], [9.0, 0.0]], DEFAULT_L2, 0)
        failed = False
    except NoConverge:
        failed = True
    cases.append(("iters=0 -> must raise", failed))

    for name, ok in cases:
        print(f"[{'PASS' if ok else 'FAIL'}] {name}")
    passed = sum(1 for _, ok in cases if ok)
    print(f"SUMMARY status={'OK' if passed == len(cases) else 'FAIL'} "
          f"passed={passed} total={len(cases)}")
    return 0 if passed == len(cases) else 1


def main(argv=None):
    parser = argparse.ArgumentParser(prog="bt.py")
    sub = parser.add_subparsers(dest="command", required=True)

    fit = sub.add_parser("fit", help="fit Bradley-Terry strengths from A>B counts")
    fit.add_argument("--input", required=True, help="JSON object: {\"A>B\": weight}")
    fit.add_argument("--l2", type=float, default=DEFAULT_L2)
    fit.add_argument("--iters", type=int, default=DEFAULT_ITERS)
    fit.add_argument("--max-items", type=int, default=DEFAULT_MAX_ITEMS)

    sub.add_parser("selftest", help="run the frozen synthetic cases")

    args = parser.parse_args(argv)
    if args.command == "selftest":
        return cmd_selftest()
    try:
        return cmd_fit(args)
    except InputError as exc:
        print(f"ERROR {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
