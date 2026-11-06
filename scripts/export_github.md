# Building the input CSV from GitHub

DORA Dash needs four kinds of events: commits, pull requests, deployments, and incidents. GitHub has the first three through its REST API. Incidents usually live in a separate tool (PagerDuty, Opsgenie, a status page), but a labeled issue works as a stand-in.

This assumes your deploy pipeline creates GitHub Deployments (GitHub Actions does this when a job sets `environment: production`). If it does not, export deploy records from your CD tool with the same columns.

## Option 1: the script

`github_export.py` uses only the Python standard library. It reads `GITHUB_TOKEN` from the environment. A fine-grained token with read access to pull requests, deployments, contents, and issues on the repository is enough.

```bash
export GITHUB_TOKEN=...   # never commit this
python3 scripts/github_export.py --repo your-org/checkout --team Checkout --since 2026-07-01 \
  --incident-label incident > checkout.csv
```

Run it once per repository and concatenate the files (keep one header):

```bash
{ cat checkout.csv; tail -n +2 ledger.csv; } > events.csv
```

Then click "Upload CSV or JSON" in the app.

How it maps GitHub data to the schema:

| Event | GitHub source | Notes |
|---|---|---|
| `pr` | `GET /repos/{repo}/pulls?state=closed` | Merged PRs only. `review_at` is the first submitted review by someone other than the author. |
| `commit` | `GET /repos/{repo}/pulls/{n}/commits` | Author date of each commit, tagged with the PR id. |
| `deployment` | `GET /repos/{repo}/deployments?environment=production` | `status` comes from the latest entry in `/deployments/{id}/statuses`: success or inactive become success, failure or error become failed. Deployments still queued or in progress are skipped. |
| deployment `commits` | `GET /repos/{repo}/compare/{previous_sha}...{sha}` | Everything shipped since the previous production deployment. The very first deployment in the window only lists its own sha. |
| deployment `kind` | ref and description | "hotfix" in either makes it a hotfix. "rollback" or "revert" makes it a rollback. Both link to the deployment just before them. |
| `incident` | `GET /repos/{repo}/issues?labels=incident&state=closed` | Opened time is the start, closed time is the restore time. A body line like `deployment: 123456` links it to that deployment. |

## Option 2: by hand with `gh api`

The same calls with the GitHub CLI, if you want to look at the raw data first:

```bash
REPO=your-org/checkout

# Merged PRs with open, merge, and first-review times
gh api --paginate "repos/$REPO/pulls?state=closed&per_page=100" \
  --jq '.[] | select(.merged_at != null) | [.number, .created_at, .merged_at] | @tsv'
gh api "repos/$REPO/pulls/123/reviews" --jq '[.[] | select(.state != "PENDING") | .submitted_at] | min'

# Commits in one PR
gh api --paginate "repos/$REPO/pulls/123/commits" --jq '.[] | [.sha, .commit.author.date] | @tsv'

# Production deployments and their latest status
gh api --paginate "repos/$REPO/deployments?environment=production&per_page=100" \
  --jq '.[] | [.id, .sha, .ref, .created_at] | @tsv'
gh api "repos/$REPO/deployments/456789/statuses" --jq '.[0].state'

# Commits shipped by a deployment
gh api "repos/$REPO/compare/PREV_SHA...THIS_SHA" --jq '.commits[].sha'
```

## Rate limits

The script makes about three calls per PR and two per deployment. A quarter for a busy repository (300 PRs, 200 deployments) is roughly 1,300 calls, well inside the 5,000 per hour an authenticated token gets. For larger exports, narrow `--since` and run in pieces.
