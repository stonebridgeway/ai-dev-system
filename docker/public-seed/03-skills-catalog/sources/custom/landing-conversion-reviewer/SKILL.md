---
name: landing-conversion-reviewer
description: "Use when Codex reviews or improves a landing page, marketing page, product page, portfolio, pricing page, onboarding page, or hero section for clarity, trust, conversion, SEO basics, and mobile readability."
---

# Landing Conversion Reviewer

## Overview

Use this skill to make landing pages clearer, more credible, and more likely to convert without making them manipulative. It covers structure, copy, visual hierarchy, proof, CTAs, forms, SEO basics, and mobile behavior.

Use it for new landing pages, redesigns, hero sections, SaaS/product pages, pricing pages, lead-gen pages, waitlists, portfolios, app launch pages, and conversion-focused reviews. Pair it with `design-taste-frontend`, `image-to-code`, or `redesign-existing-projects` when implementation or premium visual direction is required.

## First Read

Before critiquing or editing, identify:

- offer: what is being sold, promised, or requested;
- audience: who should act and what they already believe;
- conversion goal: signup, purchase, call, demo, waitlist, download, contact, subscribe;
- traffic temperature: cold, warm, returning, paid ad, organic, referral;
- brand constraints: tone, visual system, claims, legal limits, assets;
- proof available: screenshots, metrics, testimonials, logos, case studies, demos, founder credibility.

If any of these are unknown, infer cautiously from the page and state assumptions.

## Design Intelligence

For a new landing page or a substantial approved redesign, call `generate_ui_ux_design_system` with
the offer, audience, industry, traffic context, trust constraints, and desired tone. Use
`query_ui_ux_knowledge` with the `landing`, `typography`, `color`, or `ux` domain for focused
follow-up questions.

Keep one direction. Reconcile generated recommendations with real product media, approved brand
assets, proof, existing components, and the actual conversion goal. A generated recommendation is
not conversion evidence and does not replace browser review.

## Conversion Review

Review in this order:

1. Above the fold:
   - the visitor can understand the offer in a few seconds;
   - headline says what it is or what outcome it creates;
   - subcopy explains who it is for and why it matters;
   - primary CTA is visible and specific;
   - supporting visual shows the real product, result, or state when possible.
2. Trust:
   - proof appears before major commitment;
   - claims are specific and believable;
   - testimonials, logos, metrics, screenshots, or examples are real and not invented;
   - pricing, limitations, guarantees, or next steps are not hidden.
3. Objections:
   - page answers "why this", "why now", "why trust", "what happens next", and "what if it is not for me";
   - FAQ or comparison handles real friction, not filler.
4. Flow:
   - sections build a clear argument;
   - the page has one primary conversion path;
   - secondary CTAs do not compete with the main action;
   - repeated CTAs appear after value or proof, not randomly.
5. Mobile:
   - hero is readable without awkward wrapping;
   - CTAs are reachable;
   - forms are short and usable;
   - sticky elements do not cover content.

## Page Architecture

Use the structure that fits the offer. A strong default:

1. Hero: clear offer, audience, outcome, CTA, visual proof.
2. Problem or moment: why the current situation hurts.
3. Value: what changes after using the product/service.
4. Product or method: concrete features, workflow, screenshots, demo, or process.
5. Proof: testimonials, data, before/after, case study, logos, credentials.
6. Differentiation: why this is better or more relevant than alternatives.
7. Pricing or commitment: cost, plan, timeline, next step, risk reversal.
8. FAQ: objections and practical details.
9. Final CTA: repeat the core offer and next action.

Do not force every section into every page. Short pages should still have clarity, proof, and a next step.

## Copy Rules

- Prefer concrete outcomes over vague adjectives.
- Replace generic claims like "next generation" with specific value.
- Use the customer's words when known.
- Keep one idea per section.
- Make CTA copy action-specific: "Book a demo", "Start free", "Join waitlist", "Get audit".
- Use bullets for scan speed, but keep them meaningful.
- Do not invent fake metrics, customers, testimonials, awards, certifications, or scarcity.
- Do not use dark patterns, forced urgency, hidden costs, or misleading risk reversal.

## SEO And Semantics

Cover basics without turning the page into keyword paste:

- one clear H1;
- meaningful H2/H3 structure;
- descriptive title and meta description when the codebase exposes them;
- image alt text that describes useful content;
- crawlable text for core value props;
- canonical URL and Open Graph metadata when relevant;
- internal links for product/docs/blog/pricing when useful;
- schema only when it matches real content.

## Implementation Review

When editing code:

- use existing design system, components, tokens, and content patterns;
- keep the first viewport strong, but leave the next section hinted when possible;
- avoid card-in-card layouts and generic AI-looking gradient blobs;
- use real product imagery, screenshots, generated section references, or purposeful media when visual proof matters;
- verify desktop and mobile in browser;
- ensure buttons, forms, and tracking hooks still work.

## Output

For review-only tasks:

```text
Priority findings:
- [P1/P2/P3] issue, why it hurts conversion, concrete fix

Recommended page flow:
- ...

Copy/CTA suggestions:
- ...

Verification gaps:
- ...
```

For implementation tasks, finish with changed files, checks run, browser viewports verified, and remaining risks.

## Guardrails

- Do not pretend to have conversion data unless analytics were actually provided.
- Do not invent social proof.
- Do not optimize persuasion at the cost of accessibility, truthfulness, or user trust.
- Do not make a marketing page when the user asked for an app/tool first screen.
- Do not use manipulative urgency, hidden opt-outs, or misleading scarcity.
- Do not invent product positioning, proof, or visual authority from generated design-system output.
