import { landingScript } from "./landing-script.js";
import { landingStyles } from "./landing-styles.js";

function html(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

export function renderLandingPage(nonce: string): string {
	const safeNonce = html(nonce);

	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="theme-color" content="#f2eee5">
  <meta name="description" content="Panini gives people and agents a shared structure for tasks, context, evidence, permissions, and proposals.">
  <meta property="og:type" content="website">
  <meta property="og:title" content="Panini | The grammar of work.">
  <meta property="og:description" content="A common language for people and agents.">
  <meta property="og:url" content="https://panini.work/">
  <meta property="og:image" content="https://panini.work/assets/landing/grammar-machine.webp">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="canonical" href="https://panini.work/">
  <link rel="icon" href="/assets/panini-mark.svg?v=pa" type="image/svg+xml">
  <title>Panini | The grammar of work.</title>
  <link rel="stylesheet" href="/assets/phosphor.css" nonce="${safeNonce}">
  <style nonce="${safeNonce}">${landingStyles}</style>
</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  <header class="site-header">
    <a class="wordmark" href="/" aria-label="Panini home, named in tribute to the grammarian Pāṇini">
      <span class="panini-mark" lang="sa" aria-hidden="true">प</span>
      <strong>Panini</strong>
    </a>
    <button class="menu-button" type="button" aria-label="Toggle navigation" aria-expanded="false" data-menu-button>
      <i class="ph ph-list" aria-hidden="true"></i>
    </button>
    <nav class="site-nav" aria-label="Main navigation" data-menu>
      <a href="#language">Why Panini</a>
      <a href="#system">The system</a>
      <a href="#authority">Control</a>
      <a class="nav-cta" href="/app">Open workspace <i class="ph ph-arrow-up-right" aria-hidden="true"></i></a>
    </nav>
  </header>

  <main id="main">
    <section class="hero">
      <div class="hero-copy" data-reveal>
        <p class="eyebrow"><span></span>A common language for people and agents</p>
        <h1>The grammar<br><em>of work.</em></h1>
        <p class="hero-deck">Give people and agents one legible system for tasks, context, evidence, permissions, and proposals.</p>
        <div class="hero-actions">
          <a class="button button-primary" href="/app">Open Panini <i class="ph ph-arrow-right" aria-hidden="true"></i></a>
          <a class="text-link" href="#system">Read the system <i class="ph ph-arrow-down" aria-hidden="true"></i></a>
        </div>
      </div>

      <figure class="hero-visual" data-hero-visual data-reveal>
        <img src="/assets/landing/grammar-machine.webp" width="1586" height="992" alt="A precision machine organizing graphite and blue blocks into a shared structure">
        <figcaption><span>From signal</span><i></i><span>through rules</span><i></i><span>to accepted state</span></figcaption>
      </figure>

      <div class="hero-proof" data-reveal>
        <p><span class="proof-mark">P</span><strong>Structure for intelligent work.</strong></p>
        <p>Agents can act. People retain authority. Every accepted change keeps its proof.</p>
        <span class="proof-domain">panini.work</span>
      </div>
    </section>

    <section class="language-section" id="language">
      <div class="section-kicker">The coordination problem</div>
      <div class="language-heading" data-reveal>
        <h2>Work breaks when its language is implicit.</h2>
        <p>Briefs, chats, tasks, files, and agent traces each tell part of the story. Panini gives the company a grammar that keeps those parts connected without treating every claim as truth.</p>
      </div>
      <div class="fragment-line" aria-label="Panini connects the parts of organizational work" data-reveal>
        <span><b>01</b> Tasks</span><i class="ph ph-plus" aria-hidden="true"></i>
        <span><b>02</b> Context</span><i class="ph ph-plus" aria-hidden="true"></i>
        <span><b>03</b> Evidence</span><i class="ph ph-plus" aria-hidden="true"></i>
        <span><b>04</b> Authority</span><i class="ph ph-equals" aria-hidden="true"></i>
        <span class="fragment-result">Legible work</span>
      </div>
    </section>

    <section class="system-section" id="system">
      <figure class="sorter-visual" data-reveal>
        <img src="/assets/landing/work-sorter.webp" width="1448" height="1086" loading="lazy" alt="Paper fragments being sorted into precise blue, black, and ivory channels">
        <figcaption><b>Input stays evidence.</b><span>Rules determine what can become accepted state.</span></figcaption>
      </figure>
      <div class="system-copy" data-reveal>
        <div class="section-kicker">A generative system</div>
        <h2>A company is a language in motion.</h2>
        <p>Panini defines how work is named, connected, supported, and changed. The result is not another place to manage tickets. It is a structure every participant can reason with.</p>
        <ol class="rule-list">
          <li><span>Observe</span><p>Receipts enter with source, time, and visibility intact.</p></li>
          <li><span>Interpret</span><p>Agents turn evidence into cited proposals, never silent mutations.</p></li>
          <li><span>Decide</span><p>People and policy accept, reject, or refine the proposed change.</p></li>
          <li><span>Remember</span><p>Every revision remains linked to the evidence and decision behind it.</p></li>
        </ol>
      </div>
    </section>

    <section class="vocabulary-section">
      <div class="vocabulary-head" data-reveal>
        <div class="section-kicker">The vocabulary</div>
        <h2>Five nouns.<br>One operating language.</h2>
        <p>Each part has a distinct job, so the system stays intelligible as people, tools, and agents multiply.</p>
      </div>
      <div class="vocabulary-grid" data-reveal>
        <article><b>01</b><h3>Tasks</h3><p>The accepted record of intended work, ownership, status, and dependencies.</p><span>What should happen</span></article>
        <article><b>02</b><h3>Context</h3><p>Durable facts and files arranged for exact retrieval, not vague recollection.</p><span>What the company knows</span></article>
        <article><b>03</b><h3>Evidence</h3><p>Source observations and work receipts with identity, time, and lineage.</p><span>What actually happened</span></article>
        <article><b>04</b><h3>Permissions</h3><p>Explicit grants that define what each person and agent may read or propose.</p><span>Who may do what</span></article>
        <article><b>05</b><h3>Proposals</h3><p>Reviewable requests that keep machine interpretation separate from company truth.</p><span>What might change</span></article>
      </div>
    </section>

    <section class="authority-section" id="authority">
      <div class="authority-copy" data-reveal>
        <div class="section-kicker light">Authority by design</div>
        <h2>Intelligence may propose.<br><em>People and policy decide.</em></h2>
        <p>Panini makes the boundary visible. Agents can search, report, and suggest. Accepted state changes only through an authorized decision.</p>
        <div class="authority-lines">
          <p><i class="ph ph-fingerprint" aria-hidden="true"></i><span><b>Trace every claim</b>Evidence retains its source and timing.</span></p>
          <p><i class="ph ph-shield-check" aria-hidden="true"></i><span><b>Scope every agent</b>Each connection receives explicit grants.</span></p>
          <p><i class="ph ph-stamp" aria-hidden="true"></i><span><b>Review every change</b>Proposals wait at the authority boundary.</span></p>
        </div>
      </div>
      <figure class="structure-visual" data-reveal>
        <img src="/assets/landing/shared-structure.webp" width="1254" height="1254" loading="lazy" alt="A precise network of ceramic and metal modules with a blue module awaiting placement">
        <figcaption><span>Proposed</span><i class="ph ph-arrow-right" aria-hidden="true"></i><span>Reviewed</span><i class="ph ph-arrow-right" aria-hidden="true"></i><b>Accepted</b></figcaption>
      </figure>
    </section>

    <section class="closing-section">
      <div class="closing-label">Panini</div>
      <div class="closing-copy" data-reveal>
        <p>The operating language of the agentic company.</p>
        <h2>Make organizational<br>work legible.</h2>
        <a class="button button-primary button-large" href="/app">Enter the workspace <i class="ph ph-arrow-up-right" aria-hidden="true"></i></a>
      </div>
      <div class="closing-rule" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
    </section>
  </main>

  <footer>
    <a class="wordmark footer-wordmark" href="/" aria-label="Panini home, named in tribute to the grammarian Pāṇini"><span class="panini-mark" lang="sa" aria-hidden="true">प</span><strong>Panini</strong></a>
    <p>A common language for people and agents.</p>
    <div><span>panini.work</span><span>2026</span></div>
  </footer>

  <script nonce="${safeNonce}">${landingScript}</script>
</body>
</html>`;
}
