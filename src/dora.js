// DORA metric math. No DOM code, so everything here runs under `node --test`.
//
// Input is a list of delivery events, normalized into four arrays:
//   commits:     { id, team, service, time, pr }
//   prs:         { id, team, service, time (opened), reviewAt, mergedAt }
//   deployments: { id, team, service, time, env, status, kind, commits: [sha], fixes }
//   incidents:   { id, team, service, time (start), resolvedAt, deployment }
// All times are epoch milliseconds (UTC).
//
// Definitions used throughout:
// - Production deployment: a deployment whose env is "production" (or "prod").
//   Staging and other environments are ignored by every metric.
// - Change: one pull request and its commits. A commit with no PR is its own change.
// - Lead time for changes: from the first commit of a change to the first production
//   deployment that contains any of its commits. Reported as median and p90.
// - Deployment frequency: production deployments per week over the whole period.
// - Change failure rate: failed production deployments / all production deployments.
//   A deployment counts as failed if any of these is true:
//     1. an incident names it in its `deployment` field,
//     2. its status is "rolled_back" or "failed",
//     3. a later hotfix or rollback deployment names it in its `fixes` field.
// - Time to restore service: incident resolved time minus start time. Reported as
//   the median over incidents (so one very long outage does not swamp the number).
//   Incidents with no linked deployment still count here, but not in failure rate.
// - Rework rate: production deployments whose kind is "hotfix" or "rollback", as a
//   share of all production deployments. These are unplanned deployments made to
//   fix something that just shipped.

export const HOUR = 3600e3;
export const DAY = 24 * HOUR;
export const WEEK = 7 * DAY;

export const STAGES = [
  { key: "coding", label: "Coding", desc: "first commit to PR opened" },
  { key: "reviewWait", label: "Review wait", desc: "PR opened to first review" },
  { key: "review", label: "Review", desc: "first review to merge" },
  { key: "deploy", label: "Merge to deploy", desc: "merge to production deployment" },
];

// ---------- small stats helpers ----------

// Quantile with linear interpolation between closest ranks (same as numpy's default).
export function quantile(values, q) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}
export const median = (values) => quantile(values, 0.5);
const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);

// Monday 00:00 UTC of the week containing t.
export function weekStart(t) {
  const d = new Date(t);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - day * DAY;
}

// ---------- CSV ----------

// RFC 4180 style parser: quoted fields may contain commas, newlines, and "" for a quote.
export function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false, i = 0;
  text = text.replace(/^﻿/, "");
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"' && field === "") { inQuotes = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += c; i++;
  }
  if (inQuotes) throw new Error("CSV ends inside a quoted field");
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  const nonEmpty = rows.filter((r) => r.some((f) => f.trim() !== ""));
  if (!nonEmpty.length) return [];
  const header = nonEmpty[0].map((h) => h.trim().toLowerCase());
  return nonEmpty.slice(1).map((r) => Object.fromEntries(header.map((h, k) => [h, (r[k] ?? "").trim()])));
}

