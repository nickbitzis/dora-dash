import {
  BAND_RULES, DAY, HOUR, STAGES, context, decodeState, encodeState, fmtDuration, fmtPct, fmtRate, generateSample,
  insights, metrics, modelToCSV, parseEvents, teamsOf, weekly,
} from "./dora.js";

const $ = (id) => document.getElementById(id);
const SVG_NS = "http://www.w3.org/2000/svg";

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") node.textContent = v;
    else if (v != null) node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}
function svg(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

// ---------- state ----------

const initial = decodeState(location.hash);
const state = { seed: initial.seed, team: initial.team, custom: null, model: null, ctx: null, teams: [] };

function load(model, custom) {
  state.model = model;
  state.custom = custom;
  state.ctx = context(model);
  state.teams = teamsOf(model);
  if (state.team && !state.teams.includes(state.team)) state.team = null;
  render();
}
function loadSample() {
  load(generateSample(state.seed), null);
  $("errors").replaceChildren();
}

// Team color follows the team (by sorted name), never its rank, so filters never repaint.
const teamColor = (team) => {
  const k = state.teams.indexOf(team);
  return k >= 0 && k < 8 ? `var(--t${k + 1})` : "var(--muted)";
};
const swatch = (color) => el("i", { class: "swatch", style: `background:${color}` });
const band = (b, title) => el("span", { class: `band ${b ?? "none"}`, text: b ?? "no data", title });

// ---------- tooltip ----------

const tip = $("tooltip");
function showTip(evt, children) {
  tip.replaceChildren(...children);
  tip.hidden = false;
  const pad = 14;
  let x = evt.clientX + pad, y = evt.clientY + pad;
  if (x + tip.offsetWidth > window.innerWidth - 8) x = evt.clientX - tip.offsetWidth - pad;
  if (y + tip.offsetHeight > window.innerHeight - 8) y = evt.clientY - tip.offsetHeight - pad;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${Math.max(8, y)}px`;
}
const hideTip = () => { tip.hidden = true; };
const tipRow = (color, name, value) => el("div", { class: "tip-row" }, [swatch(color), el("span", { text: name }), el("b", { text: value })]);

// ---------- render ----------

function render() {
  const { model, ctx, team } = state;
  const p = ctx.period;
  const nDeploys = model.deployments.filter((d) => d.env === "production").length;
  $("source-title").textContent = state.custom ? `Your data: ${state.custom}` : "Sample company: Quillmark (made up)";
  $("source-sub").textContent = `${state.teams.length} teams, ${p.weeks} weeks, ${model.commits.length.toLocaleString()} commits, ${nDeploys.toLocaleString()} production deployments, ${model.incidents.length} incidents`
    + (state.custom ? "" : ". Atlas is elite, Ledger ships big weekly batches, Beacon fails often, Harbor improves over the quarter.");
  $("seed").value = state.seed;
  $("download").textContent = state.custom ? "Download as CSV" : "Download sample CSV";

  renderTeams();
  renderKpis(metrics(model, { team, ctx }));
  renderInsights();
  renderMultiples();
  renderBreakdown();
  renderTable();
  history.replaceState(null, "", `#${encodeState({ team, seed: state.custom ? null : state.seed })}`);
}

function renderTeams() {
  const opts = [null, ...state.teams];
  $("teams").replaceChildren(...opts.map((t) => {
    const b = el("button", { type: "button", class: "tab", role: "tab", "aria-selected": String(t === state.team) }, t ? [swatch(teamColor(t)), t] : ["All teams"]);
    b.addEventListener("click", () => { state.team = t; render(); });
    return b;
  }));
}

function renderKpis(m) {
  const tile = (label, value, sub, b, rule) => el("div", { class: "kpi" }, [
    el("span", { class: "kpi-label", text: label }), el("span", { class: "kpi-value", text: value }), el("span", { class: "kpi-sub", text: sub }),
    ...(b !== undefined ? [band(b, rule)] : []),
  ]);
  $("kpis").replaceChildren(
    tile("Deployment frequency", m.deployments ? fmtRate(m.deploysPerWeek) : "none", `${m.deployments} production deploys`, m.bands.deployFreq, BAND_RULES.deployFreq),
    tile("Lead time for changes", fmtDuration(m.leadTime.median), `median, p90 ${fmtDuration(m.leadTime.p90)}, ${m.leadTime.n} changes`, m.bands.leadTime, BAND_RULES.leadTime),
    tile("Change failure rate", fmtPct(m.cfr.rate), `${m.cfr.failed} of ${m.cfr.total} deploys caused a failure`, m.bands.cfr, BAND_RULES.cfr),
    tile("Time to restore", fmtDuration(m.mttr.median), `median of ${m.mttr.n} incidents`, m.bands.mttr, BAND_RULES.mttr),
    tile("Rework rate", fmtPct(m.rework.rate), `${m.rework.count} hotfix or rollback deploy${m.rework.count === 1 ? "" : "s"}`),
  );
}

function renderInsights() {
  const all = insights(state.model, undefined, state.ctx);
  const shown = state.team ? all.filter((i) => !i.team || i.team === state.team) : all;
  $("insights").replaceChildren(...(shown.length
    ? shown.map((i) => el("li", { text: i.text }))
    : [el("li", { class: "empty", text: "No finding clears the evidence bar for this selection. Rules need at least 10 changes per team, or 10 deploys per batch-size group." })]));
}

// ---------- small multiples ----------

const SERIES = [
  { title: "Deploys per week", get: (w) => w.deployments, fmt: (v) => String(Math.round(v)), kind: "count" },
  { title: "Median lead time", get: (w) => w.leadTime.median, fmt: fmtDuration, kind: "time" },
  { title: "Change failure rate", sub: "4-week trailing", window: 4, get: (w) => (w.cfr.total ? w.cfr.rate : null), fmt: fmtPct, kind: "pct" },
  { title: "Restore time", sub: "4-week median", window: 4, get: (w) => w.mttr.median, fmt: fmtDuration, kind: "time" },
  { title: "Rework rate", sub: "4-week trailing", window: 4, get: (w) => (w.rework.total ? w.rework.rate : null), fmt: fmtPct, kind: "pct" },
];

function niceStep(max, n = 4) {
  const raw = max / n;
  const pow = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((s) => s * pow).find((s) => s >= raw);
}
function axisFor(kind, max) {
  if (kind === "pct") {
    const top = Math.min(1, Math.max(0.1, Math.ceil(max * 10) / 10));
    const step = top <= 0.2 ? 0.05 : top <= 0.5 ? 0.1 : 0.25;
    return { top: Math.ceil(top / step) * step, step, label: (v) => `${Math.round(v * 100)}%` };
  }
  if (kind === "time") {
    const unit = max >= 2 * DAY ? DAY : HOUR;
    const step = niceStep(Math.max(max, unit) / unit) * unit;
    return { top: Math.ceil(Math.max(max, unit) / step) * step, step, label: (v) => (unit === DAY ? `${+(v / DAY).toFixed(1)}d` : `${+(v / HOUR).toFixed(1)}h`) };
  }
  const step = niceStep(Math.max(max, 4));
  return { top: Math.ceil(Math.max(max, 4) / step) * step, step, label: (v) => String(+v.toFixed(1)) };
}

function renderMultiples() {
  const byWindow = (n) => new Map(state.teams.map((t) => [t, weekly(state.model, { team: t, ctx: state.ctx, windowWeeks: n })]));
  const w1 = byWindow(1), w4 = byWindow(4);
  const weeks = w1.get(state.teams[0]) ?? [];
  $("team-legend").replaceChildren(...state.teams.map((t) => el("li", { class: state.team && state.team !== t ? "off" : "" }, [swatch(teamColor(t)), t])));
  $("multiples").replaceChildren(...SERIES.map((s) => smallMultiple(s, s.window === 4 ? w4 : w1, weeks)));
}

function smallMultiple(series, weeksByTeam, weeks) {
  const W = 260, H = 170, m = { l: 38, r: 8, t: 8, b: 22 };
  const n = weeks.length;
  const values = new Map([...weeksByTeam].map(([t, ws]) => [t, ws.map(series.get)]));
  const max = Math.max(0, ...[...values.values()].flat().filter((v) => v != null));
  const ax = axisFor(series.kind, max);
  const x = (k) => m.l + (n > 1 ? (k / (n - 1)) * (W - m.l - m.r) : (W - m.l - m.r) / 2);
  const y = (v) => H - m.b - (v / ax.top) * (H - m.t - m.b);
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${series.title} by week and team` });
  for (let v = 0; v <= ax.top + 1e-9; v += ax.step) {
    root.append(svg("line", { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: v === 0 ? "axis" : "grid" }));
    root.append(svg("text", { x: m.l - 5, y: y(v) + 3.5, class: "tick", "text-anchor": "end" }, ax.label(v)));
  }
  const fmtWeek = (t) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  for (const k of [0, Math.floor((n - 1) / 2), n - 1]) {
    if (k < 0 || !weeks[k]) continue;
    root.append(svg("text", { x: x(k), y: H - 6, class: "tick", "text-anchor": k === 0 ? "start" : k === n - 1 ? "end" : "middle" }, fmtWeek(weeks[k].week)));
  }
  // Draw unselected teams first (dimmed when a team is selected) so the selected line sits on top.
  const order = [...state.teams].sort((a, b) => (a === state.team) - (b === state.team));
  for (const t of order) {
    const vals = values.get(t);
    let d = "", pen = false;
    vals.forEach((v, k) => {
      if (v == null) { pen = false; return; }
      d += `${pen ? "L" : "M"}${x(k).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    const dim = state.team && state.team !== t;
    root.append(svg("path", { d, class: `line${dim ? " dim" : ""}`, ...(dim ? {} : { style: `stroke:${teamColor(t)}` }) }));
    // A lone point between gaps has no segment, so mark it.
    vals.forEach((v, k) => {
      if (v != null && vals[k - 1] == null && vals[k + 1] == null) root.append(svg("circle", { cx: x(k), cy: y(v), r: 2.5, style: `fill:${dim ? "var(--dim)" : teamColor(t)}` }));
    });
  }
  const hover = svg("g", { visibility: "hidden" });
  const hl = svg("line", { y1: m.t, y2: H - m.b, class: "crosshair" });
  hover.append(hl);
  const dots = new Map(state.teams.map((t) => { const c = svg("circle", { r: 4, class: "hdot", style: `fill:${teamColor(t)}` }); hover.append(c); return [t, c]; }));
  const hit = svg("rect", { x: m.l - 6, y: 0, width: W - m.l - m.r + 12, height: H, fill: "transparent" });
  root.append(hover, hit);
  hit.addEventListener("pointermove", (evt) => {
    const box = root.getBoundingClientRect();
    const px = ((evt.clientX - box.left) / box.width) * W;
    const k = Math.min(n - 1, Math.max(0, Math.round(((px - m.l) / (W - m.l - m.r)) * (n - 1))));
    hover.setAttribute("visibility", "visible");
    hl.setAttribute("x1", x(k)); hl.setAttribute("x2", x(k));
    const shownTeams = state.team ? [state.team] : state.teams;
    for (const [t, c] of dots) {
      const v = values.get(t)[k];
      const on = v != null && shownTeams.includes(t);
      c.setAttribute("visibility", on ? "visible" : "hidden");
      if (on) { c.setAttribute("cx", x(k)); c.setAttribute("cy", y(v)); }
    }
    const rows = shownTeams.map((t) => [t, values.get(t)[k]]).sort((a, b) => (b[1] ?? -1) - (a[1] ?? -1));
    showTip(evt, [el("strong", { text: `${series.title}, week of ${fmtWeek(weeks[k].week)}` }), ...(series.sub ? [el("div", { class: "muted", text: series.sub })] : []), ...rows.map(([t, v]) => tipRow(teamColor(t), t, v == null ? "no data" : series.fmt(v)))]);
  });
  hit.addEventListener("pointerleave", () => { hover.setAttribute("visibility", "hidden"); hideTip(); });
  return el("div", { class: "multiple" }, [el("h3", {}, [series.title, ...(series.sub ? [el("span", { class: "muted", text: `, ${series.sub}` })] : [])]), root]);
}

// ---------- lead-time breakdown ----------

function renderBreakdown() {
  $("stage-legend").replaceChildren(...STAGES.map((s, k) => el("li", { title: s.desc }, [swatch(`var(--st${k + 1})`), s.label])));
  const rows = state.teams.map((t) => ({ team: t, b: metrics(state.model, { team: t, ctx: state.ctx }).breakdown }));
  const W = 440, rowH = 32, m = { l: 62, r: 62, t: 6, b: 24 };
  const H = m.t + rows.length * rowH + m.b;
  const chart = $("breakdown");
  chart.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const max = Math.max(HOUR, ...rows.map((r) => r.b.total));
  const unit = max >= 2 * DAY ? DAY : HOUR;
  const step = niceStep(max / unit) * unit;
  const top = Math.ceil(max / step) * step;
  const x = (v) => m.l + (v / top) * (W - m.l - m.r);
  const nodes = [];
  for (let v = 0; v <= top + 1e-9; v += step) {
    nodes.push(svg("line", { x1: x(v), x2: x(v), y1: m.t, y2: H - m.b, class: v === 0 ? "axis" : "grid" }));
    nodes.push(svg("text", { x: x(v), y: H - 8, class: "tick", "text-anchor": "middle" }, unit === DAY ? `${+(v / DAY).toFixed(1)}d` : `${+(v / HOUR).toFixed(1)}h`));
  }
  rows.forEach(({ team, b }, i) => {
    const yTop = m.t + i * rowH;
    if (team === state.team) nodes.push(svg("rect", { x: 0, y: yTop + 2, width: W, height: rowH - 4, rx: 6, class: "row-hl" }));
    const yb = yTop + 8, bh = rowH - 16;
    nodes.push(svg("text", { x: 0, y: yb + bh / 2 + 4, class: "bar-label" }, team));
    let acc = 0;
    const segs = STAGES.map((s, k) => ({ s, k, v: b.stages[s.key] })).filter((g) => g.v > 0);
    segs.forEach(({ s, k, v }, j) => {
      const last = j === segs.length - 1;
      const x0 = x(acc), w = Math.max(0, x(acc + v) - x0);
      acc += v;
      const r = svg(last ? "path" : "rect", last
        ? { d: roundedRight(x0, yb, w, bh, Math.min(4, w)), class: "seg", style: `fill:var(--st${k + 1})` }
        : { x: x0, y: yb, width: w, height: bh, class: "seg", style: `fill:var(--st${k + 1})` });
      r.addEventListener("pointermove", (evt) => showTip(evt, [
        el("strong", { text: `${team}: ${s.label}` }), el("div", { class: "muted", text: s.desc }),
        tipRow(`var(--st${k + 1})`, "Average per change", fmtDuration(v)), tipRow("transparent", "Share of lead time", fmtPct(b.shares[s.key])),
        tipRow("transparent", "Changes measured", String(b.n)),
      ]));
      r.addEventListener("pointerleave", hideTip);
      nodes.push(r);
    });
    nodes.push(svg("text", { x: x(b.total) + 6, y: yb + bh / 2 + 4, class: "bar-total" }, b.n ? fmtDuration(b.total) : "no changes"));
  });
  chart.replaceChildren(...nodes);
}

// A bar with square left edge (anchored at the baseline side) and rounded right end.
function roundedRight(x, y, w, h, r) {
  return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
}

// ---------- comparison table ----------

function renderTable() {
  const row = (label, t) => {
    const m = metrics(state.model, { team: t, ctx: state.ctx });
    const cell = (text, b, rule) => el("td", { class: "num" }, [text, ...(b !== undefined ? [band(b, rule)] : [])]);
    const tr = el("tr", { class: `clickable${t === state.team ? " current" : ""}` }, [
      el("td", {}, [el("span", { class: "team-cell" }, [...(t ? [swatch(teamColor(t))] : []), label])]),
      cell(m.deployments ? fmtRate(m.deploysPerWeek) : "none", m.bands.deployFreq, BAND_RULES.deployFreq),
      cell(`${fmtDuration(m.leadTime.median)} / ${fmtDuration(m.leadTime.p90)}`, m.bands.leadTime, BAND_RULES.leadTime),
      cell(fmtPct(m.cfr.rate), m.bands.cfr, BAND_RULES.cfr),
      cell(fmtDuration(m.mttr.median), m.bands.mttr, BAND_RULES.mttr),
      cell(fmtPct(m.rework.rate)),
    ]);
    tr.addEventListener("click", () => { state.team = t; render(); });
    return tr;
  };
  $("rows").replaceChildren(...state.teams.map((t) => row(t, t)), row("All teams", null));
}

// ---------- data source controls ----------

function loadText(text, name) {
  const { model, errors } = parseEvents(text);
  const shown = errors.slice(0, 5).map((e) => el("li", { text: e }));
  if (errors.length > 5) shown.push(el("li", { text: `${errors.length - 5} more problems not shown.` }));
  if (!model || !model.deployments.length) {
    $("errors").replaceChildren(...shown, el("li", { text: "No production deployments found, so nothing was loaded." }));
    return;
  }
  $("errors").replaceChildren(...shown);
  load(model, name);
}

$("file").addEventListener("change", async (evt) => {
  const f = evt.target.files[0];
  if (f) loadText(await f.text(), f.name);
  evt.target.value = "";
});
$("paste-toggle").addEventListener("click", () => {
  const box = $("paste-box");
  box.hidden = !box.hidden;
  $("paste-toggle").setAttribute("aria-expanded", String(!box.hidden));
});
$("paste-load").addEventListener("click", () => loadText($("paste").value, "pasted data"));
$("seed").addEventListener("change", () => {
  const v = Number.parseInt($("seed").value, 10);
  if (Number.isFinite(v) && v >= 0) { state.seed = v; loadSample(); }
});
$("reroll").addEventListener("click", () => { state.seed = Math.floor(Math.random() * 100000); loadSample(); });
$("download").addEventListener("click", () => {
  const blob = new Blob([modelToCSV(state.model)], { type: "text/csv" });
  const a = el("a", { href: URL.createObjectURL(blob), download: state.custom ? "dora-events.csv" : `quillmark-sample-seed${state.seed}.csv` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$("share").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(location.href); $("share").textContent = "Link copied"; }
  catch { $("share").textContent = "Copy the address bar"; }
  setTimeout(() => { $("share").textContent = "Copy share link"; }, 1600);
});
window.addEventListener("hashchange", () => {
  const s = decodeState(location.hash);
  const reseed = !state.custom && s.seed !== state.seed;
  state.team = s.team;
  if (reseed) { state.seed = s.seed; loadSample(); } else render();
});

loadSample();
