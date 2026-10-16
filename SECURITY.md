# Security

Plandot runs in the browser. Drawings and templates are never uploaded. When sign-in is switched on, the only
things stored are an email address, a plan and saved rules (see `supabase/schema.sql`).

## Reporting a problem

Please do not open a public issue for a security problem. Either:

- use GitHub's "Report a vulnerability" button on the Security tab of this repository (private), or
- send a message through the feedback form linked from the site, and say that it is a security report.

Include what you found, how to reproduce it, and anything you think it exposes. You will get a reply as soon as
possible, and we will tell you when it is fixed.

## What is meant to be public

The project address and the public ("publishable" or "anon") key in `js/config.js` are meant to be seen by every
visitor. Access is controlled by the database rules in `supabase/schema.sql`, not by hiding those values.
A secret or `service_role` key must never be committed. The page refuses to start sign-in if it finds one.