const csvCell = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function toCSV(rows, columns) {
  return [columns.join(","), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n";
}

// ---------- schema ----------

export const COLUMNS = ["type", "id", "team", "service", "time", "pr", "review_at", "merged_at", "env", "status", "kind", "commits", "resolved_at", "deployment"];

const iso = (t) => (t == null ? "" : new Date(t).toISOString().replace(".000Z", "Z"));

function parseTime(v, what, errors, line) {
  if (v == null || v === "") return null;
  const t = typeof v === "number" ? v : Date.parse(v);
  if (Number.isNaN(t)) { errors.push(`Row ${line}: cannot read ${what} "${v}" as a date`); return null; }
  return t;
}

function normEnv(v) {
  const e = String(v || "production").trim().toLowerCase();
  return e === "prod" ? "production" : e;
}

// Turn generic rows (from CSV or JSON) into the four event arrays.
export function normalize(rows) {
  const model = { commits: [], prs: [], deployments: [], incidents: [] };
  const errors = [];
  rows.forEach((r, k) => {
    const line = k + 2; // header is line 1
    const type = String(r.type || "").trim().toLowerCase();
    const base = { id: String(r.id ?? "").trim(), team: String(r.team || "unassigned").trim(), service: String(r.service || "").trim() };
    if (!base.id) { errors.push(`Row ${line}: missing id`); return; }
    if (r.time == null || r.time === "") { errors.push(`Row ${line}: missing time`); return; }
    const time = parseTime(r.time, "time", errors, line);
    if (time == null) return;
    if (type === "commit") {
      model.commits.push({ ...base, time, pr: String(r.pr ?? "").trim() || null });
    } else if (type === "pr" || type === "pull_request") {
      model.prs.push({ ...base, time, reviewAt: parseTime(r.review_at, "review_at", errors, line), mergedAt: parseTime(r.merged_at, "merged_at", errors, line) });
    } else if (type === "deployment" || type === "deploy") {
      const commits = Array.isArray(r.commits) ? r.commits.map(String) : String(r.commits || "").split(/[;\s|]+/).filter(Boolean);
      model.deployments.push({
        ...base, time, env: normEnv(r.env), status: String(r.status || "success").trim().toLowerCase(),
        kind: String(r.kind || "normal").trim().toLowerCase(), commits, fixes: String(r.deployment ?? "").trim() || null,
      });
    } else if (type === "incident") {
      model.incidents.push({ ...base, time, resolvedAt: parseTime(r.resolved_at, "resolved_at", errors, line), deployment: String(r.deployment ?? "").trim() || null });
    } else {
      errors.push(`Row ${line}: unknown type "${r.type}" (expected commit, pr, deployment, or incident)`);
    }
  });
  return { model, errors };
}

// Accepts CSV text, a JSON array of rows, or {"events": [...]}.
export function parseEvents(text) {
  const trimmed = text.trim();
  if (!trimmed) return { model: { commits: [], prs: [], deployments: [], incidents: [] }, errors: ["No data"] };
  if (trimmed[0] === "[" || trimmed[0] === "{") {
    let data;
    try { data = JSON.parse(trimmed); } catch (e) { return { model: null, errors: [`JSON: ${e.message}`] }; }
    const rows = Array.isArray(data) ? data : data.events;
    if (!Array.isArray(rows)) return { model: null, errors: ['JSON must be an array of events or {"events": [...]}'] };
    return normalize(rows);
  }
  try { return normalize(parseCSV(trimmed)); } catch (e) { return { model: null, errors: [e.message] }; }
}

export function modelToRows(model) {
  const rows = [];
  for (const p of model.prs) rows.push({ type: "pr", id: p.id, team: p.team, service: p.service, time: iso(p.time), review_at: iso(p.reviewAt), merged_at: iso(p.mergedAt) });
  for (const c of model.commits) rows.push({ type: "commit", id: c.id, team: c.team, service: c.service, time: iso(c.time), pr: c.pr ?? "" });
  for (const d of model.deployments) rows.push({ type: "deployment", id: d.id, team: d.team, service: d.service, time: iso(d.time), env: d.env, status: d.status, kind: d.kind, commits: d.commits.join(";"), deployment: d.fixes ?? "" });
  for (const i of model.incidents) rows.push({ type: "incident", id: i.id, team: i.team, service: i.service, time: iso(i.time), resolved_at: iso(i.resolvedAt), deployment: i.deployment ?? "" });
  return rows.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
}

export const modelToCSV = (model) => toCSV(modelToRows(model), COLUMNS);

// ---------- core metrics ----------

export const isProd = (d) => d.env === "production";
export const teamsOf = (model) => [...new Set([...model.deployments, ...model.prs, ...model.commits, ...model.incidents].map((e) => e.team))].sort();
const byTeam = (team) => (e) => !team || e.team === team;

// Map of production deployment id -> list of reasons it counts as failed.
export function attributeFailures(model) {
  const prodIds = new Set(model.deployments.filter(isProd).map((d) => d.id));
  const reasons = new Map();
  const add = (id, why) => {
    if (!id || !prodIds.has(id)) return;
    if (!reasons.has(id)) reasons.set(id, []);
    if (!reasons.get(id).includes(why)) reasons.get(id).push(why);
  };
  for (const i of model.incidents) add(i.deployment, "incident");
  for (const d of model.deployments) {
    if (!isProd(d)) continue;
    if (d.status === "rolled_back" || d.status === "failed") add(d.id, d.status === "failed" ? "failed" : "rollback");
    if ((d.kind === "hotfix" || d.kind === "rollback") && d.fixes) add(d.fixes, d.kind);
  }
  return reasons;
}

// One record per change that reached production, with its stage breakdown.
// Stage boundaries are clamped so they never go backwards and never pass the
// deploy time, which guarantees the four stages add up to the total exactly.
export function changes(model) {
  const prod = model.deployments.filter(isProd).sort((a, b) => a.time - b.time);
  const firstDeploy = new Map(); // sha -> deployment
  for (const d of prod) for (const sha of d.commits) if (!firstDeploy.has(sha)) firstDeploy.set(sha, d);
  const prById = new Map(model.prs.map((p) => [p.id, p]));
  const groups = new Map();
  for (const c of model.commits) {
    const key = c.pr ? `pr:${c.pr}` : `commit:${c.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const out = [];
  for (const [key, commits] of groups) {
    let dep = null;
    for (const c of commits) {
      const d = firstDeploy.get(c.id);
      if (d && (!dep || d.time < dep.time)) dep = d;
    }
    if (!dep) continue;
    const pr = commits[0].pr ? prById.get(commits[0].pr) : null;
    const t0 = Math.min(...commits.map((c) => c.time));
    const t4 = dep.time;
    if (t4 < t0) continue; // clock skew or bad data: skip rather than report negative time
    const clamp = (v, lo) => Math.min(t4, Math.max(lo, v ?? lo));
    const t1 = clamp(pr?.time, t0), t2 = clamp(pr?.reviewAt, t1), t3 = clamp(pr?.mergedAt, t2);
    out.push({
      key, pr: pr?.id ?? null, team: pr?.team ?? commits[0].team, commits: commits.length,
      firstCommit: t0, deployedAt: t4, deployment: dep.id, total: t4 - t0,
      stages: { coding: t1 - t0, reviewWait: t2 - t1, review: t3 - t2, deploy: t4 - t3 },
    });
  }
  return out.sort((a, b) => a.deployedAt - b.deployedAt);
}

// Average time per change in each stage. Stage means add up to the mean lead time.
export function breakdown(chgs) {
  const total = mean(chgs.map((c) => c.total));
  const res = { n: chgs.length, total: total ?? 0, stages: {}, shares: {} };
  for (const s of STAGES) {
    res.stages[s.key] = mean(chgs.map((c) => c.stages[s.key])) ?? 0;
    res.shares[s.key] = total ? res.stages[s.key] / total : 0;
  }
  return res;
}

export function periodOf(model) {
  const times = [...model.deployments, ...model.commits, ...model.incidents, ...model.prs].map((e) => e.time).filter((t) => t != null);
  if (!times.length) return { from: 0, to: 0, weeks: 0 };
  const from = weekStart(Math.min(...times));
  const to = weekStart(Math.max(...times)) + WEEK;
  return { from, to, weeks: Math.round((to - from) / WEEK) };
}

// The four DORA metrics plus rework rate for one team (or all teams when team is falsy),
// optionally restricted to [from, to). Precomputed `ctx` avoids repeating work.
export function metrics(model, { team = null, from = -Infinity, to = Infinity, weeks = null, ctx = null } = {}) {
  ctx = ctx ?? context(model);
  const inRange = (t) => t >= from && t < to;
  const prod = model.deployments.filter((d) => isProd(d) && byTeam(team)(d) && inRange(d.time));
  const failed = prod.filter((d) => ctx.failures.has(d.id));
  const rework = prod.filter((d) => d.kind === "hotfix" || d.kind === "rollback");
  const chg = ctx.changes.filter((c) => byTeam(team)(c) && inRange(c.deployedAt));
  const leads = chg.map((c) => c.total);
  const inc = model.incidents.filter((i) => byTeam(team)(i) && inRange(i.time) && i.resolvedAt != null && i.resolvedAt >= i.time);
  const restore = inc.map((i) => i.resolvedAt - i.time);
  const nWeeks = weeks ?? (Number.isFinite(from) && Number.isFinite(to) ? (to - from) / WEEK : ctx.period.weeks);
  const perWeek = nWeeks > 0 ? prod.length / nWeeks : 0;
  const m = {
    deployments: prod.length,
    deploysPerWeek: perWeek,
    leadTime: { median: median(leads), p90: quantile(leads, 0.9), n: leads.length },
    cfr: { rate: prod.length ? failed.length / prod.length : null, failed: failed.length, total: prod.length },
    mttr: { median: median(restore), n: restore.length },
    rework: { rate: prod.length ? rework.length / prod.length : null, count: rework.length, total: prod.length },
    breakdown: breakdown(chg),
  };
  m.bands = {
    deployFreq: prod.length ? bandDeployFreq(perWeek) : null,
    leadTime: m.leadTime.median == null ? null : bandLeadTime(m.leadTime.median),
    cfr: m.cfr.rate == null ? null : bandCFR(m.cfr.rate),
    mttr: m.mttr.median == null ? null : bandMTTR(m.mttr.median),
  };
  return m;
}

export function context(model) {
  return { failures: attributeFailures(model), changes: changes(model), period: periodOf(model) };
}

// One metrics object per calendar week (Monday start, UTC). With windowWeeks > 1 each point
// covers that many trailing weeks, which smooths ratios built on a handful of deploys.
export function weekly(model, { team = null, ctx = null, windowWeeks = 1 } = {}) {
  ctx = ctx ?? context(model);
  const out = [];
  for (let w = ctx.period.from; w < ctx.period.to; w += WEEK) {
    const from = Math.max(ctx.period.from, w - (windowWeeks - 1) * WEEK);
    out.push({ week: w, ...metrics(model, { team, from, to: w + WEEK, ctx }) });
  }
  return out;
}

// ---------- DORA performance bands ----------
// Approximate cutoffs adapted from the DORA State of DevOps reports (2021 to 2023).
// The reports cluster survey answers, so the exact edges move from year to year.
// Treat these as a rough yardstick, not a certification.
//   Deployment frequency: elite >= 1 per day (7/week), high >= 1 per week,
//                         medium >= 1 per month (12/52 per week), low below that.
//   Lead time (median):   elite < 1 day, high < 1 week, medium < 30 days, low otherwise.
//   Change failure rate:  elite <= 5%, high <= 10%, medium <= 15%, low above 15%.
//   Time to restore:      elite < 1 hour, high < 1 day, medium < 1 week, low otherwise.
export const BANDS = ["elite", "high", "medium", "low"];
export const BAND_RULES = {
  deployFreq: "Elite: daily or more. High: weekly or more. Medium: monthly or more. Low: less than monthly.",
  leadTime: "Elite: under a day. High: under a week. Medium: under a month. Low: a month or more.",
  cfr: "Elite: 5% or less. High: 10% or less. Medium: 15% or less. Low: above 15%.",
  mttr: "Elite: under an hour. High: under a day. Medium: under a week. Low: a week or more.",
};
export function bandDeployFreq(perWeek) {
  if (perWeek >= 7) return "elite";
  if (perWeek >= 1) return "high";
  if (perWeek >= 12 / 52) return "medium";
  return "low";
}
export function bandLeadTime(ms) {
  if (ms < DAY) return "elite";
  if (ms < WEEK) return "high";
  if (ms < 30 * DAY) return "medium";
  return "low";
}
export function bandCFR(rate) {
  if (rate <= 0.05) return "elite";
  if (rate <= 0.1) return "high";
  if (rate <= 0.15) return "medium";
  return "low";
}
export function bandMTTR(ms) {
  if (ms < HOUR) return "elite";
  if (ms < DAY) return "high";
  if (ms < WEEK) return "medium";
  return "low";
}

// ---------- formatting ----------

export function fmtDuration(ms) {
  if (ms == null) return "n/a";
  const h = ms / HOUR;
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 48) return `${h < 10 ? h.toFixed(1) : Math.round(h)} h`;
  const d = h / 24;
  return `${d < 10 ? d.toFixed(1) : Math.round(d)} days`;
}
export const fmtPct = (r) => (r == null ? "n/a" : `${Math.round(r * 100)}%`);
export const fmtRate = (perWeek) => (perWeek >= 7 ? `${(perWeek / 7).toFixed(1)} per day` : perWeek >= 1 ? `${perWeek.toFixed(1)} per week` : `${(perWeek * 52 / 12).toFixed(1)} per month`);

// ---------- insights ----------
// Each insight is a plain sentence plus the numbers behind it. A rule only fires
// when its sample is large enough and the effect is big enough; otherwise it stays quiet.
export const INSIGHT_RULES = {
  minChanges: 10, // per team, for stage and trend findings
  stageShare: 0.5, // a stage must hold at least half of lead time to be called "mostly"
  batchCommits: 20, // deployments above this many commits count as big batches
  minDeploysPerGroup: 10,
  batchRatio: 1.5,
  trendChange: 0.3, // median lead time must move by 30% or more between halves
  minTeamDeploys: 20,
  cfrRatio: 2,
  cfrFloor: 0.15,
};

export function insights(model, rules = INSIGHT_RULES, ctx = context(model)) {
  const out = [];
  const teams = teamsOf(model);
  const label = (k) => STAGES.find((s) => s.key === k).label.toLowerCase();

  // 1. Where lead time goes, per team.
  for (const team of teams) {
    const chg = ctx.changes.filter((c) => c.team === team);
    if (chg.length < rules.minChanges) continue;
    const b = breakdown(chg);
    const [key, share] = Object.entries(b.shares).sort((x, y) => y[1] - x[1])[0];
    if (share >= rules.stageShare) {
      out.push({ kind: "stage", team, stage: key, share, n: chg.length, text: `${team}'s lead time is mostly ${label(key)} (${fmtPct(share)} of an average ${fmtDuration(b.total)} per change).` });
    }
  }

  // 2. Batch size and failure rate, across everything loaded.
  const prod = model.deployments.filter(isProd);
  const big = prod.filter((d) => d.commits.length > rules.batchCommits);
  const small = prod.filter((d) => d.commits.length <= rules.batchCommits);
  if (big.length >= rules.minDeploysPerGroup && small.length >= rules.minDeploysPerGroup) {
    const rb = big.filter((d) => ctx.failures.has(d.id)).length / big.length;
    const rs = small.filter((d) => ctx.failures.has(d.id)).length / small.length;
    const ratio = rs > 0 ? rb / rs : rb > 0 ? Infinity : 1;
    if (ratio >= rules.batchRatio) {
      const times = Number.isFinite(ratio) ? `${ratio.toFixed(1)} times as often as` : "while";
      out.push({ kind: "batch", ratio, big: big.length, small: small.length, rateBig: rb, rateSmall: rs,
        text: `Deployments with more than ${rules.batchCommits} commits fail ${times} smaller ones here (${fmtPct(rb)} of ${big.length} vs ${fmtPct(rs)} of ${small.length}).` });
    }
  }

  // 3. Lead time trend, first half of the period against the second half.
  const mid = (ctx.period.from + ctx.period.to) / 2;
  for (const team of teams) {
    const chg = ctx.changes.filter((c) => c.team === team);
    const a = chg.filter((c) => c.deployedAt < mid).map((c) => c.total);
    const b = chg.filter((c) => c.deployedAt >= mid).map((c) => c.total);
    if (a.length < rules.minChanges || b.length < rules.minChanges) continue;
    const ma = median(a), mb = median(b);
    if (ma <= 0) continue;
    const change = (mb - ma) / ma;
    if (Math.abs(change) >= rules.trendChange) {
      out.push({ kind: "trend", team, before: ma, after: mb, change,
        text: `${team}'s median lead time ${change < 0 ? "fell" : "rose"} from ${fmtDuration(ma)} in the first half of the period to ${fmtDuration(mb)} in the second half.` });
    }
  }

  // 4. A team whose change failure rate stands well above everyone else's.
  for (const team of teams) {
    const mine = prod.filter((d) => d.team === team);
    const rest = prod.filter((d) => d.team !== team);
    if (mine.length < rules.minTeamDeploys || rest.length < rules.minTeamDeploys) continue;
    const rm = mine.filter((d) => ctx.failures.has(d.id)).length / mine.length;
    const rr = rest.filter((d) => ctx.failures.has(d.id)).length / rest.length;
    if (rm >= rules.cfrFloor && rr > 0 && rm / rr >= rules.cfrRatio) {
      out.push({ kind: "cfr", team, rate: rm, rest: rr, ratio: rm / rr,
        text: `${team}'s change failure rate is ${fmtPct(rm)}, ${(rm / rr).toFixed(1)} times the rest of the org (${fmtPct(rr)}).` });
    }
  }
  return out;
}

