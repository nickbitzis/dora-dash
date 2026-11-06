import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DAY, HOUR, WEEK, INSIGHT_RULES, attributeFailures, bandCFR, bandDeployFreq, bandLeadTime, bandMTTR, breakdown, changes,
  context, decodeState, encodeState, fmtDuration, generateSample, insights, median, metrics, modelToCSV, normalize,
  parseCSV, parseEvents, quantile, teamsOf, toCSV, weekStart, weekly,
} from "../src/dora.js";

const T0 = Date.UTC(2026, 0, 5); // a Monday
const at = (h) => new Date(T0 + h * HOUR).toISOString();
const empty = () => ({ commits: [], prs: [], deployments: [], incidents: [] });

// One PR with commits at hours 0 and 2, opened at 3, reviewed at 7, merged at 8, deployed at 10.
function onePR() {
  return normalize([
    { type: "commit", id: "a1", team: "T", time: at(0), pr: "1" },
    { type: "commit", id: "a2", team: "T", time: at(2), pr: "1" },
    { type: "pr", id: "1", team: "T", time: at(3), review_at: at(7), merged_at: at(8) },
    { type: "deployment", id: "d1", team: "T", time: at(9), env: "staging", commits: "a1;a2" },
    { type: "deployment", id: "d2", team: "T", time: at(10), env: "production", commits: "a1;a2" },
  ]).model;
}

// ---------- stats ----------

test("quantile interpolates between ranks and median handles even counts", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9.1);
  assert.equal(quantile([], 0.5), null);
});

test("weekStart returns Monday 00:00 UTC", () => {
  assert.equal(weekStart(T0 + 3 * DAY + 5 * HOUR), T0);
  assert.equal(weekStart(T0 + 6 * DAY + 23 * HOUR), T0); // Sunday night is still the same week
  assert.equal(weekStart(T0 + 7 * DAY), T0 + WEEK);
});

// ---------- CSV ----------

test("CSV parser handles quoted commas, escaped quotes, and newlines inside quotes", () => {
  const rows = parseCSV('type,id,service\r\ncommit,"a,1","say ""hi"""\ncommit,b2,"two\nlines"\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, "a,1");
  assert.equal(rows[0].service, 'say "hi"');
  assert.equal(rows[1].service, "two\nlines");
});

test("CSV parser ignores blank lines, BOM, and header case", () => {
  const rows = parseCSV("﻿Type,ID\n\ncommit,x\n\n");
  assert.deepEqual(rows, [{ type: "commit", id: "x" }]);
});

test("CSV parser rejects an unterminated quote", () => {
  assert.throws(() => parseCSV('a,b\n"open,1'), /quoted field/);
});

test("toCSV quotes fields that need it and round-trips through parseCSV", () => {
  const text = toCSV([{ a: 'x,"y"', b: "plain" }], ["a", "b"]);
  assert.equal(text, 'a,b\n"x,""y""",plain\n');
  assert.deepEqual(parseCSV(text), [{ a: 'x,"y"', b: "plain" }]);
});

test("parseEvents accepts JSON arrays and {events}, with commits as an array", () => {
  const rows = [{ type: "deployment", id: "d", team: "T", time: at(1), commits: ["a", "b"] }];
  const a = parseEvents(JSON.stringify(rows));
  const b = parseEvents(JSON.stringify({ events: rows }));
  assert.deepEqual(a.model.deployments[0].commits, ["a", "b"]);
  assert.deepEqual(b.model, a.model);
  assert.equal(a.model.deployments[0].env, "production"); // env defaults to production
});

test("parseEvents reports bad rows with line numbers instead of failing silently", () => {
  const { model, errors } = parseEvents(`type,id,time\ncommit,a,${at(0)}\nbogus,b,${at(1)}\ncommit,c,not-a-date\n`);
  assert.equal(model.commits.length, 1);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /Row 3: unknown type/);
  assert.match(errors[1], /Row 4/);
});

test("prod is normalized to production and staging deploys are ignored", () => {
  const { model } = normalize([{ type: "deploy", id: "x", time: at(0), env: "PROD" }, { type: "deployment", id: "y", time: at(1), env: "staging" }]);
  assert.equal(model.deployments[0].env, "production");
  assert.equal(metrics(model).deployments, 1);
});

