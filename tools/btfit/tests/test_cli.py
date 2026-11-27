#!/usr/bin/env python3
"""CLI gate for bt.py: one assertion point per case, self-contained inputs."""
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BT = os.path.join(ROOT, "bt.py")
FIX = os.path.join(ROOT, "fixtures")

REPORT_THETA = {
    "persona": {"old": -0.2725, "new": 0.4770, "old#dup": -0.2045},
    "emotion": {"old": -0.0339, "new": -0.3730, "old#dup": 0.4069},
}


def run(*args, flags=()):
    return subprocess.run(
        [sys.executable, *flags, BT, *args],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )


def theta_map(stdout):
    summary = next(line for line in stdout.splitlines() if line.startswith("SUMMARY"))
    return {
        name: float(value)
        for name, value in re.findall(r"theta=([^:\s]+):(-?[0-9.]+)", summary)
    }


class BtFitCliTest(unittest.TestCase):
    def test_selftest(self):
        self.assertEqual(run("selftest").returncode, 0)

    def test_persona_report_theta(self):
        # The historical report's theta corresponds to eps=1.0, i.e. l2=0.025
        # under the frozen normalization; the extracted default stays 0.02.
        proc = run("fit", "--input", os.path.join(FIX, "persona_W.json"), "--l2", "0.025")
        got = theta_map(proc.stdout)
        worst = max(abs(got[k] - v) for k, v in REPORT_THETA["persona"].items())
        self.assertLess(worst, 1e-3)

    def test_emotion_report_theta(self):
        proc = run("fit", "--input", os.path.join(FIX, "emotion_W.json"), "--l2", "0.025")
        got = theta_map(proc.stdout)
        worst = max(abs(got[k] - v) for k, v in REPORT_THETA["emotion"].items())
        self.assertLess(worst, 1e-3)

    def test_missing_input_argument(self):
        self.assertEqual(run("fit").returncode, 2)

    def test_duplicate_key(self):
        self.assertEqual(run("fit", "--input", os.path.join(FIX, "dup_key.json")).returncode, 2)

    def test_bool_weight(self):
        self.assertEqual(
            run("fit", "--input", os.path.join(FIX, "bool_weight.json")).returncode, 2
        )

    def test_self_loop(self):
        self.assertEqual(
            run("fit", "--input", os.path.join(FIX, "self_loop.json")).returncode, 2
        )

    def test_zero_l2(self):
        self.assertEqual(
            run(
                "fit", "--input", os.path.join(FIX, "pair_11_9.json"), "--l2", "0"
            ).returncode,
            2,
        )

    def test_non_convergence_is_exit_1(self):
        proc = run(
            "fit", "--input", os.path.join(FIX, "pair_11_9.json"), "--iters", "1"
        )
        self.assertEqual(proc.returncode, 1)

    def test_non_convergence_under_optimize_flag(self):
        proc = run(
            "fit", "--input", os.path.join(FIX, "pair_11_9.json"), "--iters", "1",
            flags=("-O",),
        )
        self.assertEqual(proc.returncode, 1)

    def test_empty_input(self):
        proc = run("fit", "--input", os.path.join(FIX, "empty.json"))
        self.assertEqual((proc.returncode, "empty input: 0 arms" in proc.stderr), (2, True))

    def test_all_zero_weights_is_degenerate_but_ok(self):
        proc = run("fit", "--input", os.path.join(FIX, "all_zero.json"))
        self.assertEqual((proc.returncode, "degenerate=1" in proc.stdout), (0, True))

    def test_name_containing_gt(self):
        self.assertEqual(
            run("fit", "--input", os.path.join(FIX, "name_with_gt.json")).returncode, 2
        )

    def test_negative_weight(self):
        self.assertEqual(
            run("fit", "--input", os.path.join(FIX, "negative_weight.json")).returncode, 2
        )

    def test_nonfinite_weight(self):
        self.assertEqual(
            run("fit", "--input", os.path.join(FIX, "nonfinite_weight.json")).returncode, 2
        )

    def test_max_items_is_checked_before_matrix(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "many.json")
            arms = [f"arm{i}" for i in range(65)]
            data = {f"{arms[i]}>arm0": 1 for i in range(1, 65)}
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(data, fh)
            proc = run("fit", "--input", path)
        self.assertEqual(
            (proc.returncode, "max_items=64 measured_n=65" in proc.stderr), (2, True)
        )

    def test_l2_shrinks_gap_monotonically(self):
        def gap(l2):
            proc = run(
                "fit", "--input", os.path.join(FIX, "pair_11_9.json"), "--l2", str(l2)
            )
            theta = theta_map(proc.stdout)
            return theta["A"] - theta["B"]

        weak, strong = gap(0.02), gap(0.2)
        self.assertTrue(weak > strong > 0)

    def test_no_external_project_or_abs_path_references(self):
        tokens = ["emtion" + "embedding", "math." + "logaddexp"]
        abs_path = re.compile(r"[A-Za-z]:[\\/]")
        offenders = []
        for base, _, files in os.walk(ROOT):
            for name in files:
                if name == "test_cli.py":
                    continue
                path = os.path.join(base, name)
                try:
                    with open(path, "r", encoding="utf-8") as fh:
                        text = fh.read()
                except (OSError, UnicodeDecodeError):
                    continue
                rel = os.path.relpath(path, ROOT)
                for token in tokens:
                    if token in text:
                        offenders.append(f"{rel}:{token}")
                if abs_path.search(text):
                    offenders.append(f"{rel}:abs-path")
        self.assertEqual(offenders, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