// ---------- synthetic sample company ----------

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Four made-up teams at Quillmark, a fictional payments company. `p` goes from 0 at the
// start of the quarter to 1 at the end, which lets the Harbor team improve over time.
export const SAMPLE_TEAMS = [
  { team: "Atlas", service: "checkout-api", note: "Small PRs, deploys each merge", prsPerDay: 5, commits: [1, 3], coding: () => 3, reviewWait: () => 0.7, review: () => 0.5,
    deploy: { mode: "continuous", delay: 0.4 }, fail: () => 0.03, perCommit: 0, mttr: () => 0.6, staging: true },
  { team: "Ledger", service: "ledger-core", note: "Weekly release train, long review queue", prsPerDay: 3, commits: [1, 5], coding: () => 8, reviewWait: () => 40, review: () => 3,
    deploy: { mode: "scheduled", every: () => 7, hour: 14, offsetDays: 3 }, fail: () => 0.04, perCommit: 0.01, mttr: () => 20 },
  { team: "Beacon", service: "notify-svc", note: "Deploys every merge, many fail", prsPerDay: 4, commits: [1, 4], coding: () => 5, reviewWait: () => 3, review: () => 1,
    deploy: { mode: "continuous", delay: 1 }, fail: () => 0.26, perCommit: 0, mttr: () => 4 },
  { team: "Harbor", service: "harbor-web", note: "Moving from weekly to daily releases", prsPerDay: 3, commits: [1, 6], coding: () => 6, reviewWait: (p) => 24 - 21 * p, review: () => 2,
    deploy: { mode: "scheduled", every: (p) => Math.max(1, Math.round(7 - 6 * p)), hour: 13, offsetDays: 1 }, fail: (p) => 0.14 - 0.09 * p, perCommit: 0.004, mttr: (p) => 12 - 10 * p },
];

