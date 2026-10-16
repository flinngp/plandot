# Plandot launch checklist (things only the owner can confirm)

This file is for you, not for the website. Tick things off before Fieldwire testers or customers sign in.

## Legal (have a UK solicitor read terms.html and privacy.html; they are drafts, not legal advice)
- [ ] **Hilti**: written answer on IP and outside work before staff or customers use Plandot.
- [ ] **ICO data protection fee**: a person or business that handles personal data usually has to register and pay (about £40 a year for the smallest tier). Check at ico.org.uk/fee-checker. Add your registration number to the privacy notice once you have it.
- [ ] **Privacy contact**: a form is a weak contact for data requests. Create an address such as privacy@plandot.uk and put it in privacy.html and terms.html.
- [ ] **Supabase region**: Project Settings > General shows the region. Choose London or an EU region (new projects: pick it at creation; an existing project must be recreated to move). Make sure privacy.html matches the region.
- [ ] **Data processing terms (DPA)** with Supabase (and Resend if you add it): accept the DPA in each dashboard (Supabase: Organization settings > Legal documents).
- [ ] **Records**: keep a short written record of what you process, why, and who your processors are (Article 30 record, a one-page table is enough).
- [ ] **Breach plan**: if personal data is exposed you must tell the ICO within 72 hours. Know who you would tell and how.
- [ ] **Trademarks**: Plandot says it is independent of Fieldwire/Hilti; keep it that way unless they agree otherwise.

## Supabase settings (dashboard)
- [ ] Authentication > Providers > Email: keep **Enable Email provider** on, and **Confirm email** on.
- [ ] Authentication > URL Configuration: **Site URL** `https://plandot.uk`; add no other redirect URLs.
- [ ] Authentication > Providers > Email: **Email OTP expiration** 600 seconds or less; length 6.
- [ ] Authentication > Rate limits: see the email limit section below.
- [ ] Authentication > Attack protection: turn on **CAPTCHA** (Cloudflare Turnstile, free). Tell me when it is on and I will add the widget to the sign-in box (the code needs a small change; it will not work until then, so switch it on only after I have built it).
- [ ] Project Settings > API: leave **Exposed schemas** as `public` only.
- [ ] Database > Extensions: disable ones you do not use.
- [ ] Settings: turn on **two-step sign-in (2FA) on your Supabase account and your GitHub account**.
- [ ] Database > Backups: on the Pro plan, daily backups are included; note that deleted accounts remain in backups until they expire.
- [ ] Pro plan stops a free project pausing after a week of no use.

## GitHub settings (repo > Settings)
- [ ] Security > Code security: turn on **Dependabot alerts**, **Dependabot security updates**, **Secret scanning** and **Push protection**, and **Private vulnerability reporting**.
- [ ] Branches: protect `main` (require a pull request, block force pushes).
- [ ] Pages: tick **Enforce HTTPS**.
- [ ] Check your clone's history for leaked secrets once: `git log -p | grep -iE "secret|service_role|sb_secret"`. The only key ever committed should be the publishable one.

## Keys
- The publishable key in `js/config.js` is meant to be public. It cannot be hidden on a static site, and it is safe because the database rules (row-level security) decide what anyone can do. Never put a secret or `service_role` key in the repo; the page refuses to start if you do.

## Email sending limit (see the answer in chat)
- [ ] Add a custom SMTP sender (Resend) under Authentication > Emails > SMTP Settings, verify plandot.uk in Resend with the DNS records it gives you, then raise the limit under Authentication > Rate Limits.

## Bot check on sign-in (Cloudflare Turnstile)
1. Sign in at dash.cloudflare.com (free), open **Turnstile**, choose **Add widget**. Name it Plandot, add the hostnames `plandot.uk` and `www.plandot.uk`, widget mode **Managed**.
2. Cloudflare shows a **Site key** (public) and a **Secret key** (private).
3. In Supabase: **Authentication, Attack Protection**, turn on **Enable CAPTCHA protection**, choose **Cloudflare Turnstile**, paste the **Secret key**, save. Never share the secret key with anyone, including Claude.
4. In `js/config.js` set `export const CAPTCHA = { siteKey: "<your site key>" };` then commit and push.
5. Test: sign in on plandot.uk. Do step 3 and 4 together, because with CAPTCHA on in Supabase but no site key on the page, sign-in stops working.
