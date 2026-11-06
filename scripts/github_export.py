"""Export one GitHub repository's delivery events as a DORA Dash CSV.

Standard library only. Reads GITHUB_TOKEN from the environment.

    GITHUB_TOKEN=... python3 scripts/github_export.py --repo acme/checkout --team Checkout \
        --since 2026-07-01 > events.csv

What it reads:
- Merged pull requests since --since, with their commits and reviews.
- Deployments to --env (default "production"), with their latest status, and the
  commits between each deployment and the one before it (the compare API).
- Optionally, closed issues with --incident-label as incidents. An issue body that says
  "deployment: 123456" links the incident to that deployment.

The pure functions (pr_rows, deployment_rows, incident_rows) do all the mapping and are
unit tested. Only main() and get() touch the network.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import urllib.parse
import urllib.request

API = "https://api.github.com"
COLUMNS = [
    "type",
    "id",
    "team",
    "service",
    "time",
    "pr",
    "review_at",
    "merged_at",
    "env",
    "status",
    "kind",
    "commits",
    "resolved_at",
    "deployment",
]
DEPLOY_LINK = re.compile(r"deployment[\s:#]+(\d+)", re.IGNORECASE)


def pr_rows(repo: str, pull: dict, commits: list[dict], reviews: list[dict], team: str, service: str) -> list[dict]:
    """One `pr` row plus one `commit` row per commit. Unmerged PRs are skipped."""
    if not pull.get("merged_at"):
        return []
    pr_id = f"{repo}#{pull['number']}"
    author = (pull.get("user") or {}).get("login")
    review_times = sorted(
        r["submitted_at"]
        for r in reviews
        if r.get("submitted_at") and r.get("state") != "PENDING" and (r.get("user") or {}).get("login") != author
    )
    rows = [
        {
            "type": "pr",
            "id": pr_id,
            "team": team,
            "service": service,
            "time": pull["created_at"],
            "review_at": review_times[0] if review_times else "",
            "merged_at": pull["merged_at"],
        }
    ]
    for c in commits:
        info = c.get("commit") or {}
        when = (info.get("author") or {}).get("date") or (info.get("committer") or {}).get("date")
        if when:
            rows.append({"type": "commit", "id": c["sha"], "team": team, "service": service, "time": when, "pr": pr_id})
    return rows


def classify(deployment: dict) -> str:
    """normal, hotfix, or rollback, from the ref and description."""
    text = f"{deployment.get('ref', '')} {deployment.get('description') or ''}".lower()
    if "rollback" in text or "revert" in text:
        return "rollback"
    if "hotfix" in text:
        return "hotfix"
    return "normal"


def deploy_status(statuses: list[dict]) -> str:
    """Map the latest GitHub deployment status to success, failed, or pending."""
    if not statuses:
        return "pending"
    latest = max(statuses, key=lambda s: s.get("created_at", ""))
    state = latest.get("state")
    if state in ("success", "inactive"):  # inactive means a newer deploy replaced it
        return "success"
    if state in ("failure", "error"):
        return "failed"
    return "pending"


def deployment_rows(deployments: list[dict], statuses: dict, compares: dict, team: str, service: str) -> list[dict]:
    """One `deployment` row per deployment that finished.

    `statuses` maps deployment id to its status list. `compares` maps deployment id to the
    list of commit shas shipped since the previous deployment. A hotfix or rollback is
    linked to the deployment right before it, which is the one it most likely fixes.
    """
    rows = []
    previous = None
    for d in sorted(deployments, key=lambda x: x["created_at"]):
        status = deploy_status(statuses.get(d["id"], []))
        if status == "pending":
            continue
        kind = classify(d)
        rows.append(
            {
                "type": "deployment",
                "id": str(d["id"]),
                "team": team,
                "service": service,
                "time": d["created_at"],
                "env": d.get("environment", "production"),
                "status": status,
                "kind": kind,
                "commits": ";".join(compares.get(d["id"], [d["sha"]])),
                "deployment": str(previous["id"]) if kind != "normal" and previous else "",
            }
        )
        previous = d
    return rows


def incident_rows(issues: list[dict], team: str, service: str) -> list[dict]:
    """One `incident` row per closed issue. Pull requests in the issues feed are skipped."""
    rows = []
    for i in issues:
        if "pull_request" in i or not i.get("closed_at"):
            continue
        match = DEPLOY_LINK.search(i.get("body") or "")
        rows.append(
            {
                "type": "incident",
                "id": f"issue-{i['number']}",
                "team": team,
                "service": service,
                "time": i["created_at"],
                "resolved_at": i["closed_at"],
                "deployment": match.group(1) if match else "",
            }
        )
    return rows


def write_csv(rows: list[dict], fh) -> None:
    writer = csv.DictWriter(fh, fieldnames=COLUMNS, extrasaction="ignore", lineterminator="\n")
    writer.writeheader()
    for r in rows:
        writer.writerow({c: r.get(c, "") for c in COLUMNS})


# ---------- network ----------


def get(path: str, token: str, params: dict | None = None, paginate: bool = True):
    """GET from the GitHub REST API, following page links for list endpoints."""
    url = f"{API}{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    out = []
    while url:
        req = urllib.request.Request(
            url,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.load(resp)
            link = resp.headers.get("Link", "")
        if not paginate or not isinstance(data, list):
            return data
        out.extend(data)
        nxt = re.search(r'<([^>]+)>;\s*rel="next"', link)
        url = nxt.group(1) if nxt else None
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--repo", required=True, help="owner/name")
    ap.add_argument("--team", required=True)
    ap.add_argument("--service", help="defaults to the repo name")
    ap.add_argument("--since", required=True, help="ISO date, e.g. 2026-07-01")
    ap.add_argument("--env", default="production")
    ap.add_argument("--incident-label", help="issues with this label count as incidents")
    args = ap.parse_args(argv)
    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        print("Set GITHUB_TOKEN first.", file=sys.stderr)
        return 2
    service = args.service or args.repo.split("/")[-1]
    repo = args.repo
    rows: list[dict] = []

    pulls = get(f"/repos/{repo}/pulls", token, {"state": "closed", "sort": "updated", "direction": "desc", "per_page": 100})
    for p in pulls:
        if not p.get("merged_at") or p["merged_at"] < args.since:
            continue
        commits = get(f"/repos/{repo}/pulls/{p['number']}/commits", token, {"per_page": 100})
        reviews = get(f"/repos/{repo}/pulls/{p['number']}/reviews", token, {"per_page": 100})
        rows += pr_rows(repo, p, commits, reviews, args.team, service)

    listed = get(f"/repos/{repo}/deployments", token, {"environment": args.env, "per_page": 100})
    deployments = [d for d in listed if d["created_at"] >= args.since]
    deployments.sort(key=lambda d: d["created_at"])
    statuses, compares = {}, {}
    for prev, d in zip([None, *deployments[:-1]], deployments, strict=True):
        statuses[d["id"]] = get(f"/repos/{repo}/deployments/{d['id']}/statuses", token, {"per_page": 100})
        if prev:
            cmp = get(f"/repos/{repo}/compare/{prev['sha']}...{d['sha']}", token, paginate=False)
            compares[d["id"]] = [c["sha"] for c in cmp.get("commits", [])] or [d["sha"]]
    rows += deployment_rows(deployments, statuses, compares, args.team, service)

    if args.incident_label:
        query = {"labels": args.incident_label, "state": "closed", "since": args.since, "per_page": 100}
        issues = get(f"/repos/{repo}/issues", token, query)
        rows += incident_rows(issues, args.team, service)

    write_csv(rows, sys.stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
