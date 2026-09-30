# Design system: "Sketchbook" for Spotted

A hand-drawn notebook look: dotted paper, ink outlines, hard offset shadows, one orange accent, hand-drawn icons.
Source of truth is `web/src/styles.css` (tokens in `:root`). If this doc and the CSS disagree, the CSS wins.
Adapted from Zack's Sketchbook system used in another project.

## Principles

1. **Paper and ink.** Warm off-white paper, near-black ink. No gradients (except skeleton shimmer), no blurred shadows.
2. **One accent.** Orange `#e8622c` is the only brand colour. Other colours carry meaning (status, AI, category tint).
3. **Colour means state.** Ink = admin verified, green = community verified, dashed yellow = being checked, red = hidden or error, blue = filled by AI, purple = Example.
4. **Outlined, not filled.** Surfaces are separated by 1.5px ink borders and hard shadows.
5. **Phone first.** Every screen is designed at 375 px first, then widened.

## Colour tokens

| Token | Value | Use |
|---|---|---|
| `--paper` | `#f4efe6` | Page background with a 22px dot grid |
| `--paper2` | `#efe8db` | Desktop sidebar |
| `--dot` / `--hair` | `#d6cbb9` | Dot grid, dashed dividers |
| `--card` | `#fffdf8` | Cards, inputs, buttons |
| `--soft` | `#e8e1d5` | Muted tags, skeletons, code |
| `--ink` | `#1d1b18` | Text, borders, hard shadows |
| `--ink2` | `#48423a` | Secondary text |
| `--ink3` | `#5e574c` | Tertiary text, eyebrows |
| `--accent` | `#e8622c` | Primary accent, focus ring, "On now", Add button |
| `--accent-soft` | `#fff1e2` | Hover tint |

State pairs (text on background):

| Meaning | Tag class | Text | Background |
|---|---|---|---|
| Admin verified | `.t-ink` | `--card` | `--ink` |
| Community verified | `.t-eng` | `#155e3a` | `#d8efe0` |
| Being checked | `.t-watch` | `#6b5200` | `#fff3c4`, dashed border |
| Hidden, errors | `.t-err` | `#a8200d` | `#fde8e6` |
| Filled by AI | `.t-ai` | `#1b45ad` | `#dce6fc` |
| Example data | `.t-sim` | `#553095` | `#ebe0fa` |
| On now | `.t-new` | `--card` | `--accent` |

Category covers without a photo use a soft tint plus an ink hatch pattern (`.pat-food`, `.pat-market`, ...), with the category icon on top.

## Typography

| Role | Font | Notes |
|---|---|---|
| Display | Bricolage Grotesque 800 | Page titles, card titles, big numbers |
| Body | Instrument Sans 400 to 700 | UI and text, 14px / 1.5 |
| Mono | ui-monospace | Formulas on the Me page |

- `h1` 40px (28px on phones), letter-spacing -0.8px. `h2` 20px. Card titles 18px (16px on phones).
- `.eyebrow`: 12px, 700, uppercase, 0.08em tracking, `--ink3`.
- Numbers that line up use `font-variant-numeric: tabular-nums` (`.num`).

## Shape and shadow

- Borders 1.5px ink. Avatars and the Add button 2px.
- Radius: cards and panels 16px, inputs and notices 12px, buttons, chips and tags are pills.
- Shadows are hard offsets only: `4px 4px 0 ink` (panels, hover), `3px 3px 0 ink` (small). Primary buttons and active nav use an orange offset `3px 3px 0 accent`.
- Hover lifts with `translate: -1px -1px` plus a shadow; active presses `translate: 2px 2px`.

## Layout

- Desktop (900px and up): 232px sticky sidebar, sticky 60px top bar with search, page max width 1180px, pop-up details in a 520px right drawer.
- Phone (under 900px): top bar with logo, karma pill and full-width search; bottom tab bar Explore, Map, **Add (raised orange circle)**, Saved, Me; details in a bottom sheet (92% height, handle, sticky Save and Directions footer). Filter chips scroll sideways.
- No hamburger menu. Less used things (review queue, newsletter, reminders, sign out) live on Me.

## Components

