# Panini interface moodboard

This is a working design reference, not a request to reproduce another product. Panini remains a dense evidence and review workspace; the references below clarify the atmosphere, information hierarchy, and interaction quality we want.

## North star

Calm enough to inspect all day, dense enough to operate a company, and explicit enough that accepted state, evidence, and pending proposals are never confused.

## Public identity

The landing page is an editorial system rather than a blown-up product dashboard. It connects the name Panini to a rigorous grammar for work without using Sanskrit ornament, sandwich imagery, robots, fake company logos, or invented metrics.

- Core line: **The grammar of work.**
- Supporting line: **A common language for people and agents.**
- Palette: warm paper `#f2eee5`, graphite `#121416`, ultramarine `#143fc4`, and a small vermilion proof mark `#e13e24`.
- Display voice: high-contrast editorial serif paired with compact sans-serif and monospace system labels.
- Visual metaphor: physical rule machines turn fragments into traceable structure. Original assets live in `public/landing/`.
- Historical tribute: the blue brand mark uses the Devanagari letter `प`, tying the Panini name directly to Pāṇini without coded chapter numbers or specialist references.
- Motion: intersection-based reveals and a restrained hero parallax, with a complete reduced-motion exit.
- Route boundary: `/` explains Panini; `/app` remains the operational workspace.

| Reference | Visual cue | Adopt for Panini | Deliberately avoid |
| --- | --- | --- | --- |
| [Cofounder Canvas](https://docs.cofounder.co/workspace/canvas) | One company workspace connects tasks, agents, reviews, context, and durable files. | Persistent workspace navigation, a clear review destination, and contextual surfaces that keep work connected. | Copying its spatial company world, map metaphor, or branded presentation. Panini needs fast scanning more than spatial exploration. |
| [Linear UI redesign](https://linear.app/now/how-we-redesigned-the-linear-ui) | Aligned sidebar, tabs, icons, and controls; hierarchy comes from restrained surfaces and opacity instead of decoration. | Compact inverted-L chrome, quiet borders, precise alignment, denser navigation, and a neutral light theme with one desaturated accent. | Dark glass, purple gradients, floating decoration, excessive pills, and animation that competes with work. |
| [Sunsama](https://www.sunsama.com/) | A task-heavy product can still feel unhurried through rhythm, whitespace, and plain language. | Readable task cards, predictable spacing, reassuring empty states, and one obvious action at a time. | Oversized marketing typography inside the product and low-density card layouts that waste operational space. |
| [Phosphor Icons](https://github.com/phosphor-icons/web) | One coherent outline family covers navigation, actions, state, and objects. | Regular-weight Phosphor icons with text labels for primary navigation and unfamiliar actions. | Emoji, mixed icon packs, hand-drawn SVGs, ambiguous standalone symbols, or icons used as decoration. |

## Image board

### Linear: hierarchy and alignment

![Linear interface showing restrained chrome and aligned navigation](https://webassets.linear.app/images/ornj730p/production/900ab5bbf41d4245dcd32122b80ed523c5a00e2f-2352x1344.png?auto=format&dpr=2&q=95)

Use this reference for chrome-to-content contrast, aligned control rows, and the way the navigation recedes without disappearing.

### Linear: repeated components across dense views

![Linear interface study showing a family of dense views](https://webassets.linear.app/images/ornj730p/production/88c9e424655d613e5ccd5e260b7cc1a692d3c068-2352x2808.png?auto=format&dpr=2&q=95)

Use this reference to keep board, review, context, evidence, and agent screens recognizably part of one system.

### Sunsama: calm task rhythm

![Sunsama daily planning interface](https://pub-f7ae218077e542729e28e6f8f45a9a40.r2.dev/images/68b1c3051799d979c0d8b8c7_Today.avif)

Use this reference for readable vertical rhythm and task surfaces that feel steady rather than urgent.

## Applied system

- Canvas: cool neutral `#f5f6f7`; panels stay white or slightly muted.
- Accent: desaturated blue `#527493`, reserved for selection, primary actions, links, and informative emphasis.
- Type: compact system body text with a restrained display face for page and card headings.
- Corners: 16px panels, 12px cards, 9px controls. No arbitrary radius changes.
- Elevation: borders establish most hierarchy; shadows appear only on hover, dialogs, or genuinely raised surfaces.
- Density: 58px app bar, 228px desktop sidebar, 280px minimum board lanes, and 168px minimum task cards.
- Motion: 140–180ms feedback and view transitions; reduced-motion preference disables non-essential animation.
- Icon rule: one regular Phosphor family, icons paired with labels when meaning is not universally obvious.

## Screen intent

- **Work** answers what is active, what needs review, and what is blocked before showing the full board.
- **Review** makes the authority boundary visible and keeps each decision tied to its rationale and changes.
- **Context** behaves like a lightweight file browser: small index first, full fact or file only when selected.
- **Agents** makes owner, harness, grants, secret state, and revocation controls readable at a glance.
- **Evidence** looks like an audit register, not an analytics dashboard.

## Preflight checklist

- Desktop navigation labels remain on one line; mobile navigation retains all five destinations.
- Every interactive element has a visible focus state and an accessible text label or `aria-label`.
- No emoji or mixed icon families appear in product chrome.
- No unapproved gradient, glass, glow, decorative hero, or oversized heading enters a working view.
- Status color is never the only carrier of meaning.
- Empty, loading, error, and long-content states use the same spacing and type system as populated views.
