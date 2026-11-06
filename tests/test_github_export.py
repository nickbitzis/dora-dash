"""Tests for the pure mapping functions in scripts/github_export.py. No network."""

import io
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import github_export as gx  # noqa: E402

PULL = {"number": 7, "created_at": "2026-07-06T10:00:00Z", "merged_at": "2026-07-07T09:00:00Z", "user": {"login": "ana"}}
COMMITS = [
    {"sha": "aaa111", "commit": {"author": {"date": "2026-07-06T08:00:00Z"}}},
    {"sha": "bbb222", "commit": {"author": {"date": "2026-07-06T09:30:00Z"}}},
]
REVIEWS = [
    {"user": {"login": "ana"}, "state": "COMMENTED", "submitted_at": "2026-07-06T10:05:00Z"},  # self-review ignored
    {"user": {"login": "raj"}, "state": "PENDING", "submitted_at": None},
    {"user": {"login": "raj"}, "state": "APPROVED", "submitted_at": "2026-07-06T15:00:00Z"},
]


class PullRequests(unittest.TestCase):
    def test_pr_and_commit_rows(self):
        rows = gx.pr_rows("acme/pay", PULL, COMMITS, REVIEWS, "Pay", "pay-api")
        self.assertEqual([r["type"] for r in rows], ["pr", "commit", "commit"])
        self.assertEqual(rows[0]["id"], "acme/pay#7")
        self.assertEqual(rows[0]["review_at"], "2026-07-06T15:00:00Z")
        self.assertEqual(rows[1]["pr"], "acme/pay#7")
        self.assertEqual(rows[2]["time"], "2026-07-06T09:30:00Z")

    def test_unmerged_pr_is_skipped(self):
        self.assertEqual(gx.pr_rows("acme/pay", {**PULL, "merged_at": None}, COMMITS, [], "Pay", "pay-api"), [])


class Deployments(unittest.TestCase):
    def test_status_kind_commits_and_fix_link(self):
        deps = [
            {"id": 2, "sha": "s2", "ref": "hotfix/refund", "created_at": "2026-07-08T12:00:00Z", "environment": "production"},
            {"id": 1, "sha": "s1", "ref": "main", "created_at": "2026-07-08T10:00:00Z", "environment": "production"},
            {"id": 3, "sha": "s3", "ref": "main", "created_at": "2026-07-09T10:00:00Z", "environment": "production"},
        ]
        statuses = {
            1: [{"state": "in_progress", "created_at": "a"}, {"state": "inactive", "created_at": "b"}],
            2: [{"state": "failure", "created_at": "a"}],
            3: [{"state": "queued", "created_at": "a"}],
        }
        rows = gx.deployment_rows(deps, statuses, {2: ["c1", "c2"]}, "Pay", "pay-api")
        self.assertEqual([r["id"] for r in rows], ["1", "2"])  # 3 is still pending
        self.assertEqual(rows[0]["status"], "success")
        self.assertEqual(rows[0]["commits"], "s1")
        self.assertEqual(rows[1]["kind"], "hotfix")
        self.assertEqual(rows[1]["status"], "failed")
        self.assertEqual(rows[1]["commits"], "c1;c2")
        self.assertEqual(rows[1]["deployment"], "1")

    def test_rollback_detected_from_description(self):
        self.assertEqual(gx.classify({"ref": "main", "description": "Rollback to v41"}), "rollback")
        self.assertEqual(gx.classify({"ref": "main", "description": None}), "normal")


class Incidents(unittest.TestCase):
    def test_issue_to_incident_with_deploy_link(self):
        issues = [
            {"number": 9, "created_at": "2026-07-08T13:00:00Z", "closed_at": "2026-07-08T15:00:00Z", "body": "Caused by deployment: 2"},
            {"number": 10, "created_at": "x", "closed_at": None, "body": ""},
            {"number": 11, "created_at": "x", "closed_at": "y", "pull_request": {}, "body": ""},
        ]
        rows = gx.incident_rows(issues, "Pay", "pay-api")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["deployment"], "2")
        self.assertEqual(rows[0]["resolved_at"], "2026-07-08T15:00:00Z")


class Csv(unittest.TestCase):
    def test_header_and_quoting(self):
        buf = io.StringIO()
        gx.write_csv([{"type": "pr", "id": "a,b", "team": "Pay"}], buf)
        header, line = buf.getvalue().splitlines()
        self.assertEqual(header.split(","), gx.COLUMNS)
        self.assertTrue(line.startswith('pr,"a,b",Pay,'))


if __name__ == "__main__":
    unittest.main()
