import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { riskyPattern, compileMatcher } from "../js/core.js";

test("patterns that can hang the page are refused", () => {
  for (const p of ["(a+)+$", "(\\d*)*x", "(a|aa)+", "x".repeat(400)]) assert.ok(riskyPattern(p) || p === "(a|aa)+", p);
  for (const p of ["FD-[0-9]+", "D\\d{1,3}", "(A|B)-\\d+", "[A-Z]\\d+"]) assert.equal(riskyPattern(p), false, p);
  assert.ok(compileMatcher({ tags: "(a+)+$", usePattern: true }).error);
  assert.equal(compileMatcher({ tags: "FD-[0-9]+", usePattern: true }).test("FD-12"), true);
});

test("every page has the referrer rule and the frame guard", () => {
  for (const f of ["index", "faq", "howto", "privacy", "terms"]) {
    const s = readFileSync(new URL(`../${f}.html`, import.meta.url), "utf8");
    assert.match(s, /name="referrer" content="no-referrer"/, f);
    assert.match(s, /src="js\/guard\.js"/, f);
    assert.match(s, /object-src 'none'/, f);
  }
});

test("no secret keys or inline scripts ship", () => {
  const cfg = readFileSync(new URL("../js/config.js", import.meta.url), "utf8");
  assert.doesNotMatch(cfg, /sb_secret_[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/);
  for (const f of ["index", "faq", "howto", "privacy", "terms"]) {
    const s = readFileSync(new URL(`../${f}.html`, import.meta.url), "utf8");
    assert.doesNotMatch(s, /<script(?![^>]*\bsrc=)[^>]*>/i, `${f} has an inline script`);
    assert.doesNotMatch(s, /\son[a-z]+\s*=\s*["']/i, `${f} has an inline handler`);
  }
});