// ---------- lead time and breakdown ----------

test("lead time runs from first commit to first production deploy", () => {
  const m = metrics(onePR());
  assert.equal(m.leadTime.n, 1);
  assert.equal(m.leadTime.median, 10 * HOUR); // staging at hour 9 does not count
});

test("lead time breakdown splits into coding, review wait, review, and merge to deploy", () => {
  const [c] = changes(onePR());
  assert.deepEqual(c.stages, { coding: 3 * HOUR, reviewWait: 4 * HOUR, review: 1 * HOUR, deploy: 2 * HOUR });
});

test("breakdown stages always sum to the total, even with out-of-order or missing PR times", () => {
  const { model } = normalize([
    { type: "commit", id: "c1", time: at(5), pr: "9" },
    { type: "pr", id: "9", time: at(2), review_at: "", merged_at: at(30) }, // opened before the commit, merged after deploy
    { type: "deployment", id: "d", time: at(20), commits: "c1" },
    { type: "commit", id: "c2", time: at(0) }, // no PR at all
    { type: "deployment", id: "e", time: at(4), commits: "c2" },
  ]);
  const chg = changes(model);
  assert.equal(chg.length, 2);
  for (const c of chg) {
    const sum = Object.values(c.stages).reduce((a, b) => a + b, 0);
    assert.equal(sum, c.total);
    for (const v of Object.values(c.stages)) assert.ok(v >= 0);
  }
  const b = breakdown(chg);
  assert.ok(Math.abs(Object.values(b.stages).reduce((a, x) => a + x, 0) - b.total) < 1e-6);
  assert.ok(Math.abs(Object.values(b.shares).reduce((a, x) => a + x, 0) - 1) < 1e-9);
});

test("breakdown sums to the mean lead time on the full sample company", () => {
  const model = generateSample(3);
  for (const team of teamsOf(model)) {
    const b = metrics(model, { team }).breakdown;
    const sum = Object.values(b.stages).reduce((a, x) => a + x, 0);
    assert.ok(Math.abs(sum - b.total) < 1, `${team}: ${sum} vs ${b.total}`);
  }
});

test("a change counts once, at the earliest production deploy carrying any of its commits", () => {
  const { model } = normalize([
    { type: "commit", id: "a", time: at(0), pr: "1" },
    { type: "commit", id: "b", time: at(1), pr: "1" },
    { type: "deployment", id: "d1", time: at(6), commits: "a" },
    { type: "deployment", id: "d2", time: at(12), commits: "a;b" },
  ]);
  const chg = changes(model);
  assert.equal(chg.length, 1);
  assert.equal(chg[0].total, 6 * HOUR);
  assert.equal(chg[0].deployment, "d1");
});

test("undeployed commits do not produce a lead time", () => {
  const { model } = normalize([{ type: "commit", id: "a", time: at(0), pr: "1" }]);
  assert.equal(metrics(model).leadTime.median, null);
});

test("median and p90 lead time on five hand-checked changes", () => {
  const rows = [];
  [1, 2, 3, 4, 50].forEach((h, k) => {
    rows.push({ type: "commit", id: `c${k}`, time: at(0) });
    rows.push({ type: "deployment", id: `d${k}`, time: at(h), commits: `c${k}` });
  });
  const m = metrics(normalize(rows).model);
  assert.equal(m.leadTime.median, 3 * HOUR);
  assert.ok(Math.abs(m.leadTime.p90 - (4 + 0.6 * 46) * HOUR) < 1e-3); // 90% sits 60% of the way from 4 to 50
});

// ---------- failures, CFR, MTTR, rework ----------

function failureSet() {
  return normalize([
    { type: "deployment", id: "ok", time: at(1) },
    { type: "deployment", id: "inc", time: at(2) },
    { type: "deployment", id: "rb", time: at(3), status: "rolled_back" },
    { type: "deployment", id: "hf-target", time: at(4) },
    { type: "deployment", id: "hf", time: at(5), kind: "hotfix", deployment: "hf-target" },
    { type: "deployment", id: "stage", time: at(6), env: "staging", status: "rolled_back" },
    { type: "incident", id: "i1", time: at(2.5), resolved_at: at(4.5), deployment: "inc" },
    { type: "incident", id: "i2", time: at(10), resolved_at: at(11) }, // not linked to a deploy
    { type: "incident", id: "i3", time: at(20), resolved_at: at(26), deployment: "stage" },
  ]).model;
}

