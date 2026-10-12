# Map home: one map canvas instead of Explore + Map

Status: approved by Zack on 2026-10-02 after an interactive mockup (phone and desktop, option A: no bottom tabs).

## Goal

People open Spotted to find out what is on near them. Today they land on a card grid, the map is a second page, and "Near me" is one chip on the grid. Make the map the landing page, make "where am I and what is next to me" the first thing it answers, and take the permanent navigation off the screen so the map has room.

## What changes

1. `/` becomes a full-screen map. Explore and Map merge into one page, `HomePage`. `/map` redirects to `/` and keeps the query string. `/p/:slug` still opens the pop-up sheet over the home page.
2. A `Map | List` switch picks the display mode. Map: the map is the page and the list is a short strip or panel. List: the list fills the screen (the map stays mounted underneath).
3. The left sidebar and the phone tab bar are removed. A hamburger opens a left menu with the old items. Add becomes a button on the map.
4. Sharing location is a first-class flow: a prompt card, a blue dot, a "back to my location" button, distance on every card.

No API, database or Worker change. The nearby filter and distance sort already run in the browser (`filterPopups`, `usePopups(near)`), and the position never leaves the device.

## Layout

All map chrome floats over the map, using the existing Sketchbook look (paper, ink outline, hard offset shadow, one orange accent). Blue is used only for "you" (dot, locate button, distance badge).

### Phone (under 900 px)

- Top bar (floating pill): menu button, search field, avatar (or Sign in). Under it a row of chips: Near me, When chips, category chips.
- Right edge: locate button (arrow) above Add button. They sit just above the bottom sheet and follow it as it moves. Hidden when the sheet is full.
- Bottom sheet with three snaps. Peek: header plus a one-row card carousel. Half: header plus a list. Full (List mode): a card grid that scrolls, the top bar and chips stay visible above it.
- The `Map | List` switch lives in the sheet header. Dragging the sheet to full switches to List, dragging down switches back to Map. The switch and the drag are the same state.
- No bottom tabs. Saved and Me are in the menu.

### Desktop (900 px and up)

- Top bar across the top: menu, logo and name, search, `Map | List`, Add, karma pill.
- Left floating panel (372 px): chips, count, list of mini cards. In List mode the panel widens to the full width and shows the card grid.
- Locate and Add stay bottom right. Hidden in List mode.
- Clicking a pin opens the pop-up sheet (existing behaviour). Hovering a card highlights its pin.

### Other pages (Add, Saved, Me, admin)

Same content as now. The sidebar column is gone, so the page is centred in `max-width: 1180px`. They get the same top bar, not floating: sticky, full width, menu button on the left, no tuck-away on desktop.

### No-overlap rules (phone)

These are requirements, not polish. Check each at 375 x 667 and 375 x 812 (with a safe-area inset).

- Chips: the row has vertical padding so chip shadows are not clipped, and a 10 px gap from the top bar.
- MapLibre zoom buttons are removed on phone (pinch works). On desktop they sit below the top bar, not under it.
- Map attribution sits bottom left, above the sheet, so it never goes under the right-hand buttons.
- Locate/Add column rides above the sheet top with a 14 px gap and never overlaps the attribution.
- Toasts are left-aligned and leave the right 72 px free, so they never cover the buttons, and sit above the sheet and the attribution button (sheet top + 44 px). The toast layer is a sibling of `.shell`, so the rule is `.shell[data-home="true"] ~ .toasts`.
- The pop-up sheet (z-index 20 and 21) and the menu (22 and 23) cover all map chrome. Map chrome stays under z-index 20.
- iOS: the bar uses `env(safe-area-inset-top)`, the sheet uses `env(safe-area-inset-bottom)`, inputs stay 16 px.
- Keyboard open: the sheet and buttons hide while search is focused so the keyboard never pushes them over the field.

## Location flow

State `useNearMe`: `idle | asking | on | denied | unsupported`, plus `pos`.

