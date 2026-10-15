import { describe, expect, it } from 'vitest';
import { exports } from 'cloudflare:workers';
import { PRIVACY_CONTACT } from '../src/privacy';

describe('/privacy', () => {
  it('is plain HTML that anyone can read, names the contact and the Google data rules', async () => {
    const res = await exports.default.fetch(new Request('http://spotted.test/privacy'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const text = await res.text();
    expect(text).toContain('<h1>Privacy</h1>');
    expect(text).toContain(`mailto:${PRIVACY_CONTACT}`);
    expect(text).toContain('http://spotted.test');
    expect(text).toContain('Google API Services User Data Policy');
    expect(text).toContain('Limited Use');
  });

  it('keeps the numbers the code uses: 30 days for check-in coordinates, 7 days for Ask questions', async () => {
    const text = await (await exports.default.fetch(new Request('http://spotted.test/privacy'))).text();
    expect(text).toMatch(/coordinates for 30 days/);
    expect(text).toMatch(/question for 7 days/);
  });

  it('tells people they can delete their account from the Me page, where the button is', async () => {
    const text = await (await exports.default.fetch(new Request('http://spotted.test/privacy'))).text();
    expect(text).toContain('from the Me page (Delete account)');
  });

  it('uses no em dashes, en dashes or spaced hyphens (UI copy rule)', async () => {
    const text = await (await exports.default.fetch(new Request('http://spotted.test/privacy'))).text();
    const body = text.slice(text.indexOf('<h1>Privacy</h1>'));
    expect(body).not.toMatch(/[–—]| - /);
  });
});

describe('/privacy and Google Analytics', () => {
  it('says what Google Analytics collects, its cookies, and where to turn it off', async () => {
    const text = await (await exports.default.fetch(new Request('http://spotted.test/privacy'))).text();
    expect(text).toContain('Google Analytics, if you allow it.');
    expect(text).toContain('nothing goes to Google until you tap Allow');
    expect(text).toContain('<code>spotted_ga</code> and <code>spotted_ga_&lt;id&gt;</code>');
    expect(text).toContain('Google Analytics switch in the menu');
  });
});