test("failure attribution: incident, rollback, and hotfix each mark a deploy as failed", () => {
  const f = attributeFailures(failureSet());
  assert.deepEqual([...f.keys()].sort(), ["hf-target", "inc", "rb"]);
  assert.deepEqual(f.get("inc"), ["incident"]);
  assert.deepEqual(f.get("rb"), ["rollback"]);
  assert.deepEqual(f.get("hf-target"), ["hotfix"]);
  assert.ok(!f.has("stage")); // staging failures are not production failures
});

test("change failure rate is failed production deploys over all production deploys", () => {
  const m = metrics(failureSet());
  assert.equal(m.deployments, 5);
  assert.equal(m.cfr.failed, 3);
  assert.equal(m.cfr.rate, 3 / 5);
});

test("time to restore is the median incident duration, including unlinked incidents", () => {
  const m = metrics(failureSet());
  assert.equal(m.mttr.n, 3);
  assert.equal(m.mttr.median, 2 * HOUR); // durations 2h, 1h, 6h
});

test("rework rate counts hotfix and rollback deployments", () => {
  const m = metrics(failureSet());
  assert.equal(m.rework.count, 1);
  assert.equal(m.rework.rate, 1 / 5);
});

test("a deploy with several failure signals is counted once", () => {
  const { model } = normalize([
    { type: "deployment", id: "d", time: at(0), status: "rolled_back" },
    { type: "deployment", id: "h", time: at(1), kind: "hotfix", deployment: "d" },
    { type: "incident", id: "i", time: at(0.5), resolved_at: at(1), deployment: "d" },
  ]);
  const m = metrics(model);
  assert.equal(m.cfr.failed, 1);
  assert.deepEqual(attributeFailures(model).get("d").sort(), ["hotfix", "incident", "rollback"]);
});

test("team filter restricts every metric to that team", () => {
  const { model } = normalize([
    { type: "deployment", id: "a", team: "A", time: at(0) },
    { type: "deployment", id: "b", team: "B", time: at(1), status: "rolled_back" },
  ]);
  assert.equal(metrics(model, { team: "A" }).cfr.rate, 0);
  assert.equal(metrics(model, { team: "B" }).cfr.rate, 1);
  assert.equal(metrics(model).cfr.rate, 0.5);
});

test("deployment frequency is production deploys per week of the period", () => {
  const rows = [];
  for (let k = 0; k < 14; k++) rows.push({ type: "deployment", id: `d${k}`, time: at(k * 24) }); // 14 daily deploys over 2 weeks
  const m = metrics(normalize(rows).model);
  assert.equal(m.deploysPerWeek, 7);
  assert.equal(m.bands.deployFreq, "elite");
});

test("weekly trend buckets deploys into Monday-start weeks", () => {
  const { model } = normalize([
    { type: "deployment", id: "a", time: at(1) },
    { type: "deployment", id: "b", time: at(30) },
    { type: "deployment", id: "c", time: at(24 * 8), status: "failed" },
  ]);
  const w = weekly(model);
  assert.equal(w.length, 2);
  assert.deepEqual(w.map((x) => x.deployments), [2, 1]);
  assert.deepEqual(w.map((x) => x.cfr.rate), [0, 1]);
  assert.equal(w[1].week, T0 + WEEK);
});

// ---------- bands ----------

test("deployment frequency bands at their edges", () => {
  assert.equal(bandDeployFreq(7), "elite");
  assert.equal(bandDeployFreq(6.9), "high");
  assert.equal(bandDeployFreq(1), "high");
  assert.equal(bandDeployFreq(0.99), "medium");
  assert.equal(bandDeployFreq(12 / 52), "medium");
  assert.equal(bandDeployFreq(0.2), "low");
});

test("lead time bands at their edges", () => {
  assert.equal(bandLeadTime(DAY - 1), "elite");
  assert.equal(bandLeadTime(DAY), "high");
  assert.equal(bandLeadTime(WEEK), "medium");
  assert.equal(bandLeadTime(30 * DAY), "low");
});