- First visit, nothing stored, permission not denied: a prompt card floats over the map: "Pop-ups near you?", [Use my location] [Not now], and the line "Your location stays on this device." The browser permission dialog only appears after the person taps the button.
- Permission already granted (Permissions API) and the person used it before (`localStorage spotted.near = 1`): locate silently on load.
- "Not now" stores `spotted.near = 0` and hides the card. The locate button still works.
- On success: blue dot with a pulsing ring, map flies to the person (about 0.9 s), the Near me chip turns on, the list is filtered to 3 km and sorted by distance, cards show a distance badge, a toast says how many pop-ups are within 3 km.
- Near me chip off keeps the blue dot and the position, and shows all pop-ups again.
- Denied: the locate button shows a toast "Location is blocked. Allow it in your browser settings for this site." The rest of the app works.
- Zero pop-ups within 3 km: the list says so and offers "Show all London".
- Locate button states: no position (outline), position and centred (filled blue), position but map panned away (orange, bounces, tooltip "Back to you"). Tapping it flies back. Away means the dot is more than 70 px from the visible map centre.

## Motion

All motion respects `prefers-reduced-motion` through the existing `reducedMotion()` helper.

| When | What |
| --- | --- |
| Load | Pins drop in one after another (existing `pindrop`), the sheet slides up 320 ms |
| Locate | Dot pops in, ring pulses, map flies 900 ms, cards re-sort and distance badges pop in with a 40 ms stagger |
| Pan away | Locate button turns orange and bounces |
| Sheet drag | Follows the finger, snaps by position plus velocity with a 450 ms ease-out, map padding follows so the focus point stays visible |
| Map / List | Switch thumb slides with the spring easing, sheet or panel animates to its new size, grid fades in |
| Pin tap on phone | Sheet goes to peek and the matching card centres (existing behaviour) |
| Menu | Slides in 280 ms, items stagger 32 ms, scrim fades |

## Code

New in `web/src/`:

- `pages/HomePage.tsx`: replaces `Explore.tsx` and `MapPage.tsx` as the route. `usePopups`, `Filters`, `VerifiedSwitch`, `Newsletter` move out of `Explore.tsx` into `components/` or stay exported from `lib/`/`pages/` as the code needs, and `Explore.tsx` and `MapPage.tsx` are deleted.
- `components/NavMenu.tsx`: the hamburger menu (items from the old sidebar, map key, attribution).
- `components/TopBar.tsx`: the bar, in a floating variant (home) and a sticky variant (other pages).
- `components/MapSheet.tsx`: bottom sheet with snaps (phone) and the left panel (desktop), one component, one state.
- `lib/near-me.ts`: `useNearMe`.
- `components/maps.tsx`: `PopupMap` gains `me`, `padding`, a ref with `recenter()`, and `onAway`.
- `Shell.tsx`: drops `aside` and `tabbar`, renders the menu and the right bar for the route.
- `styles.css`: remove sidebar, tab bar and old map page rules, add `mp-*` rules for the new parts. New class names are prefixed `mp-` because `.drawer`, `.scrim`, `.panel`, `.me` and `.nav` already exist for other things.
- `Icon.tsx`: a plain `i-menu` icon.
- `main.tsx`: `/map` redirect, `HomePage` is the route for `/` and `/p/:slug`, the map code is split with `lazy` inside `HomePage` so the page frame paints first.

Docs: update `CLAUDE.md` (code map, "Phone layout" rule) and `docs/DESIGN.md`.

## Risks

- The map is now the first screen. The MapLibre chunk is big. The page frame, bar, chips and sheet render first on paper-coloured background, the map fades in when its chunk is ready. No white flash.
- Sheet drag and MapLibre drag both use pointer events. The sheet only listens on its header, the map handles its own canvas.
- `ScrollRestoration` keys by pathname. The home page does not scroll the document (the list scrolls inside the sheet), so only the list scroll position is lost on navigation. Accepted.
- Removing the tab bar makes Saved and Me one tap deeper. Accepted by Zack (option A).

## Out of scope

Live tracking while walking (`watchPosition`), clustering of pins, a radius picker, saving the last map position, bookmarks on the map.

## Testing

- Unit: `useNearMe` state transitions with a stubbed `navigator.geolocation` and `navigator.permissions`; snap choice from position and velocity (pure function).
- Existing API and snapshot tests keep passing (no server change). `npm run typecheck`, `cd web && npx tsc --noEmit`, `npm test`.
- Manual in the browser at 375 px and 1280 px: every no-overlap rule above, location granted / denied / not now, Map and List modes, menu, pin tap, `/map` redirect, `/p/:slug` shared link, reduced motion.