- **Logo**: the favicon mark (paper pin on an orange dot with an ink ring and offset shadow), `Logo` in `Shell.tsx`. Used in the sidebar, top bar, crash page and the server sign-in page.
- **Cards**: cover (photo or pattern) with the category tag on it, status tag, title, place and dates, footer with "% real", confidence meter and up/down score. On phones they become rows with a 100px cover on the left. The title is a stretched link; buttons sit above it.
- **Confidence meter**: green at 75% and up, yellow from 40%, red below.
- **Pop-up sheet**: facts list, "Is this real?" panel with the verification checklist, It's real / Fake, check-in, vote weight note.
- **Add form**: AI box first (blue border and blue offset shadow) that takes a link, pasted text (grows as you type) or a screenshot (button, drag and drop, or paste; a blue scan line runs over the preview while it reads), fields turn blue when AI filled them and get a dashed "Check this" tag when unsure, address search with a draggable pin map, trust score panel.
- **Map pins**: 30px circles in the status colour with the category icon; live pop-ups get an orange dot; the highlighted pin scales up with an orange ring.
- **Date picker**: a field button showing "Sat 3 Oct" (year only when not this year) that opens a month calendar: Monday first, today dashed, selected day ink with orange shadow, the start to end range shaded, quick chips Today, Tomorrow, Saturday. A popover on desktop, a bottom sheet on phones. Full keyboard support.
- **No native browser UI**: no `type="date"`, no browser validation bubbles (forms use `noValidate` and `.ferr` text), a custom clear button in search, ink scrollbars, orange text selection, autofill kept on paper, MapLibre zoom buttons in the Sketchbook style, inputs 16px on phones so iOS does not zoom.
- **Empty states and errors**: dashed box with a large ink3 icon, a heading, one line of help and a button. Router crashes show `CrashPage` instead of the default error screen.
- **Toasts**: ink pill with orange offset shadow, above the tab bar on phones.

## Icons

Koboyo hand-drawn icons (koboyo.com/icons), stored as an SVG sprite in `web/src/components/Icon.tsx`. They are filled paths: style them with `fill: currentColor`, never stroke. 18px by default, 22px in the tab bar. Free for commercial use; do not let users browse, pick or download them.

## Motion

Short and functional. Motion says where something came from, confirms a tap, or covers a wait. No library: CSS, plus `web/src/lib/motion.ts` for what CSS cannot do.

- **Tokens** (in `:root`): `--dur-1` 120 ms for presses, `--dur-2` 200 ms for fades and exits, `--dur-3` 320 ms for things that travel (sheets, toasts). `--ease-out` for entering, `--ease-in` for leaving, `--ease-spring` (a CSS `linear()` spring) for things that land.
- **Enter and leave**: sheets, drawers and toasts animate out as well as in. `useExit` keeps a closing element mounted for its exit animation.
- **Phones**: pull the sheet down to close it. The top bar tucks away while scrolling down. Tapping the current tab scrolls to the top. Press states use `:active` (scale down a little); hover lifts only apply on `@media (hover: hover)` so they never stick after a tap. Small buttons get a 44 px touch target with `::before`. Android gets a short `haptic()` buzz on save, vote and check in.
- **Waiting**: skeletons have the same shape as what they replace and stay invisible for the first 150 ms, so fast loads never flash. Sheets open at once with the list copy of a pop-up and fill in the rest. Saves and votes update straight away and undo themselves if the server says no. Changing filters dims the old list and shows a thin line under the top bar.
- **Small moments**: cards rise in one after another, meters grow, counts roll up or down (`Ticker`), buttons pop when they change state (`bump`), photos fade in over their category pattern.
- **Page transitions** (View Transitions API, via React Router's `viewTransition` on the tabs and sidebar): pages cross-fade and the selected tab or nav item slides to its new place. Opening a pop-up from a card or mini row passes its cover to `useSheet().open(slug, cover)`; the cover grows into the sheet's header while the sheet slides in. Browsers without view transitions get the CSS animations instead. Each page keeps its scroll position (`ScrollRestoration` keyed by path).
- **Map**: pins drop in one after another, later filter changes glide to the new bounds, and on phones the card row and the pins follow each other.
- **Add**: fields filled by AI light up one after another, and posting ends on a screen that says what happens next instead of a toast.
- **Status changes** stamp in (`.stamp`), for example when your vote verifies a pop-up.
- **Reduced motion**: everything still fades, but nothing slides, grows, bounces or loops. Spinners pulse instead of turning.

## Copy

- English UI, plain and specific. Buttons say what happens ("Email me a link", "Submit pop-up").
- No em dashes, en dashes or spaced hyphens in anything users see. Use "to" for ranges ("Sat 3 Oct to Sun 4 Oct").
- Errors explain what went wrong and what to do next, without apologising.
- Examples are always labelled: "This is an example pop-up that shows how Spotted works. It is not a real event."
