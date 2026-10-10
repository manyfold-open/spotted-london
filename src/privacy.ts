// The privacy policy, served as plain HTML by the Worker (no JavaScript needed, so Google's checks and crawlers read it).
// It says what the code does. When the code changes what it collects, keeps or shares, change this page in the same PR.

import { html } from 'hono/html';

export const PRIVACY_UPDATED = '10 October 2026';
export const PRIVACY_CONTACT = 'zack11712@gmail.com';

export const privacyBody = (origin: string) => html`
<h1>Privacy</h1>
<p class="meta">Last updated ${PRIVACY_UPDATED}</p>
<p>Spotted London (${origin}) lists pop-ups in London. It is a small independent project run by one person. This page says what we collect, why, who else sees it and how to get it removed. Questions: <a href="mailto:${PRIVACY_CONTACT}">${PRIVACY_CONTACT}</a>.</p>

<h2>You can use most of it without an account</h2>
<p>Browsing the map and the list, Near me, For you, Ask and saving pop-ups all work signed out. Saves and your For you picks then stay in your browser on your device. You only need an account to add a pop-up, vote, check in or report.</p>

<h2>What we collect</h2>
<ul>
  <li><b>Account.</b> Your email address, and your name if you sign in with Google. From Google we ask only for your email, your name and your Google account ID (the openid, email and profile permissions). We do not read your contacts, calendar, Drive or anything else.</li>
  <li><b>What you do on Spotted.</b> Pop-ups you add (with any photo), your votes, reports, check-ins, saved pop-ups and the karma points you earn.</li>
  <li><b>Check-ins.</b> The location your phone gives at the moment you check in. We keep the coordinates for 30 days, then delete them and keep only whether the check-in was valid.</li>
  <li><b>Near me.</b> Your position stays in your browser. It is used to put nearby pop-ups first and is never sent to us.</li>
  <li><b>For you.</b> Your picks stay in your browser. If you are signed in, a copy is kept on your account so a new device can get it back.</li>
  <li><b>Ask.</b> The question you type, plus a short summary of what you like (categories and a few tags), is sent to an AI helper that picks pop-ups for you. We keep the question for 7 days, with a scrambled version of your IP address, to count daily limits and catch abuse.</li>
  <li><b>Adding a pop-up from a link, text or screenshot.</b> What you paste is read by an AI model to fill in the form.</li>
  <li><b>Visitors.</b> To stop abuse we keep a salted, scrambled version of your IP address, never the address itself. We use no advertising or analytics trackers.</li>
</ul>

<h2>Cookies and storage</h2>
<p>One cookie keeps you signed in for up to 30 days. Your browser also stores small settings on your device: saved pop-ups when signed out, your For you picks, whether you agreed to share your location, and a note about what you were doing when you were asked to sign in. Nothing here is used for advertising.</p>

<h2>Who else handles your data</h2>
<ul>
  <li><b>Cloudflare</b> hosts the site and keeps the database and photos, runs the bot check on forms and the AI model that fills in the add form.</li>
  <li><b>Google</b> handles sign in with Google, and serves the fonts the pages use.</li>
  <li><b>Manyfold</b> runs the AI helper that answers Ask.</li>
  <li><b>OpenFreeMap and OpenStreetMap</b> supply the map. <b>Photon</b> searches addresses you type when adding a pop-up.</li>
</ul>
<p>We do not sell your data and we do not show ads. Spotted London's use of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements.</p>

<h2>What other people can see</h2>
<p>Pop-ups, photos and vote totals are public. The name you choose and your karma can show next to a pop-up you added. Your email address is never shown to anyone.</p>

<h2>Your choices</h2>
<ul>
  <li><b>Sign out</b> from the Me page. It also clears your For you picks from that device.</li>
  <li><b>Delete your account</b> by emailing <a href="mailto:${PRIVACY_CONTACT}">${PRIVACY_CONTACT}</a> from the address on the account. We remove your email, name and saved list and stop you signing in. Pop-ups you added stay on the site without your name, because other people have voted on them.</li>
  <li><b>See or correct what we hold</b> about you, or ask for a photo of yours to come down: email the same address.</li>
</ul>

<h2>Children</h2>
<p>Spotted London is not made for children under 13 and we do not knowingly collect their data.</p>

<h2>Changes</h2>
<p>If this changes in a way that matters, the date at the top changes too.</p>
`;
