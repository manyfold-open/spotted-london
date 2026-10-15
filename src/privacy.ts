// The privacy policy, served as plain HTML by the Worker (no JavaScript needed, so Google's checks and crawlers read it).
// It says what the code does. When the code changes what it collects, keeps or shares, change this page in the same PR.

import { html } from 'hono/html';

export const PRIVACY_UPDATED = '15 October 2026';
export const PRIVACY_CONTACT = 'manyfoldai@gmail.com';

export const privacyBody = (origin: string) => html`
<h1>Privacy</h1>
<p class="meta">Last updated ${PRIVACY_UPDATED}</p>
<p>Spotted London (${origin}) lists pop-ups in London. It is run by the Manyfold team. This page says what we collect, why, who else sees it and how to get it removed. Questions: <a href="mailto:${PRIVACY_CONTACT}">${PRIVACY_CONTACT}</a>.</p>

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
  <li><b>Visitors.</b> To stop abuse we keep a salted, scrambled version of your IP address, never the address itself.</li>
  <li><b>Anonymous usage stats.</b> So we can see what people use and improve it, your browser sends small events: which page you opened, which pop-up you opened, saved, voted on or shared, which category, date or Saved filter you tapped, that you searched or asked a question (never the words), that you started to sign in, and the site you came from. Each one carries a random ID your browser makes up and keeps on your device, whether you were signed in (yes or no), a phone or desktop screen size, and your country. The ID is never linked to your account, email or IP address. Admins are not counted. We do not use these stats for advertising or share them. To stop them, turn off Anonymous usage stats on the Me page, turn on Do Not Track or Global Privacy Control in your browser, or clear this site's data.</li>
  <li><b>Google Analytics, if you allow it.</b> If you are in the UK, the EU, the EEA or Switzerland, or we cannot tell where you are, the map asks first, and nothing goes to Google until you tap Allow. Elsewhere it is on until you turn it off. It tells Google which pages and pop-ups you open (the address of the page without anything you typed, and the pop-up's title), how long you stay and how far you scroll, links you follow out of Spotted, the site you came from, and your browser, device, screen and rough location, which Google works out from your IP address. It is never told your account, email or name. Advertising features and Google signals are off. Google keeps the detailed records for at most 14 months; after that our reports hold only totals. To stop it, use the Google Analytics switch in the menu. It is also off for admins, when your browser sends Do Not Track or Global Privacy Control, and when Anonymous usage stats is off on the Me page.</li>
</ul>

<h2>Cookies and storage</h2>
<p>One cookie keeps you signed in for up to 30 days. If you allow Google Analytics, it sets two more, <code>spotted_ga</code> and <code>spotted_ga_&lt;id&gt;</code>, kept for 13 months, only for this site's pages; turning it off in the menu deletes them. Your browser also stores small settings on your device: saved pop-ups when signed out, your For you picks, whether you agreed to share your location, your answer about Google Analytics, a note about what you were doing when you were asked to sign in, and the random ID for the usage stats above. Nothing here is used for advertising.</p>

<h2>Who else handles your data</h2>
<ul>
  <li><b>Cloudflare</b> hosts the site and keeps the database and photos, runs the bot check on forms, runs the AI model that fills in the add form and stores the anonymous usage stats.</li>
  <li><b>Google</b> handles sign in with Google, serves the fonts the pages use and, if you allow it, runs Google Analytics for us. Google's own privacy policy is at <a href="https://policies.google.com/privacy">policies.google.com/privacy</a>.</li>
  <li><b>Manyfold</b> runs the AI helper that answers Ask.</li>
  <li><b>OpenFreeMap and OpenStreetMap</b> supply the map. <b>Photon</b> searches addresses you type when adding a pop-up.</li>
</ul>
<p>We do not sell your data and we do not show ads. Spotted London's use of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements.</p>

<h2>What other people can see</h2>
<p>Pop-ups, photos and vote totals are public. The name you choose and your karma can show next to a pop-up you added. Your email address is never shown to anyone.</p>

<h2>Your choices</h2>
<ul>
  <li><b>Turn Google Analytics on or off</b> with the switch in the menu, at any time. Your answer is kept on this device.</li>
  <li><b>Sign out</b> from the Me page. It also clears your For you picks from that device.</li>
  <li><b>Delete your account</b> from the Me page (Delete account), or by emailing <a href="mailto:${PRIVACY_CONTACT}">${PRIVACY_CONTACT}</a> from the address on the account. We remove your email, name and saved list and stop you signing in. Pop-ups you added stay on the site without your name, because other people have voted on them.</li>
  <li><b>See or correct what we hold</b> about you, or ask for a photo of yours to come down: email the same address.</li>
</ul>

<h2>Children</h2>
<p>Spotted London is not made for children under 13 and we do not knowingly collect their data.</p>

<h2>Changes</h2>
<p>If this changes in a way that matters, the date at the top changes too.</p>
`;
