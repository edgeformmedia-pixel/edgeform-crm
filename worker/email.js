import { HttpError } from './lib.js';

// Sends through Resend when RESEND_API_KEY is set; otherwise falls back to the
// existing email worker so login codes keep flowing during the cutover.
export async function sendEmail(env, message) {
  try {
    return await deliver(env, message);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    console.error('email transport error', error);
    throw new HttpError(502, 'Email service is unreachable. Try again.');
  }
}

async function deliver(env, { from, to, subject, text, replyTo, attachments }) {
  from = from || env.MAIL_FROM;
  if (env.RESEND_API_KEY) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from, to: [to], subject, text,
        ...(replyTo ? { reply_to: replyTo } : {}),
        ...(attachments?.length ? { attachments } : {})
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new HttpError(502, `Email failed: ${data.message || res.status}`);
    return { id: data.id };
  }

  if (!env.EMAIL_WORKER_URL) throw new HttpError(500, 'Email is not configured.');
  const res = await fetch(env.EMAIL_WORKER_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from, to, subject, body: text, replyTo })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) throw new HttpError(502, `Email failed: ${data.error || res.status}`);
  return { id: data.id || null };
}
