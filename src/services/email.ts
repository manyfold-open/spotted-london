import type { Bindings } from '../types';

export interface Email { to: string; subject: string; text: string; html: string }

/**
 * Sends through Resend when RESEND_API_KEY is set.
 * Returns false when no provider is configured, so callers can fall back in development.
 */
export async function sendEmail(env: Bindings, msg: Email): Promise<boolean> {
  if (!env.RESEND_API_KEY) return false;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: env.EMAIL_FROM || 'Spotted London <hello@spotted.london>', to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html }),
  });
  if (!res.ok) {
    console.error('email send failed', res.status, await res.text().catch(() => ''));
    throw new Error('email_failed');
  }
  return true;
}

export function magicLinkEmail(link: string): Omit<Email, 'to'> {
  return {
    subject: 'Your Spotted London sign-in link',
    text: `Tap the link below to sign in to Spotted London. It works once and expires in 15 minutes.\n\n${link}\n\nIf you did not ask for this, you can ignore this email.`,
    html: `<div style="font-family:Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1d1b18">
  <h1 style="font-size:22px;margin:0 0 12px">Sign in to Spotted London</h1>
  <p style="font-size:15px;line-height:1.5;margin:0 0 20px">Tap the button to sign in. It works once and expires in 15 minutes.</p>
  <p style="margin:0 0 24px"><a href="${link}" style="display:inline-block;background:#1d1b18;color:#fffdf8;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:999px">Sign in</a></p>
  <p style="font-size:13px;color:#5e574c;margin:0">If you did not ask for this, you can ignore this email.</p>
</div>`,
  };
}
