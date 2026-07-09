// Outbound email delivery (data-model §6, todo: Email & notifications).
// Domain code enqueues email_events (see notifications.ts); this service
// drains the queue through a Mailer. Success stamps sent_at, failure counts
// an attempt and alerts loudly — after 3 attempts storage stops offering the
// event, so a broken address can never wedge the queue.

import nodemailer from 'nodemailer';
import type { Storage } from '../storage/interface.js';
import { renderMarkdown } from './markdown.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string; // rendered from the markdown body at delivery (#16)
  from?: string; // per-group sender snapshot (#16); absent = mailer default
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export interface DeliverOptions {
  limit?: number; // batch size, default 50
  alert?: (message: string) => void;
}

export interface DeliverReport {
  sent: number;
  failed: number;
}

/** Deliver one batch of pending emails; a failure never stops the batch. */
export async function deliverEmails(
  storage: Storage,
  mailer: Mailer,
  nowIso: string,
  opts?: DeliverOptions,
): Promise<DeliverReport> {
  const alert = opts?.alert ?? console.error;
  const report: DeliverReport = { sent: 0, failed: 0 };
  for (const event of await storage.pendingEmails(opts?.limit ?? 50)) {
    try {
      // Multipart (#16): the stored markdown source is the text part, its
      // rendering the html part — markdown-it's escaping applies here.
      const message: MailMessage = {
        to: event.toEmail,
        subject: event.subject,
        text: event.body,
        html: renderMarkdown(event.body),
      };
      if (event.fromEmail !== undefined) message.from = event.fromEmail;
      await mailer.send(message);
      await storage.markEmailSent(event.id, nowIso);
      report.sent += 1;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      await storage.markEmailFailed(event.id, message);
      alert(
        `EMAIL DELIVERY FAILED to ${event.toEmail} (${event.kind}, attempt ${event.attempts + 1}): ${message}`,
      );
      report.failed += 1;
    }
  }
  return report;
}

/** Real SMTP transport; nodemailer accepts the smtp:// URL directly. */
export function createSmtpMailer(smtpUrl: string, from: string): Mailer {
  const transport = nodemailer.createTransport(smtpUrl);
  return {
    async send(message: MailMessage): Promise<void> {
      await transport.sendMail({
        from: message.from ?? from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html !== undefined ? { html: message.html } : {}),
      });
    },
  };
}

/** Wall-clock wiring, like startScheduler: real deployments call this at boot. */
export function startEmailDelivery(
  storage: Storage,
  mailer: Mailer,
  intervalMs = 30_000,
): () => void {
  const timer = setInterval(() => {
    deliverEmails(storage, mailer, new Date().toISOString()).catch((err: unknown) => {
      console.error('email delivery failed', err);
    });
  }, intervalMs);
  return () => clearInterval(timer);
}
