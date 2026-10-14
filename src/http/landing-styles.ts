export const landingStyles = String.raw`
:root {
  color-scheme: light;
  --paper: #f2eee5;
  --paper-bright: #fbf8f1;
  --ink: #121416;
  --muted: #5d5d59;
  --rule: #c8c2b6;
  --blue: #143fc4;
  --blue-dark: #0b2b91;
  --red: #e13e24;
  --white: #fffdf8;
  --display: "Iowan Old Style", "Palatino Linotype", Palatino, Baskerville, Georgia, serif;
  --sans: "Avenir Next", Avenir, "Segoe UI", Helvetica, Arial, sans-serif;
  --mono: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  --page: min(1440px, calc(100vw - 72px));
}

* { box-sizing: border-box; }
html { scroll-behavior: smooth; background: var(--paper); }
body {
  min-width: 320px;
  margin: 0;
  color: var(--ink);
  background: var(--paper);
  font: 16px/1.55 var(--sans);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
a { color: inherit; text-decoration: none; }
button { color: inherit; font: inherit; }
img { display: block; max-width: 100%; }
.ph { display: inline-block; flex: none; vertical-align: -.08em; }
.skip-link { position: fixed; z-index: 100; top: 12px; left: 12px; transform: translateY(-150%); padding: 10px 14px; color: var(--white); background: var(--ink); }
.skip-link:focus { transform: none; }

.site-header {
  width: var(--page);
  min-height: 86px;
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: center;
  margin: 0 auto;
  border-bottom: 1px solid var(--ink);
}
.wordmark { display: inline-flex; align-items: center; gap: 10px; width: max-content; }
.wordmark strong { font: 700 25px/1 var(--display); letter-spacing: -.035em; }
.panini-mark { width: 34px; height: 34px; display: grid; place-items: center; padding-top: 2px; color: var(--white); background: var(--blue); box-shadow: inset 0 -3px var(--red); font: 700 23px/1 "Kohinoor Devanagari", ".SF Devanagari", "Devanagari Sangam MN", sans-serif; }
.site-nav { display: flex; align-items: center; justify-content: flex-end; gap: clamp(22px, 3vw, 50px); }
.site-nav a { position: relative; font-size: 13px; font-weight: 600; letter-spacing: -.01em; }
.site-nav a:not(.nav-cta):after { content: ""; position: absolute; right: 0; bottom: -7px; left: 0; height: 1px; transform: scaleX(0); transform-origin: right; background: var(--ink); transition: transform .22s ease; }
.site-nav a:not(.nav-cta):hover:after { transform: scaleX(1); transform-origin: left; }
.site-nav .nav-cta { display: inline-flex; align-items: center; gap: 10px; padding: 11px 14px; color: var(--white); background: var(--ink); transition: color .2s ease, background .2s ease; }
.site-nav .nav-cta:hover { background: var(--blue); }
.menu-button { display: none; }

.hero {
  width: var(--page);
  min-height: calc(100svh - 86px);
  display: grid;
  grid-template-columns: minmax(0, .78fr) minmax(510px, 1.22fr);
  grid-template-rows: minmax(0, 1fr) auto;
  column-gap: clamp(48px, 7vw, 116px);
  align-items: center;
  margin: 0 auto;
  padding-top: clamp(52px, 7vh, 92px);
}
.hero-copy { align-self: center; padding-bottom: 8vh; }
.eyebrow { display: flex; align-items: center; gap: 10px; margin: 0 0 30px; color: var(--muted); font: 700 11px/1.2 var(--mono); letter-spacing: .04em; text-transform: uppercase; }
.eyebrow span { width: 9px; height: 9px; background: var(--red); }
.hero h1 { max-width: 650px; margin: 0; font: 500 clamp(76px, 8.7vw, 148px)/.78 var(--display); letter-spacing: -.075em; }
.hero h1 em { color: var(--blue); font-weight: 400; }
.hero-deck { max-width: 520px; margin: 46px 0 0; font-size: clamp(17px, 1.4vw, 22px); line-height: 1.55; letter-spacing: -.025em; }
.hero-actions { display: flex; align-items: center; gap: 28px; margin-top: 36px; }
.button { min-height: 50px; display: inline-flex; align-items: center; justify-content: center; gap: 14px; padding: 13px 18px; border: 1px solid var(--ink); font-size: 13px; font-weight: 700; transition: color .2s ease, background .2s ease, transform .2s ease; }
.button:hover { transform: translateY(-2px); }
.button-primary { color: var(--white); background: var(--ink); }
.button-primary:hover { border-color: var(--blue); background: var(--blue); }
.text-link { display: inline-flex; align-items: center; gap: 9px; padding: 9px 0 7px; border-bottom: 1px solid var(--ink); font-size: 13px; font-weight: 650; }
.text-link .ph { transition: transform .2s ease; }
.text-link:hover .ph { transform: translateY(3px); }

.hero-visual { --shift-x: 0; --shift-y: 0; position: relative; align-self: stretch; min-height: 560px; margin: 0; overflow: hidden; background: #e8e1d5; }
.hero-visual:before { content: ""; position: absolute; z-index: 2; inset: 0; border: 1px solid rgba(18,20,22,.18); pointer-events: none; }
.hero-visual img { width: 100%; height: 100%; object-fit: cover; transform: scale(1.035) translate(calc(var(--shift-x) * -7px), calc(var(--shift-y) * -7px)); transition: transform .45s cubic-bezier(.2,.7,.2,1); }
.hero-visual figcaption { position: absolute; z-index: 3; right: 0; bottom: 0; left: 0; min-height: 45px; display: grid; grid-template-columns: auto 1fr auto 1fr auto; align-items: center; gap: 12px; padding: 0 18px; color: var(--white); background: var(--ink); font: 650 9px/1 var(--mono); text-transform: uppercase; letter-spacing: .04em; }
.hero-visual figcaption i { height: 1px; background: rgba(255,255,255,.35); }

.hero-proof { grid-column: 1 / -1; min-height: 96px; display: grid; grid-template-columns: 1.1fr 1.4fr auto; gap: 24px; align-items: center; border-top: 1px solid var(--ink); }
.hero-proof p { margin: 0; }
.hero-proof > p:first-child { display: flex; align-items: center; gap: 14px; font-family: var(--display); font-size: 19px; }
.proof-mark { width: 26px; height: 26px; display: grid; place-items: center; color: var(--white); background: var(--red); font: 700 12px/1 var(--mono); }
.hero-proof > p:nth-child(2) { max-width: 490px; color: var(--muted); font-size: 13px; }
.proof-domain { font: 700 11px/1 var(--mono); }

.section-kicker { font: 700 10px/1.2 var(--mono); letter-spacing: .07em; text-transform: uppercase; }
.section-kicker.light { color: rgba(255,255,255,.62); }

.language-section { width: var(--page); display: grid; grid-template-columns: minmax(230px, .48fr) minmax(0, 1.52fr); gap: 54px; margin: 0 auto; padding: clamp(115px, 14vw, 220px) 0 125px; }
.language-heading { display: grid; grid-template-columns: minmax(0, 1fr) minmax(270px, .48fr); gap: 70px; align-items: end; }
.language-heading h2 { max-width: 810px; margin: 0; font: 500 clamp(55px, 6vw, 102px)/.94 var(--display); letter-spacing: -.058em; }
.language-heading p { margin: 0 0 7px; color: var(--muted); font-size: 15px; line-height: 1.7; }
.fragment-line { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(4, 1fr auto) 1.3fr; align-items: stretch; margin-top: 55px; border-top: 1px solid var(--ink); border-bottom: 1px solid var(--ink); }
.fragment-line > span { min-height: 98px; display: grid; align-content: space-between; padding: 18px 10px; font: 650 12px/1 var(--sans); }
.fragment-line > span b { color: var(--muted); font: 600 9px/1 var(--mono); }
.fragment-line > .ph { align-self: center; color: #88837b; font-size: 13px; }
.fragment-line .fragment-result { justify-content: center; align-content: center; margin-left: 14px; padding: 20px; color: var(--white); background: var(--blue); font: 500 clamp(21px, 2.2vw, 35px)/1 var(--display); text-align: center; }

.system-section { display: grid; grid-template-columns: minmax(0, 1.12fr) minmax(440px, .88fr); min-height: 820px; background: var(--white); }
.sorter-visual { position: relative; min-height: 720px; margin: 0; overflow: hidden; }
.sorter-visual img { width: 100%; height: 100%; object-fit: cover; }
.sorter-visual figcaption { position: absolute; right: 0; bottom: 0; width: min(470px, 78%); display: grid; gap: 5px; padding: 22px 25px; color: var(--white); background: var(--blue); }
.sorter-visual figcaption b { font: 500 24px/1.1 var(--display); }
.sorter-visual figcaption span { color: rgba(255,255,255,.77); font-size: 12px; }
.system-copy { align-self: center; padding: clamp(70px, 8vw, 130px); }
.system-copy h2 { max-width: 590px; margin: 35px 0 26px; font: 500 clamp(54px, 5vw, 88px)/.92 var(--display); letter-spacing: -.06em; }
.system-copy > p { max-width: 560px; margin: 0; color: var(--muted); font-size: 15px; line-height: 1.75; }
.rule-list { margin: 55px 0 0; padding: 0; border-top: 1px solid var(--ink); list-style: none; counter-reset: rules; }
.rule-list li { position: relative; display: grid; grid-template-columns: 130px 1fr; gap: 25px; padding: 20px 0 20px 31px; border-bottom: 1px solid var(--rule); counter-increment: rules; }
.rule-list li:before { content: counter(rules, decimal-leading-zero); position: absolute; top: 23px; left: 0; color: var(--blue); font: 700 9px/1 var(--mono); }
.rule-list span { font-weight: 700; font-size: 13px; }
.rule-list p { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.55; }

.vocabulary-section { width: var(--page); display: grid; grid-template-columns: .64fr 1.36fr; gap: clamp(70px, 10vw, 170px); margin: 0 auto; padding: clamp(120px, 15vw, 230px) 0; }
.vocabulary-head { position: sticky; top: 60px; align-self: start; }
.vocabulary-head h2 { margin: 34px 0 25px; font: 500 clamp(52px, 5.5vw, 88px)/.92 var(--display); letter-spacing: -.06em; }
.vocabulary-head > p { max-width: 430px; margin: 0; color: var(--muted); font-size: 15px; line-height: 1.7; }
.vocabulary-grid { border-top: 1px solid var(--ink); }
.vocabulary-grid article { min-height: 142px; display: grid; grid-template-columns: 52px minmax(180px, .48fr) minmax(220px, 1fr) minmax(140px, .45fr); gap: 24px; align-items: center; padding: 24px 0; border-bottom: 1px solid var(--rule); transition: color .2s ease, padding .2s ease, background .2s ease; }
.vocabulary-grid article:hover { padding-right: 16px; padding-left: 16px; color: var(--white); background: var(--blue); }
.vocabulary-grid article > b { color: var(--blue); font: 700 10px/1 var(--mono); }
.vocabulary-grid article:hover > b, .vocabulary-grid article:hover > p, .vocabulary-grid article:hover > span { color: rgba(255,255,255,.78); }
.vocabulary-grid h3 { margin: 0; font: 500 clamp(28px, 2.5vw, 42px)/1 var(--display); letter-spacing: -.04em; }
.vocabulary-grid p { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.6; }
.vocabulary-grid article > span { color: var(--muted); font: 700 9px/1.4 var(--mono); text-transform: uppercase; }

.authority-section { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(440px, .9fr); min-height: 820px; color: var(--white); background: var(--ink); }
.authority-copy { align-self: center; padding: clamp(72px, 9vw, 150px); }
.authority-copy h2 { max-width: 850px; margin: 42px 0 31px; font: 500 clamp(54px, 5.9vw, 102px)/.91 var(--display); letter-spacing: -.062em; }
.authority-copy h2 em { color: #5378f2; font-weight: 400; }
.authority-copy > p { max-width: 650px; margin: 0; color: rgba(255,255,255,.65); font-size: 16px; line-height: 1.7; }
.authority-lines { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; margin-top: 65px; background: rgba(255,255,255,.18); }
.authority-lines p { min-height: 164px; display: grid; grid-template-columns: 28px 1fr; gap: 12px; align-content: start; margin: 0; padding: 25px 20px; background: var(--ink); }
.authority-lines .ph { color: #6688ef; font-size: 21px; }
.authority-lines span { color: rgba(255,255,255,.56); font-size: 11px; line-height: 1.55; }
.authority-lines b { display: block; margin-bottom: 12px; color: var(--white); font-size: 12px; }
.structure-visual { position: relative; min-height: 620px; margin: 0; overflow: hidden; }
.structure-visual:after { content: ""; position: absolute; inset: 0; border-left: 1px solid rgba(255,255,255,.25); pointer-events: none; }
.structure-visual img { width: 100%; height: 100%; object-fit: cover; }
.structure-visual figcaption { position: absolute; right: 0; bottom: 0; left: 0; min-height: 60px; display: flex; align-items: center; justify-content: center; gap: 18px; padding: 15px; color: var(--ink); background: var(--white); font: 650 10px/1 var(--mono); text-transform: uppercase; }
.structure-visual figcaption .ph { font-size: 13px; }
.structure-visual figcaption b { color: var(--blue); }

.closing-section { width: var(--page); display: grid; grid-template-columns: .45fr 1.55fr; grid-template-rows: auto auto; gap: 70px; margin: 0 auto; padding: clamp(120px, 16vw, 245px) 0 80px; }
.closing-label { padding-top: 9px; font: 700 11px/1 var(--mono); }
.closing-copy > p { margin: 0 0 28px; color: var(--blue); font-size: 14px; font-weight: 700; }
.closing-copy h2 { margin: 0; font: 500 clamp(75px, 10vw, 164px)/.8 var(--display); letter-spacing: -.077em; }
.button-large { min-height: 61px; margin-top: 58px; padding: 17px 23px; font-size: 14px; }
.closing-rule { grid-column: 1 / -1; height: 36px; display: grid; grid-template-columns: 1.4fr .5fr 2fr .32fr .9fr; gap: 9px; margin-top: 60px; }
.closing-rule i { background: var(--ink); }
.closing-rule i:nth-child(2), .closing-rule i:nth-child(5) { background: var(--blue); }
.closing-rule i:nth-child(4) { background: var(--red); }

footer { width: var(--page); min-height: 116px; display: grid; grid-template-columns: 1fr 1fr auto; align-items: center; gap: 30px; margin: 0 auto; border-top: 1px solid var(--ink); }
.footer-wordmark strong { font-size: 21px; }
.footer-wordmark .panini-mark { width: 28px; height: 28px; font-size: 19px; }
footer > p { margin: 0; color: var(--muted); font-size: 12px; }
footer > div { display: flex; gap: 26px; font: 700 10px/1 var(--mono); }

[data-reveal] { opacity: 0; transform: translateY(28px); transition: opacity .72s ease, transform .72s cubic-bezier(.2,.7,.2,1); }
[data-reveal][data-visible] { opacity: 1; transform: none; }
.hero-visual[data-reveal] { transition-delay: .11s; }
.hero-proof[data-reveal] { transition-delay: .2s; }

a:focus-visible, button:focus-visible { outline: 3px solid var(--red); outline-offset: 4px; }

@media (max-width: 1180px) {
  :root { --page: calc(100vw - 44px); }
  .hero { grid-template-columns: .78fr 1.22fr; column-gap: 38px; }
  .hero h1 { font-size: clamp(68px, 8.4vw, 100px); }
  .hero-visual { min-height: 510px; }
  .language-section { grid-template-columns: 180px 1fr; }
  .language-heading { grid-template-columns: 1fr; gap: 30px; }
  .language-heading p { max-width: 520px; }
  .system-section { grid-template-columns: 1fr 1fr; }
  .system-copy, .authority-copy { padding: 72px 54px; }
  .authority-lines { grid-template-columns: 1fr; }
  .authority-lines p { min-height: 0; }
  .vocabulary-section { grid-template-columns: 1fr; gap: 65px; }
  .vocabulary-head { position: static; }
}

@media (max-width: 900px) {
  :root { --page: calc(100vw - 34px); }
  .site-header { min-height: 74px; }
  .site-nav { position: absolute; z-index: 20; top: 74px; right: 17px; left: 17px; display: none; align-items: stretch; padding: 13px; border: 1px solid var(--ink); background: var(--paper-bright); box-shadow: 0 18px 40px rgba(18,20,22,.12); }
  .site-nav[data-open] { display: grid; }
  .site-nav a { padding: 13px 10px; }
  .site-nav .nav-cta { margin-top: 4px; }
  .menu-button { width: 42px; height: 42px; display: grid; place-items: center; justify-self: end; padding: 0; border: 1px solid var(--ink); background: transparent; font-size: 20px; }
  .hero { min-height: auto; grid-template-columns: 1fr; grid-template-rows: auto auto auto; gap: 45px; padding-top: 70px; }
  .hero-copy { padding: 0; }
  .hero h1 { font-size: clamp(72px, 15vw, 118px); }
  .hero-deck { margin-top: 35px; }
  .hero-visual { min-height: min(620px, 74vw); }
  .hero-proof { grid-column: auto; grid-template-columns: 1fr auto; margin-top: 2px; }
  .hero-proof > p:nth-child(2) { grid-column: 1 / -1; grid-row: 2; padding-bottom: 25px; }
  .language-section { grid-template-columns: 1fr; gap: 36px; padding: 130px 0 90px; }
  .language-heading { grid-template-columns: 1fr; }
  .fragment-line { grid-template-columns: 1fr 28px 1fr; }
  .fragment-line > span { border-bottom: 1px solid var(--rule); }
  .fragment-line > .ph:nth-of-type(2), .fragment-line > .ph:nth-of-type(4) { display: none; }
  .fragment-line > .ph:nth-of-type(3) { grid-column: 2; }
  .fragment-line .fragment-result { grid-column: 1 / -1; min-height: 82px; margin: 0; }
  .system-section, .authority-section { grid-template-columns: 1fr; }
  .sorter-visual { min-height: 70vw; }
  .system-copy, .authority-copy { padding: 90px 7vw; }
  .vocabulary-section { grid-template-columns: 1fr; gap: 65px; padding: 130px 0; }
  .vocabulary-head { position: static; }
  .authority-section { padding-top: 0; }
  .structure-visual { min-height: 90vw; }
  .closing-section { grid-template-columns: 1fr; gap: 35px; }
  .closing-copy h2 { font-size: clamp(73px, 14vw, 130px); }
}

@media (max-width: 620px) {
  :root { --page: calc(100vw - 28px); }
  .wordmark strong { font-size: 23px; }
  .hero { gap: 34px; padding-top: 55px; }
  .eyebrow { max-width: 265px; margin-bottom: 24px; line-height: 1.5; }
  .hero h1 { font-size: clamp(65px, 20vw, 98px); line-height: .82; }
  .hero-deck { margin-top: 30px; font-size: 16px; }
  .hero-actions { align-items: stretch; flex-direction: column; gap: 13px; }
  .text-link { align-self: flex-start; }
  .hero-visual { min-height: 102vw; }
  .hero-visual img { object-position: 54% center; }
  .hero-visual figcaption { grid-template-columns: auto 1fr auto; }
  .hero-visual figcaption i:nth-of-type(2), .hero-visual figcaption span:nth-of-type(2) { display: none; }
  .hero-proof { min-height: 135px; grid-template-columns: 1fr; gap: 11px; padding: 24px 0; }
  .hero-proof > p:nth-child(2) { grid-column: auto; grid-row: auto; padding: 0; }
  .proof-domain { display: none; }
  .language-section { padding: 110px 0 78px; }
  .language-heading h2, .system-copy h2, .vocabulary-head h2, .authority-copy h2 { font-size: clamp(50px, 15vw, 72px); }
  .fragment-line { display: grid; grid-template-columns: 1fr; }
  .fragment-line > .ph { display: none; }
  .fragment-line > span { min-height: 70px; }
  .fragment-line .fragment-result { grid-column: auto; }
  .sorter-visual { min-height: 108vw; }
  .sorter-visual img { object-position: 47% center; }
  .sorter-visual figcaption { width: calc(100% - 24px); }
  .system-copy, .authority-copy { padding: 78px 20px; }
  .rule-list li { grid-template-columns: 1fr; gap: 7px; padding-left: 31px; }
  .vocabulary-section { padding: 110px 0; }
  .vocabulary-grid article { grid-template-columns: 36px 1fr; gap: 12px 16px; padding: 24px 0; }
  .vocabulary-grid article > p, .vocabulary-grid article > span { grid-column: 2; }
  .vocabulary-grid article:hover { padding-right: 10px; padding-left: 10px; }
  .authority-lines { margin-top: 45px; }
  .structure-visual { min-height: 118vw; }
  .structure-visual figcaption { gap: 10px; font-size: 8px; }
  .closing-section { padding-top: 110px; }
  .closing-copy h2 { font-size: clamp(63px, 19vw, 96px); }
  .closing-copy h2 br { display: none; }
  .closing-rule { margin-top: 30px; }
  footer { grid-template-columns: 1fr auto; padding: 30px 0; }
  footer > p { grid-column: 1 / -1; grid-row: 2; }
  footer > div span:last-child { display: none; }
}

@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  *, *:before, *:after { animation-duration: .001ms !important; animation-iteration-count: 1 !important; transition-duration: .001ms !important; }
  [data-reveal] { opacity: 1; transform: none; }
}
`;