test("change failure rate bands at their edges", () => {
  assert.equal(bandCFR(0.05), "elite");
  assert.equal(bandCFR(0.051), "high");
  assert.equal(bandCFR(0.1), "high");
  assert.equal(bandCFR(0.15), "medium");
  assert.equal(bandCFR(0.16), "low");
});

test("time to restore bands at their edges", () => {
  assert.equal(bandMTTR(59 * 60e3), "elite");
  assert.equal(bandMTTR(HOUR), "high");
  assert.equal(bandMTTR(DAY), "medium");
  assert.equal(bandMTTR(WEEK), "low");
});

test("bands are null when there is nothing to measure", () => {
  const m = metrics(empty());
  assert.deepEqual(m.bands, { deployFreq: null, leadTime: null, cfr: null, mttr: null });
});

// ---------- generator ----------

test("generator is reproducible from its seed and differs across seeds", () => {
  const a = modelToCSV(generateSample(7));
  assert.equal(a, modelToCSV(generateSample(7)));
  assert.notEqual(a, modelToCSV(generateSample(8)));
});

test("sample CSV round-trips through the parser with no errors and the same metrics", () => {
  const model = generateSample(42);
  const { model: back, errors } = parseEvents(modelToCSV(model));
  assert.deepEqual(errors, []);
  const m1 = metrics(model), m2 = metrics(back);
  assert.equal(m2.deployments, m1.deployments);
  assert.equal(m2.cfr.failed, m1.cfr.failed);
  assert.equal(m2.leadTime.median, m1.leadTime.median);
});

test("sample teams land where their story says", () => {
  const model = generateSample(42);
  const ctx = context(model);
  const by = Object.fromEntries(teamsOf(model).map((t) => [t, metrics(model, { team: t, ctx })]));
  assert.deepEqual(Object.keys(by), ["Atlas", "Beacon", "Harbor", "Ledger"]);
  assert.equal(by.Atlas.bands.leadTime, "elite");
  assert.equal(by.Atlas.bands.deployFreq, "elite");
  assert.ok(by.Beacon.cfr.rate > 2 * by.Atlas.cfr.rate);
  assert.ok(by.Ledger.leadTime.median > 4 * by.Atlas.leadTime.median);
  const big = model.deployments.filter((d) => d.team === "Ledger" && d.env === "production" && d.kind === "normal");
  assert.ok(median(big.map((d) => d.commits.length)) > 20);
});

// ---------- insights ----------

// Build n changes for a team where each stage takes the given hours.
function teamChanges(team, n, [code, wait, rev, dep], startHour = 0, prefix = team) {
  const rows = [];
  for (let k = 0; k < n; k++) {
    const t = startHour + k * 24;
    rows.push({ type: "commit", id: `${prefix}c${k}`, team, time: at(t), pr: `${prefix}${k}` });
    rows.push({ type: "pr", id: `${prefix}${k}`, team, time: at(t + code), review_at: at(t + code + wait), merged_at: at(t + code + wait + rev) });
    rows.push({ type: "deployment", id: `${prefix}d${k}`, team, time: at(t + code + wait + rev + dep), commits: `${prefix}c${k}` });
  }
  return rows;
}

