import { createTransport } from "nodemailer";

import { getTracer, withSpan } from "@saiye/shared-server";
import serverConfig from "@saiye/shared/config";
import { escapeHtml } from "@saiye/shared/utils/htmlUtils";

const tracer = getTracer("@saiye/trpc");

function buildTransporter() {
  if (!serverConfig.email.smtp) {
    throw new Error("SMTP is not configured");
  }
  return createTransport({
    host: serverConfig.email.smtp.host,
    port: serverConfig.email.smtp.port,
    secure: serverConfig.email.smtp.secure,
    auth:
      serverConfig.email.smtp.user && serverConfig.email.smtp.password
        ? {
            user: serverConfig.email.smtp.user,
            pass: serverConfig.email.smtp.password,
          }
        : undefined,
  });
}

type Transporter = ReturnType<typeof buildTransporter>;

type Fn<Args extends unknown[] = unknown[]> = (
  transport: Transporter,
  ...args: Args
) => Promise<void>;

interface TracingOptions {
  silentFail?: boolean;
}

function withTracing<Args extends unknown[]>(
  name: string,
  fn: Fn<Args>,
  options: TracingOptions = {},
) {
  return async (...args: Args): Promise<void> => {
    if (options.silentFail && !serverConfig.email.smtp) {
      return;
    }
    const transporter = buildTransporter();
    await withSpan(tracer, name, {}, () => fn(transporter, ...args));
  };
}

export const sendVerificationEmail = withTracing(
  "sendVerificationEmail",
  async (
    transporter: Transporter,
    email: string,
    name: string,
    token: string,
    redirectUrl?: string,
  ) => {
    let verificationUrl = `${serverConfig.publicUrl}/verify-email?token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`;
    if (redirectUrl) {
      verificationUrl += `&redirectUrl=${encodeURIComponent(redirectUrl)}`;
    }

    const mailOptions = {
      from: serverConfig.email.smtp!.from,
      to: email,
      subject: "Verify your email address",
      html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Welcome to Saiye, ${escapeHtml(name)}!</h2>
        <p>Please verify your email address by clicking the link below:</p>
        <p>
          <a href="${verificationUrl}" style="background-color: #007bff; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">
            Verify Email Address
          </a>
        </p>
        <p>If the button doesn't work, you can copy and paste this link into your browser:</p>
        <p><a href="${verificationUrl}">${verificationUrl}</a></p>
        <p>This link will expire in 24 hours.</p>
        <p>If you didn't create an account with us, please ignore this email.</p>
      </div>
    `,
      text: `
Welcome to Saiye, ${name}!

Please verify your email address by visiting this link:
${verificationUrl}

This link will expire in 24 hours.

If you didn't create an account with us, please ignore this email.
    `,
    };

    await transporter.sendMail(mailOptions);
  },
);

export const sendInviteEmail = withTracing(
  "sendInviteEmail",
  async (
    transporter: Transporter,
    email: string,
    token: string,
    inviterName: string,
  ) => {
    const inviteUrl = `${serverConfig.publicUrl}/invite/${encodeURIComponent(token)}`;

    const mailOptions = {
      from: serverConfig.email.smtp!.from,
      to: email,
      subject: "You've been invited to join Saiye",
      html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>You've been invited to join Saiye!</h2>
        <p>${escapeHtml(inviterName)} has invited you to join Saiye, the bookmark everything app.</p>
        <p>Click the link below to accept your invitation and create your account:</p>
        <p>
          <a href="${inviteUrl}" style="background-color: #007bff; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">
            Accept Invitation
          </a>
        </p>
        <p>If the button doesn't work, you can copy and paste this link into your browser:</p>
        <p><a href="${inviteUrl}">${inviteUrl}</a></p>

        <p>If you weren't expecting this invitation, you can safely ignore this email.</p>
      </div>
    `,
      text: `
You've been invited to join Saiye!

${inviterName} has invited you to join Saiye, a powerful bookmarking and content organization platform.

Accept your invitation by visiting this link:
${inviteUrl}



If you weren't expecting this invitation, you can safely ignore this email.
    `,
    };

    await transporter.sendMail(mailOptions);
  },
);

export const sendPasswordResetEmail = withTracing(
  "sendPasswordResetEmail",
  async (
    transporter: Transporter,
    email: string,
    name: string,
    token: string,
  ) => {
    const resetUrl = `${serverConfig.publicUrl}/reset-password?token=${encodeURIComponent(token)}`;

    const mailOptions = {
      from: serverConfig.email.smtp!.from,
      to: email,
      subject: "Reset your password",
      html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Password Reset Request</h2>
        <p>Hi ${escapeHtml(name)},</p>
        <p>You requested to reset your password for your Saiye account. Click the link below to reset your password:</p>
        <p>
          <a href="${resetUrl}" style="background-color: #007bff; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">
            Reset Password
          </a>
        </p>
        <p>If the button doesn't work, you can copy and paste this link into your browser:</p>
        <p><a href="${resetUrl}">${resetUrl}</a></p>
        <p>This link will expire in 1 hour.</p>
        <p>If you didn't request a password reset, please ignore this email. Your password will remain unchanged.</p>
      </div>
    `,
      text: `
Hi ${name},

You requested to reset your password for your Saiye account. Visit this link to reset your password:
${resetUrl}

This link will expire in 1 hour.

If you didn't request a password reset, please ignore this email. Your password will remain unchanged.
    `,
    };

    await transporter.sendMail(mailOptions);
  },
);

export const sendListInvitationEmail = withTracing(
  "sendListInvitationEmail",
  async (
    transporter: Transporter,
    email: string,
    inviterName: string,
    listName: string,
    listId: string,
  ) => {
    const inviteUrl = `${serverConfig.publicUrl}/dashboard/lists?pendingInvitation=${encodeURIComponent(listId)}`;

    const mailOptions = {
      from: serverConfig.email.smtp!.from,
      to: email,
      subject: `${inviterName} invited you to collaborate on "${listName}"`,
      html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>You've been invited to collaborate on a list!</h2>
        <p>${escapeHtml(inviterName)} has invited you to collaborate on the list <strong>"${escapeHtml(listName)}"</strong> in Saiye.</p>
        <p>Click the link below to view and accept or decline the invitation:</p>
        <p>
          <a href="${inviteUrl}" style="background-color: #007bff; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">
            View Invitation
          </a>
        </p>
        <p>If the button doesn't work, you can copy and paste this link into your browser:</p>
        <p><a href="${inviteUrl}">${inviteUrl}</a></p>
        <p>You can accept or decline this invitation from your Saiye dashboard.</p>
        <p>If you weren't expecting this invitation, you can safely ignore this email or decline it in your dashboard.</p>
      </div>
    `,
      text: `
You've been invited to collaborate on a list!

${inviterName} has invited you to collaborate on the list "${listName}" in Saiye.

View your invitation by visiting this link:
${inviteUrl}

You can accept or decline this invitation from your Saiye dashboard.

If you weren't expecting this invitation, you can safely ignore this email or decline it in your dashboard.
    `,
    };

    await transporter.sendMail(mailOptions);
  },
  { silentFail: true },
);