export const SAMPLE_START = Date.UTC(2026, 6, 6); // Monday 6 July 2026
export const SAMPLE_WEEKS = 13;

export function generateSample(seed = 42, { weeks = SAMPLE_WEEKS, start = SAMPLE_START } = {}) {
  const rnd = mulberry32(seed);
  const model = { commits: [], prs: [], deployments: [], incidents: [] };
  const end = start + weeks * WEEK;
  const hex = () => Math.floor(rnd() * 0xfffffff).toString(16).padStart(7, "0");
  const normal = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
  const logn = (medianHours, sigma = 0.7) => medianHours * Math.exp(sigma * normal()) * HOUR;
  const poisson = (lambda) => { let k = 0, p = 1; const L = Math.exp(-lambda); do { k++; p *= rnd(); } while (p > L); return k - 1; };
  const progress = (t) => Math.min(1, Math.max(0, (t - start) / (end - start)));
  let depSeq = 1000, incSeq = 1;
  const usedSha = new Set();
  const sha = () => { let s; do s = hex(); while (usedSha.has(s)); usedSha.add(s); return s; };

  for (const cfg of SAMPLE_TEAMS) {
    const { team, service } = cfg;
    let prSeq = 100;
    const merged = []; // { pr, commits: [sha], mergedAt }
    const makePR = (t0, nCommits, coding, wait, review) => {
      const id = `${service}#${prSeq++}`;
      const shas = [];
      for (let i = 0; i < nCommits; i++) {
        const c = { id: sha(), team, service, time: Math.round(t0 + (nCommits > 1 ? (coding * i) / (nCommits - 1) : 0)), pr: id };
        model.commits.push(c); shas.push(c.id);
      }
      const opened = Math.round(t0 + coding + 0.1 * HOUR);
      const reviewAt = Math.round(opened + wait), mergedAt = Math.round(reviewAt + review);
      model.prs.push({ id, team, service, time: opened, reviewAt, mergedAt });
      return { pr: id, commits: shas, mergedAt };
    };

    for (let day = 0; day < weeks * 7; day++) {
      if (day % 7 >= 5) continue; // weekdays only
      const dayStart = start + day * DAY;
      const n = poisson(cfg.prsPerDay);
      for (let k = 0; k < n; k++) {
        const t0 = dayStart + (8 + rnd() * 9) * HOUR;
        const p = progress(t0);
        const [lo, hi] = cfg.commits;
        const nCommits = lo + Math.floor(rnd() * (hi - lo + 1));
        merged.push(makePR(t0, nCommits, logn(cfg.coding(p)), logn(cfg.reviewWait(p)), logn(cfg.review(p))));
      }
    }
    merged.sort((a, b) => a.mergedAt - b.mergedAt);

    // Decide deployment times and which merged PRs each one carries.
    const batches = [];
    if (cfg.deploy.mode === "continuous") {
      for (const m of merged) batches.push({ time: Math.round(m.mergedAt + logn(cfg.deploy.delay, 0.5)), items: [m] });
    } else {
      let i = 0;
      for (let t = start + cfg.deploy.offsetDays * DAY + cfg.deploy.hour * HOUR; t < end; ) {
        const items = [];
        while (i < merged.length && merged[i].mergedAt < t) items.push(merged[i++]);
        if (items.length) batches.push({ time: t, items });
        t += cfg.deploy.every(progress(t)) * DAY;
        while (((new Date(t).getUTCDay() + 6) % 7) >= 5) t += DAY; // skip weekends
      }
    }

    for (const b of batches) {
      if (b.time >= end) continue;
      const commits = b.items.flatMap((m) => m.commits);
      const p = progress(b.time);
      const id = `d-${depSeq++}`;
      if (cfg.staging) model.deployments.push({ id: `d-${depSeq++}`, team, service, time: b.time - Math.round(0.3 * HOUR), env: "staging", status: "success", kind: "normal", commits, fixes: null });
      const dep = { id, team, service, time: b.time, env: "production", status: "success", kind: "normal", commits, fixes: null };
      model.deployments.push(dep);
      const pFail = Math.min(0.85, cfg.fail(p) + cfg.perCommit * commits.length);
      if (rnd() >= pFail) continue;
      const mode = rnd();
      if (mode < 0.5) {
        const startT = Math.round(b.time + rnd() * HOUR);
        model.incidents.push({ id: `inc-${incSeq++}`, team, service, time: startT, resolvedAt: Math.round(startT + logn(cfg.mttr(p), 0.8)), deployment: id });
      }
      if (mode >= 0.5 && mode < 0.75) {
        dep.status = "rolled_back";
      } else if (rnd() < 0.6 || mode >= 0.75) {
        // Hotfix: a one-commit PR shipped straight after the failure.
        const h = makePR(b.time + 0.5 * HOUR, 1, 0.3 * HOUR, 0.2 * HOUR, 0.2 * HOUR);
        const ht = h.mergedAt + Math.round(0.2 * HOUR);
        if (ht < end) model.deployments.push({ id: `d-${depSeq++}`, team, service, time: ht, env: "production", status: "success", kind: "hotfix", commits: h.commits, fixes: id });
      }
    }

    // A couple of incidents not caused by a deployment (a dependency outage, say).
    for (let k = 0; k < 2; k++) {
      const t = start + Math.floor(rnd() * weeks * 7) * DAY + 10 * HOUR;
      model.incidents.push({ id: `inc-${incSeq++}`, team, service, time: t, resolvedAt: Math.round(t + logn(cfg.mttr(progress(t)), 0.8)), deployment: null });
    }
  }
  // Whole seconds keep the CSV tidy and make it round-trip exactly.
  const sec = (t) => (t == null ? t : Math.round(t / 1000) * 1000);
  for (const list of Object.values(model)) for (const e of list) for (const k of ["time", "reviewAt", "mergedAt", "resolvedAt"]) if (k in e) e[k] = sec(e[k]);
  return model;
}

// ---------- URL state ----------

export function encodeState({ team, seed }) {
  const p = new URLSearchParams();
  if (team) p.set("team", team);
  if (seed != null) p.set("seed", String(seed));
  return p.toString();
}
export function decodeState(hash) {
  const p = new URLSearchParams(String(hash || "").replace(/^#/, ""));
  const seed = Number.parseInt(p.get("seed"), 10);
  return { team: p.get("team") || null, seed: Number.isFinite(seed) && seed >= 0 ? seed : 42 };
}
