import { config } from '../config.ts';
import { sendSmtp, type MailMessage } from './smtp.ts';

/**
 * Outbox for development: when SMTP isn't configured, emails are kept in
 * memory (and printed) so verification/reset links can still be used locally.
 * Exposed at GET /api/dev/outbox only when NODE_ENV !== 'production'.
 */
export const devOutbox: Array<MailMessage & { sentAt: string }> = [];

export const mailConfigured = () => !!config.smtp.host;

export async function sendMail(to: string, subject: string, text: string, html?: string) {
  const msg: MailMessage = { from: config.smtp.from, to, subject, text, html };
  if (!mailConfigured()) {
    if (config.isProd) throw new Error('SMTP is not configured (set SMTP_HOST).');
    devOutbox.unshift({ ...msg, sentAt: new Date().toISOString() });
    devOutbox.length = Math.min(devOutbox.length, 50);
    if (!config.isTest) console.log(`\n[mail:dev] To: ${to}\n[mail:dev] Subject: ${subject}\n${text}\n`);
    return;
  }
  await sendSmtp(config.smtp, msg);
}

const shell = (title: string, body: string, cta: { label: string; url: string }) => `<!doctype html>
<html><body style="margin:0;background:#f3f1ee;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#22201d">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 16px">
<table width="480" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;padding:32px">
<tr><td style="font-size:22px;font-weight:800;color:#e0663d;padding-bottom:16px">Parley</td></tr>
<tr><td style="font-size:18px;font-weight:700;padding-bottom:8px">${title}</td></tr>
<tr><td style="font-size:15px;line-height:1.5;padding-bottom:24px">${body}</td></tr>
<tr><td><a href="${cta.url}" style="display:inline-block;background:#e0663d;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">${cta.label}</a></td></tr>
<tr><td style="font-size:12px;color:#7a746c;padding-top:24px">If the button doesn't work, paste this link into your browser:<br>${cta.url}</td></tr>
</table></td></tr></table></body></html>`;

export function verificationEmail(to: string, username: string, token: string) {
  const url = `${config.appUrl}/verify-email?token=${encodeURIComponent(token)}`;
  return sendMail(
    to, 'Verify your Parley email',
    `Hi ${username},\n\nConfirm your email address for Parley by opening this link:\n${url}\n\nThe link expires in 24 hours. If you didn't create an account, ignore this email.`,
    shell('Confirm your email', `Hi ${username}, tap the button below to verify this address. The link expires in 24 hours.`, { label: 'Verify email', url }),
  );
}

export function passwordResetEmail(to: string, username: string, token: string) {
  const url = `${config.appUrl}/reset-password?token=${encodeURIComponent(token)}`;
  return sendMail(
    to, 'Reset your Parley password',
    `Hi ${username},\n\nSomeone (hopefully you) asked to reset your Parley password. Open this link to choose a new one:\n${url}\n\nThe link expires in 1 hour. If you didn't ask for this, you can ignore this email.`,
    shell('Reset your password', `Hi ${username}, use the button below to choose a new password. The link expires in 1 hour. If you didn't request this, ignore this email.`, { label: 'Choose new password', url }),
  );
}
