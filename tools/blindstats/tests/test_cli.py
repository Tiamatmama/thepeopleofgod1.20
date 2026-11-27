import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOOL = ROOT / "blindstats.py"
FIX = ROOT / "fixtures"
CONTRACT = ROOT / "contract.md"


def run(*args, optimize=False):
    cmd = [sys.executable]
    if optimize:
        cmd.append("-O")
    cmd.append(str(TOOL))
    cmd.extend(str(a) for a in args)
    return subprocess.run(
        cmd, capture_output=True, text=True, encoding="utf-8", errors="replace"
    )


class BlindstatsCliTests(unittest.TestCase):
    def test_missing_input_is_exit_2(self):
        with tempfile.TemporaryDirectory() as td:
            proc = run("--out", Path(td) / "out.json")
        self.assertEqual(proc.returncode, 2)

    def test_missing_out_is_exit_2(self):
        proc = run("--input", FIX / "normal_synthetic")
        self.assertEqual(proc.returncode, 2)

    def test_normal_run_exit_0_and_report(self):
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / "out.json"
            proc = run("--input", FIX / "normal_synthetic", "--out", out)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertIn("SUMMARY status=OK", proc.stdout)
            self.assertIn("qs=3", proc.stdout)
            self.assertIn("raters=3", proc.stdout)
            self.assertIn("arms=5", proc.stdout)
            self.assertIn("votes=90", proc.stdout)
            self.assertTrue(out.exists())
            self.assertFalse(Path(str(out) + ".tmp").exists())
            payload = json.loads(out.read_text(encoding="utf-8"))
        self.assertEqual(payload["raters"], ["r1", "r2", "r3"])
        self.assertEqual(payload["arms"], ["arm1", "arm2", "arm3", "arm4", "arm5"])
        q1 = payload["q"]["q1"]
        self.assertEqual(q1["N"], 30)
        self.assertEqual(q1["counts"]["arm1"], 10)
        self.assertAlmostEqual(q1["share"]["arm1"], 10.0 / 30.0, places=12)
        q2 = payload["q"]["q2"]
        for arm in payload["arms"]:
            self.assertEqual(q2["counts"][arm], 6)
            self.assertAlmostEqual(q2["z"][arm], 0.0, places=12)
            self.assertAlmostEqual(q2["p"][arm], 1.0, places=12)
        self.assertEqual(
            payload["warnings"], ["R<6: sign test is reference only"]
        )

    def test_floor_sign_test_direction_and_value(self):
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / "out.json"
            proc = run(
                "--input",
                FIX / "normal_synthetic",
                "--out",
                out,
                "--floor",
                "arm1,arm5",
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            payload = json.loads(out.read_text(encoding="utf-8"))
        floor_q1 = payload["q"]["q1"]["floor"]
        self.assertEqual(floor_q1["pair"], ["arm1", "arm5"])
        self.assertEqual(floor_q1["positive_raters"], 3)
        self.assertEqual(floor_q1["negative_raters"], 0)
        self.assertAlmostEqual(floor_q1["sign_p"], 0.25, places=12)
        self.assertAlmostEqual(floor_q1["mean_vote_diff"], 8.0 / 3.0, places=12)
        floor_q2 = payload["q"]["q2"]["floor"]
        self.assertEqual(floor_q2["positive_raters"], 0)
        self.assertEqual(floor_q2["negative_raters"], 0)
        self.assertAlmostEqual(floor_q2["sign_p"], 1.0, places=12)
        floor_q3 = payload["q"]["q3"]["floor"]
        self.assertEqual(floor_q3["positive_raters"], 0)
        self.assertEqual(floor_q3["negative_raters"], 3)
        self.assertAlmostEqual(floor_q3["sign_p"], 0.25, places=12)

    def test_count_mismatch_is_exit_1_with_diff(self):
        with tempfile.TemporaryDirectory() as td:
            proc = run(
                "--input",
                FIX / "count_mismatch_synthetic",
                "--out",
                Path(td) / "out.json",
            )
        self.assertEqual(proc.returncode, 1)
        self.assertIn("diff=1", proc.stderr)
        self.assertIn("SUMMARY status=NO_DATA", proc.stdout)

    def test_duplicate_rater_is_exit_2_with_both_files(self):
        with tempfile.TemporaryDirectory() as td:
            proc = run(
                "--input",
                FIX / "dup_rater_synthetic",
                "--out",
                Path(td) / "out.json",
            )
        self.assertEqual(proc.returncode, 2)
        self.assertIn("votes_first_synthetic.jsonl", proc.stderr)
        self.assertIn("votes_second_synthetic.jsonl", proc.stderr)

    def test_empty_votes_file_is_exit_2(self):
        with tempfile.TemporaryDirectory() as td:
            proc = run(
                "--input",
                FIX / "empty_votes_synthetic",
                "--out",
                Path(td) / "out.json",
            )
        self.assertEqual(proc.returncode, 2)
        self.assertIn("empty votes file", proc.stderr)

    def test_empty_dir_is_exit_1_no_data(self):
        with tempfile.TemporaryDirectory() as td:
            proc = run(
                "--input",
                FIX / "empty_dir_synthetic",
                "--out",
                Path(td) / "out.json",
            )
        self.assertEqual(proc.returncode, 1)
        self.assertIn("SUMMARY status=NO_DATA", proc.stdout)

    def test_unknown_arm_against_whitelist_is_exit_2(self):
        with tempfile.TemporaryDirectory() as td:
            proc = run(
                "--input",
                FIX / "unknown_arm_synthetic",
                "--out",
                Path(td) / "out.json",
                "--arms",
                "arm1,arm2,arm3,arm4,arm5",
            )
        self.assertEqual(proc.returncode, 2)
        self.assertIn("arm9", proc.stderr)

    def test_floor_arm_not_in_data_is_exit_2(self):
        with tempfile.TemporaryDirectory() as td:
            proc = run(
                "--input",
                FIX / "normal_synthetic",
                "--out",
                Path(td) / "out.json",
                "--floor",
                "arm1,armX",
            )
        self.assertEqual(proc.returncode, 2)
        self.assertIn("armX", proc.stderr)

    def test_missing_field_under_optimize_is_exit_2(self):
        with tempfile.TemporaryDirectory() as td:
            proc = run(
                "--input",
                FIX / "missing_field_synthetic",
                "--out",
                Path(td) / "out.json",
                optimize=True,
            )
        self.assertEqual(proc.returncode, 2)
        self.assertIn("missing/invalid arm", proc.stderr)

    def test_bad_json_is_exit_2(self):
        with tempfile.TemporaryDirectory() as td:
            proc = run(
                "--input",
                FIX / "malformed_synthetic",
                "--out",
                Path(td) / "out.json",
            )
        self.assertEqual(proc.returncode, 2)
        self.assertIn("bad JSON", proc.stderr)

    def test_out_directory_equals_input_is_exit_2(self):
        with tempfile.TemporaryDirectory() as td:
            proc = run("--input", td, "--out", Path(td) / "out.json")
        self.assertEqual(proc.returncode, 2)
        self.assertIn("output directory must differ", proc.stderr)

    def test_symlink_vote_file_is_exit_2(self):
        target = FIX / "normal_synthetic" / "votes_r1_synthetic.jsonl"
        with tempfile.TemporaryDirectory() as td:
            link = Path(td) / "link_synthetic.jsonl"
            try:
                os.symlink(target, link)
            except (OSError, NotImplementedError):
                self.skipTest("symlink creation not permitted")
            proc = run("--input", td, "--out", Path(td).parent / "unused_out.json")
        self.assertEqual(proc.returncode, 2)
        self.assertIn("symlink not allowed", proc.stderr)

    def test_no_forbidden_literals_in_tool(self):
        forbidden = [
            "emtion" + "embedding",
            "math." + "logaddexp",
            "blind_" + "key",
            "real" + "#",
        ]
        targets = [TOOL, CONTRACT]
        targets.extend(sorted((ROOT / "fixtures").rglob("*")))
        for path in targets:
            if not path.is_file():
                continue
            text = path.read_text(encoding="utf-8", errors="replace")
            for token in forbidden:
                self.assertNotIn(token, text, f"{token!r} found in {path.name}")
            self.assertIsNone(
                re.search(r"[A-Za-z]:[\\/]", text),
                f"windows absolute path found in {path.name}",
            )

    def test_contract_exists_and_is_marked_unverified(self):
        self.assertTrue(CONTRACT.exists())
        lines = [
            line.strip()
            for line in CONTRACT.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        self.assertIn("未经真实数据验证", lines[0])


if __name__ == "__main__":
    unittest.main()
