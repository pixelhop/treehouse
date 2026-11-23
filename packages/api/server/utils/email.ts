import { ServerClient } from "postmark";

/**
 * Outbound transactional email, sent via Postmark.
 *
 * Lights up when its env is present: when `POSTMARK_SERVER_TOKEN` is set the message goes out through Postmark,
 * otherwise (local dev) it is logged to the server console so the flow is still
 * exercisable without a provider or secrets. `EMAIL_FROM` is the verified
 * Postmark sender signature.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

let cachedClient: ServerClient | null = null;

function postmarkClient(): ServerClient | null {
  const token = process.env.POSTMARK_SERVER_TOKEN;
  if (!token) return null;
  if (!cachedClient) cachedClient = new ServerClient(token);
  return cachedClient;
}

export async function sendEmail(message: EmailMessage): Promise<void> {
  const client = postmarkClient();

  if (!client) {
    // Dev fallback: no provider configured. Log enough to follow the link/flow
    // locally without sending anything.
    console.info(
      `[email] (not sent — POSTMARK_SERVER_TOKEN unset)\n  to: ${message.to}\n  subject: ${message.subject}\n  text: ${message.text}`,
    );
    return;
  }

  const from = process.env.EMAIL_FROM;
  if (!from) {
    throw new Error("EMAIL_FROM must be set when POSTMARK_SERVER_TOKEN is configured");
  }

  try {
    await client.sendEmail({
      From: from,
      To: message.to,
      Subject: message.subject,
      HtmlBody: message.html,
      TextBody: message.text,
      MessageStream: process.env.POSTMARK_MESSAGE_STREAM ?? "outbound",
    });
  } catch (error) {
    // Log the detailed Postmark error internally, but surface a generic message
    // so provider/config details never leak to the caller.
    console.error("Failed to send email via Postmark:", error);
    throw new Error("Failed to send email. Please try again later.");
  }
}

/** Escape a value for safe interpolation into HTML text/attribute context. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/** Reset-password email body. `url` is the better-auth reset link (carries the token). */
export function resetPasswordEmail(url: string): { subject: string; html: string; text: string } {
  const subject = "Reset your Treehouse password";
  const text = `Someone requested a password reset for your Treehouse account.

Reset your password using the link below (it expires in 1 hour):

${url}

If you didn't request this, you can safely ignore this email — your password won't change.`;
  // The link is built from a trusted (origin-checked) callbackURL, but escape it
  // anyway so a manipulated URL can't break out of the href / inject markup.
  const safeUrl = escapeHtml(url);
  const html = `<p>Someone requested a password reset for your Treehouse account.</p>
<p><a href="${safeUrl}">Reset your password</a> (this link expires in 1 hour).</p>
<p>If you didn't request this, you can safely ignore this email — your password won't change.</p>`;
  return { subject, html, text };
}
/** Verify-your-address email body. `url` is better-auth's verify-email link (carries the token). */
export function verifyEmailEmail(url: string): { subject: string; html: string; text: string } {
  const subject = "Confirm your email for Treehouse";
  const text = `Welcome to Treehouse.

Confirm this is your email address using the link below (it expires in 24 hours):

${url}

If you didn't create a Treehouse account, you can safely ignore this email.`;
  const safeUrl = escapeHtml(url);
  const html = `<p>Welcome to Treehouse.</p>
<p><a href="${safeUrl}">Confirm your email address</a> (this link expires in 24 hours).</p>
<p>If you didn't create a Treehouse account, you can safely ignore this email.</p>`;
  return { subject, html, text };
}