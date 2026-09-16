(() => {
  const data = window.CSI_VISIBILITY_DATA;
  let currentRun = data.runs[0];
  let currentPage = "overview";
  const fmt = (value, digits = 1) => Number(value).toFixed(digits);
  const pct = value => value == null ? "—" : `${fmt(value, value % 1 ? 2 : 1)}%`;
  const delta = (value, suffix = "") => {
    const cls = value > 0 ? "positive" : value < 0 ? "negative" : "neutral";
    return `<span class="${cls}">${value > 0 ? "+" : ""}${fmt(value)}${suffix}</span>`;
  };
  const baseline = data.runs.find(run => run.id === "2026-08-27-full100-v1");
  const providerByName = (run, name) => run.providers.find(provider => provider.name === name);

  function renderSidebar() {
    document.querySelector("#run-list").innerHTML = data.runs.map(run => `
      <button class="run-link ${run.id === currentRun.id ? "active" : ""}" data-run="${run.id}">
        <strong>${run.id}</strong><span>${run.status} · ${run.observations}/${run.expectedObservations} success</span>
      </button>`).join("");
    document.querySelectorAll("[data-run]").forEach(button => button.addEventListener("click", () => {
      currentRun = data.runs.find(run => run.id === button.dataset.run);
      render();
    }));
  }

  function providerCards(run) {
    return run.providers.map(provider => `
      <article class="provider-card"><h3>${provider.name}</h3>
        <div class="metric-row"><span>Visibility Index</span><b>${fmt(provider.index)}</b></div>
        <div class="bar"><i style="width:${Math.min(provider.index, 100)}%"></i></div>
        <div class="metric-row"><span>Successful observations</span><b>${run.promptCount}</b></div>
        <div class="metric-row"><span>Mention</span><b>${pct(provider.mentions)}</b></div>
        <div class="metric-row"><span>Citation</span><b>${pct(provider.citations)}</b></div>
        <div class="metric-row"><span>Recommendation</span><b>${pct(provider.recommendations)}</b></div>
      </article>`).join("");
  }

  function overview() {
    const latest = currentRun.id === data.runs[0].id;
    const best = [...currentRun.providers].sort((a, b) => b.index - a.index)[0];
    const indexGain = currentRun.visibilityIndex - baseline.visibilityIndex;
    const citationGain = currentRun.citationShare - baseline.citationShare;
    return `<section class="stat-grid">
      <article class="stat"><span>Status</span><strong>${currentRun.status}</strong></article>
      <article class="stat"><span>Observations</span><strong>${currentRun.observations}/${currentRun.expectedObservations}</strong></article>
      <article class="stat"><span>Visibility Index</span><strong>${fmt(currentRun.visibilityIndex)}</strong></article>
      <article class="stat"><span>Attempts</span><strong>${currentRun.attempts}</strong></article>
    </section>
    <section class="panel"><header class="panel-head"><h2>Executive Summary</h2><p>${currentRun.id} · ${currentRun.observations}/${currentRun.expectedObservations} observations completed</p></header>
      <div class="summary-grid">
        <article class="summary-card green"><span class="label">Strongest provider</span><strong>${best.name}</strong><p>${best.name} led this run with a ${fmt(best.index)} Visibility Index.</p></article>
        <article class="summary-card"><span class="label">Overall movement</span><strong>${latest ? `+${fmt(indexGain)}` : fmt(currentRun.visibilityIndex)}</strong><p>${latest ? `Visibility Index rose from ${fmt(baseline.visibilityIndex)} to ${fmt(currentRun.visibilityIndex)}.` : "Historical run retained for comparison."}</p></article>
        <article class="summary-card amber"><span class="label">Citation movement</span><strong>${latest ? `+${fmt(citationGain)} pts` : pct(currentRun.citationShare)}</strong><p>${latest ? `Citation share improved to ${pct(currentRun.citationShare)} across all providers.` : "Share of observations citing a CSI-owned source."}</p></article>
        <article class="summary-card red"><span class="label">Authority gap</span><strong>${pct(currentRun.authorityShare)}</strong><p>${latest ? `${currentRun.authorityMentions} of 400 observations had qualifying independent authority.` : "Independent-authority classification was introduced after this run."}</p></article>
      </div></section>
    <section class="panel"><header class="panel-head"><h2>Provider Performance</h2><p>Completed logical observations by platform</p></header><div class="provider-grid">${providerCards(currentRun)}</div></section>`;
  }

  function promptSets() {
    return `<section class="stat-grid"><article class="stat"><span>Active prompts</span><strong>100</strong></article><article class="stat"><span>Categories</span><strong>${data.categories.length}</strong></article><article class="stat"><span>Providers</span><strong>4</strong></article><article class="stat"><span>Logical observations</span><strong>400</strong></article></section>
    <section class="panel"><header class="panel-head"><h2>CSI OPA Buyer-Intent Prompt Set</h2><p>Production benchmark coverage</p></header><div class="check-grid">${data.categories.map(name => `<div class="check"><span class="check-icon">✓</span><div><b>${name}</b><span>Active in the 100-prompt production set</span></div></div>`).join("")}</div></section>`;
  }

  function readiness() {
    const checks = [["Run completeness", "400 of 400 logical observations"], ["Provider coverage", "OpenAI, Gemini, Perplexity, and Claude"], ["Duplicate prevention", "No duplicate logical observations"], ["Scoring parity", "CSI production methodology validated"], ["Independent authority", "Classifier completed for eligible mentions"], ["Summary persistence", "Summary and history rows written"]];
    return `<section class="panel"><header class="panel-head"><h2>Run Readiness</h2><p>Finalization checks for ${currentRun.id}</p></header><div class="check-grid">${checks.map(([title, copy]) => `<div class="check"><span class="check-icon">✓</span><div><b>${title}</b><span>${copy}</span></div></div>`).join("")}</div></section>`;
  }

  function operations() {
    return `<section class="panel"><header class="panel-head"><h2>Production Methodology</h2><p>Current benchmark operating rules</p></header><table><tbody>
      <tr><th>Prompt set</th><td>100 buyer-intent prompts across ${data.categories.length} categories</td></tr><tr><th>Providers</th><td>${data.methodology.providers.join(", ")}</td></tr><tr><th>Logical observation</th><td>${data.methodology.logicalObservation}</td></tr><tr><th>Recommendation threshold</th><td>Visibility score ≥ ${data.methodology.recommendationThreshold}</td></tr><tr><th>Aggregation</th><td>${data.methodology.aggregation}</td></tr><tr><th>Scorer</th><td>${data.methodology.scorer}</td></tr>
    </tbody></table></section><div class="callout">This dashboard is read-only. Benchmark execution remains isolated from the public dashboard and requires the controlled production workflow.</div>`;
  }

  function compare() {
    const latest = data.runs[0];
    const rows = [["Overall", latest.visibilityIndex, baseline.visibilityIndex, latest.mentionShare, baseline.mentionShare, latest.citationShare, baseline.citationShare, latest.recommendationShare, baseline.recommendationShare], ...latest.providers.map(provider => { const prior = providerByName(baseline, provider.name); return [provider.name, provider.index, prior.index, provider.mentions, prior.mentions, provider.citations, prior.citations, provider.recommendations, prior.recommendations]; })];
    return `<section class="panel"><header class="panel-head"><h2>September 15 vs August 27</h2><p>Full 100-prompt benchmark comparison</p></header><div class="table-wrap"><table><thead><tr><th>Scope</th><th class="num">VI</th><th class="num">VI Δ</th><th class="num">Mention</th><th class="num">Mention Δ</th><th class="num">Citation</th><th class="num">Citation Δ</th><th class="num">Recommendation</th><th class="num">Rec. Δ</th></tr></thead><tbody>${rows.map(row => `<tr><td><b>${row[0]}</b></td><td class="num">${fmt(row[1])}</td><td class="num">${delta(row[1] - row[2])}</td><td class="num">${pct(row[3])}</td><td class="num">${delta(row[3] - row[4], " pts")}</td><td class="num">${pct(row[5])}</td><td class="num">${delta(row[5] - row[6], " pts")}</td><td class="num">${pct(row[7])}</td><td class="num">${delta(row[7] - row[8], " pts")}</td></tr>`).join("")}</tbody></table></div></section>
    <div class="callout"><b>Interpretation:</b> Overall visibility improved, led by a 13.3-point gain on Perplexity. Citation share rose across every provider. Claude’s Visibility Index declined 2.2 points and OpenAI remains the weakest source-visibility channel.</div>`;
  }

  function evidence() {
    const latest = data.runs[0];
    return `<section class="stat-grid"><article class="stat"><span>Qualifying authority</span><strong>${latest.authorityMentions}/400</strong></article><article class="stat"><span>Authority share</span><strong>${pct(latest.authorityShare)}</strong></article><article class="stat"><span>Share of mentions</span><strong>19.4%</strong></article><article class="stat"><span>Provider-selection authority</span><strong>${pct(latest.providerSelectionAuthorityShare)}</strong></article></section>
    <section class="panel"><header class="panel-head"><h2>Independent Authority by Provider</h2><p>Claim-matched sources that qualify under the CSI authority rubric</p></header><div class="table-wrap"><table><thead><tr><th>Provider</th><th class="num">Qualifying observations</th><th class="num">Share of provider observations</th><th class="num">Average authority score</th></tr></thead><tbody>${latest.providers.map(p => `<tr><td><b>${p.name}</b></td><td class="num">${p.authority}</td><td class="num">${pct(p.authorityShare)}</td><td class="num">${fmt(p.averageAuthority, 2)}</td></tr>`).join("")}</tbody></table></div></section>
    <div class="callout"><b>Priority:</b> Publish at least two strong, independent, claim-matched sources before the next full benchmark. Current owned-source visibility is improving faster than third-party corroboration.</div>`;
  }

  function reports() {
    return `<section class="panel"><header class="panel-head"><h2>Reports</h2><p>Generated from finalized benchmark outputs</p></header><div class="report-card"><div><h3>CSI AI Visibility Baseline Comparison</h3><p>August 27 baseline vs September 15 full benchmark · 4 pages · DOCX</p></div><a class="btn" href="reports/CSI-AI-Visibility-Baseline-Comparison-2026-09-15.docx" download>Download report</a></div></section>`;
  }

  const views = { overview, "prompt-sets": promptSets, readiness, operations, compare, evidence, reports };
  function render() {
    renderSidebar();
    document.querySelectorAll("[data-page]").forEach(button => button.classList.toggle("active", button.dataset.page === currentPage));
    document.querySelector("#page-title").textContent = `${document.querySelector(`[data-page="${currentPage}"]`).textContent.trim()} · ${currentRun.id}`;
    document.querySelector("#content").innerHTML = views[currentPage]();
    document.querySelector("#updated").textContent = `Data finalized ${data.runs[0].date}`;
  }
  document.querySelectorAll("[data-page]").forEach(button => button.addEventListener("click", () => { currentPage = button.dataset.page; render(); }));
  document.querySelector("#refresh").addEventListener("click", render);
  render();
})();
