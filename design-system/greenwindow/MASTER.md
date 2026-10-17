# GreenWindow design system (master)

Generated with the ui-ux-pro-max skill (`--design-system`, query "energy climate data dashboard forecast tool", dials variance 5 / motion 3 / density 6), then curated. Implementation: `web/src/index.css`. Page-specific overrides go in `pages/<page>.md`.

## Character
A calm, honest scientific instrument. It answers "when is the grid cleanest?" first, then shows the evidence (uncertainty bands, benchmarks, negative results). Avoid greenwashing imagery and any decoration that implies impact claims (rule 9).

## Colour (semantic tokens; light / dark follow the OS)
| Token | Use |
|---|---|
| `canvas` | page background (faint green-white / deep green-black) |
| `surface`, `surface-2` | cards; subtle fills, hover rows, tags |
| `line`, `line-strong` | dividers and card borders; input borders |
| `ink`, `ink-2`, `ink-3` | primary text; secondary text; captions and axes (ink-3 still meets 4.5:1 on surface) |
| `accent`, `accent-soft`, `accent-ink` | emerald: primary data series, active nav, best values; tinted backgrounds; text on soft tint |
| `brand-600/700` | solid buttons (white text) |
| amber / red | warnings and errors only |

Chart series: actual = `ink-2` solid, model P50 = `accent` solid 2.5px, 80% band = hatched accent, NESO = `ink-3` dashed, comparison = `--chart-compare` (amber) dotted. Series always differ in line style as well as colour.

Intensity ramp (the 48 h strip): green, then amber, then rust, scaled to the hours shown and labelled as relative. Never use it as an absolute "good/bad" scale.

## Type
- Headings: Newsreader Variable (serif, `font-display`), semibold, tight tracking.
- UI and numbers: Inter Variable, `tabular-nums` for every figure.
- Eyebrow labels: 12px uppercase, 0.08em tracking, `ink-3`.
- Body 16px, line-height ~1.6; captions 12px minimum.

## Components (`@layer components` in index.css)
`card`, `eyebrow`, `page-title`, `lede`, `btn-primary`, `btn-secondary`, `field`, `data-table`. Radius: 16px for cards, 8px for controls. Segmented controls (radiogroups) for metric and horizon switches.

## Layout
`max-w-6xl` container, 16px gutters. Sticky header; on phones the nav scrolls sideways (no wrap, no page overflow). Answer first: every page leads with the headline result, then the evidence.

## Motion and accessibility
Colour transitions only (150-200ms); `prefers-reduced-motion` disables them. Visible focus rings (`outline-accent`), SVG icons only (no emoji), and information never carried by colour alone.