test("stage insight fires when one stage holds most of lead time", () => {
  const model = normalize(teamChanges("Ledger", 12, [1, 6, 1, 2])).model;
  const found = insights(model).filter((i) => i.kind === "stage");
  assert.equal(found.length, 1);
  assert.equal(found[0].stage, "reviewWait");
  assert.equal(found[0].share, 0.6);
  assert.match(found[0].text, /Ledger's lead time is mostly review wait \(60%/);
});

test("stage insight stays quiet for an even split or too few changes", () => {
  assert.equal(insights(normalize(teamChanges("A", 12, [1, 1, 1, 1])).model).length, 0);
  assert.equal(insights(normalize(teamChanges("A", 5, [1, 9, 1, 1])).model).filter((i) => i.kind === "stage").length, 0);
});

test("batch insight fires only when big batches fail clearly more often", () => {
  const rows = [];
  const sha = (k, n) => Array.from({ length: n }, (_, j) => `s${k}_${j}`).join(";");
  for (let k = 0; k < 10; k++) rows.push({ type: "deployment", id: `big${k}`, time: at(k), commits: sha(`b${k}`, 25), status: k < 5 ? "rolled_back" : "success" });
  for (let k = 0; k < 20; k++) rows.push({ type: "deployment", id: `small${k}`, time: at(k), commits: sha(`s${k}`, 3), status: k < 2 ? "rolled_back" : "success" });
  const yes = insights(normalize(rows).model).find((i) => i.kind === "batch");
  assert.ok(yes);
  assert.equal(yes.ratio, 5); // 50% vs 10%
  assert.match(yes.text, /more than 20 commits fail 5\.0 times as often/);

  // Same sizes, same failure rate: no claim.
  const flat = rows.map((r) => ({ ...r, status: ["big0", "small0", "small1"].includes(r.id) ? "rolled_back" : "success" }));
  assert.equal(insights(normalize(flat).model).find((i) => i.kind === "batch"), undefined);

  // Too few big deploys to say anything.
  const few = rows.filter((r) => !/big[2-9]/.test(r.id));
  assert.equal(insights(normalize(few).model).find((i) => i.kind === "batch"), undefined);
});

test("trend insight compares the two halves of the period", () => {
  // 12 slow changes early (lead time 40h), 12 fast ones late (10h): a 75% drop.
  const rows = [...teamChanges("Harbor", 12, [10, 10, 10, 10], 0, "early"), ...teamChanges("Harbor", 12, [2.5, 2.5, 2.5, 2.5], 24 * 14, "late")];
  const t = insights(normalize(rows).model).find((i) => i.kind === "trend");
  assert.ok(t);
  assert.equal(t.before, 40 * HOUR);
  assert.equal(t.after, 10 * HOUR);
  assert.match(t.text, /fell from 40 h .* to 10 h/);
  // Flat performance: no trend claim.
  const flat = [...teamChanges("Harbor", 12, [10, 10, 10, 10], 0, "early"), ...teamChanges("Harbor", 12, [10, 10, 10, 10], 24 * 14, "late")];
  assert.equal(insights(normalize(flat).model).find((i) => i.kind === "trend"), undefined);
});

test("failure-rate outlier insight needs enough deploys and a large gap", () => {
  const rows = [];
  for (let k = 0; k < 20; k++) rows.push({ type: "deployment", id: `b${k}`, team: "Beacon", time: at(k), status: k < 6 ? "rolled_back" : "success" });
  for (let k = 0; k < 40; k++) rows.push({ type: "deployment", id: `a${k}`, team: "Atlas", time: at(k), status: k < 2 ? "rolled_back" : "success" });
  const found = insights(normalize(rows).model).filter((i) => i.kind === "cfr");
  assert.equal(found.length, 1);
  assert.equal(found[0].team, "Beacon");
  assert.equal(found[0].rate, 0.3);
  // Below the minimum sample, nothing fires.
  const small = rows.filter((r) => !/^b(1[0-9])$/.test(r.id));
  assert.equal(insights(normalize(small).model, INSIGHT_RULES).filter((i) => i.kind === "cfr").length, 0);
});

test("sample company produces only insights backed by its own numbers", () => {
  const model = generateSample(42);
  const ctx = context(model);
  for (const i of insights(model, INSIGHT_RULES, ctx)) {
    if (i.kind === "stage") assert.ok(metrics(model, { team: i.team, ctx }).breakdown.shares[i.stage] >= 0.5);
    if (i.kind === "cfr") assert.ok(i.rate >= 2 * i.rest);
    if (i.kind === "batch") assert.ok(i.rateBig >= 1.5 * i.rateSmall);
  }
  assert.ok(insights(model, INSIGHT_RULES, ctx).some((i) => i.kind === "trend" && i.team === "Harbor" && i.change < 0));
});

// ---------- formatting and URL state ----------

test("durations format in minutes, hours, or days", () => {
  assert.equal(fmtDuration(30 * 60e3), "30 min");
  assert.equal(fmtDuration(5.25 * HOUR), "5.3 h");
  assert.equal(fmtDuration(3 * DAY), "3.0 days");
  assert.equal(fmtDuration(null), "n/a");
});

test("URL state round-trips and falls back to defaults", () => {
  assert.deepEqual(decodeState("#" + encodeState({ team: "Ledger", seed: 9 })), { team: "Ledger", seed: 9 });
  assert.deepEqual(decodeState(""), { team: null, seed: 42 });
  assert.deepEqual(decodeState("#seed=-4"), { team: null, seed: 42 });
});
