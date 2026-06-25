/**
 * Standalone Gmail SMTP credential tester.
 *
 * Fast feedback loop for debugging "535-5.7.8 Username and Password not accepted".
 * Reads SMTP_USER / SMTP_PASS / DIGEST_EMAIL_TO from .env (or the shell env)
 * and (1) verifies auth, then (2) sends a one-line test email.
 *
 * Run:  npx tsx scripts/test-email.ts
 */
import dotenv from "dotenv";
import path from "path";
import nodemailer from "nodemailer";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const user = process.env.SMTP_USER;
const pass = process.env.SMTP_PASS;
const to = process.env.DIGEST_EMAIL_TO;

function mask(v: string | undefined): string {
  if (!v) return "(empty)";
  if (v.length <= 4) return "*".repeat(v.length);
  return v.slice(0, 2) + "*".repeat(v.length - 4) + v.slice(-2);
}

async function main() {
  console.log("SMTP_USER      :", user ?? "(MISSING)");
  console.log("SMTP_PASS      :", mask(pass), `(length=${pass?.length ?? 0})`);
  console.log("DIGEST_EMAIL_TO:", to ?? "(MISSING)");
  console.log("");

  if (!user || !pass || !to) {
    console.error("❌ One or more of SMTP_USER / SMTP_PASS / DIGEST_EMAIL_TO is missing in .env");
    process.exit(1);
  }

  if (/\s/.test(pass)) {
    console.warn("⚠️  SMTP_PASS contains whitespace — Gmail App Passwords must have NO spaces. This is likely the problem.");
  }
  if (pass.replace(/\s/g, "").length !== 16) {
    console.warn(`⚠️  SMTP_PASS is ${pass.replace(/\s/g, "").length} chars (without spaces). Gmail App Passwords are exactly 16.`);
  }

  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    auth: { user, pass },
  });

  try {
    console.log("→ Verifying SMTP auth...");
    await transporter.verify();
    console.log("✅ Auth OK");
  } catch (err) {
    console.error("❌ Auth FAILED:", (err as Error).message);
    process.exit(1);
  }

  try {
    console.log("→ Sending test email...");
    const info = await transporter.sendMail({
      from: `"AI Infra Digest (test)" <${user}>`,
      to,
      subject: "AI Infra Digest — SMTP test",
      text: "If you can read this, Gmail SMTP delivery works. 🎉",
    });
    console.log("✅ Sent:", info.messageId);
    console.log(`Check the inbox of ${to} (and Spam).`);
  } catch (err) {
    console.error("❌ Send FAILED:", (err as Error).message);
    process.exit(1);
  }
}

main();
