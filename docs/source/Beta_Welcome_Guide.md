# Beta Program Welcome Guide

For executive sponsors and operations stakeholders at companies enrolled in the Equipment Hub Connected Worker Platform Beta. Read this once at kickoff. Reference it through the 90-day program.

---

## Welcome

You've been selected as one of five companies for the 90-day Equipment Hub beta. The goal is mutual learning: you get a fully configured Connected Worker Platform deployed on real equipment in your facility, and we get the field feedback we need to ship a generally available product later this year.

This guide walks through what you're getting, what we're asking in return, and how to get the most out of the next 90 days.

---

## What you're getting (all included, no charge during beta)

| Deliverable | Detail |
|-------------|--------|
| Tenant setup | Full configuration of your tenant in our system, including branding |
| Content authoring | One major equipment line authored by SANTECH — manuals sectioned, parts linked, procedures structured |
| Branded QR labels | Up to 200 custom-branded stickers, printed and shipped to your site |
| AI chat | Up to 5,000 messages/month, grounded on your authored content with safety-doc guardrails |
| Customer success | Dedicated SANTECH contact + weekly 30-minute check-ins |
| Onboarding | One 2-hour Zoom session for your technicians and operations team |

**Estimated value of included services: ~$25,000.** This is real, and it's free for the duration of the beta.

---

## What we're asking from you

This is a structured beta, not a free service. To get the most out of the program — and to give us the field feedback that makes the product better — we need a few specific commitments from your side.

| Commitment | Detail |
|------------|--------|
| Deploy QR codes within 30 days | At least 50 real assets at one site |
| Active technician usage | At least 5 named technicians using the platform |
| Weekly feedback | A 30-minute call OR async written report — your choice |
| Logo + reference rights | Your logo on our website + an anonymous quote at end of program |
| Designate decision-maker | Named executive who can sign a paid contract at day 90 |
| Day-90 decision | Convert to founding-member pricing OR accept tenant deactivation |

---

## Who does what

**SANTECH (us):**
- Authors your initial content from existing OEM manuals
- Configures your tenant, brand, and QR templates
- Prints and ships QR stickers to your site
- Provides weekly support during the program
- Handles all platform operations and uptime

**Your team:**
- Provides source manuals or PDFs for the equipment line we'll author
- Identifies the 50+ assets where QRs will be deployed
- Names the technicians who will use the platform
- Designates an executive sponsor and a maintenance-side champion
- Deploys the QR stickers (peel-and-stick on the equipment)
- Engages with weekly feedback loops

The split is deliberate. We do the technical setup; you do the field deployment. Both are needed.

---

## Timeline

The program runs in three phases over roughly 120 days:

### Phase 1 — Recruit and onboard (weeks 0-2)
- Sign beta agreement
- Scope the equipment line we'll author
- Configure tenant, brand, QR template

### Phase 2 — Author and ship (weeks 3-7)
- SANTECH authors content (uses S25 library where applicable)
- QR stickers printed and shipped
- Tenant goes live for testing
- 2-hour Zoom onboarding for technicians

### Phase 3 — Active beta (weeks 8-20)
- Technicians deploy QR stickers to assets
- Real-world usage begins
- Weekly feedback loops
- Mid-program review at week 12 (we deliver the paid proposal here, on purpose — gives procurement 12 weeks to review)
- Final review at week 21

### Decision point (week 22)
- Convert to paid (founding-member pricing) or exit

### Transition (weeks 23-26)
- Convert seamlessly OR tenant transitions to read-only and then deactivates

---

## What founding-member pricing looks like

If you choose to convert at day 90:

- **50% off list price for 24 months**
- **Price locked** even when list pricing rises
- **Tenant continues seamlessly** — no data loss, no QR re-stickering, no retraining
- **Authoring services available at standard rates** for expansion beyond beta scope

Beta participants who don't convert: your tenant goes read-only on day 91, you have 30 days to export your data, and the tenant deactivates on day 121. **The QR stickers stay live as long as any participant in the equipment ecosystem (OEM or integrator) maintains a paid tenant** — so even if you don't convert, your equipment may stay covered through an OEM relationship.

---

## Data ownership and privacy

Clear and simple:

- **Your operational data** (work orders, technician usage, audit logs, photos) belongs to you. Exportable on request, anytime.
- **Your authored content overlays** (site-specific notes, internal SOPs you add) belong to you.
- **Base OEM content** that SANTECH authored from existing manuals stays in the platform's library — but it's the OEM's content, not yours.
- **No tenant data is ever shared with another tenant.** Multi-tenant isolation is enforced at the API layer.
- **No PII in QR codes.** A QR code is just an opaque short code that the platform resolves server-side.
- **Microsoft Entra ID** (your existing Microsoft tenant) is the only authentication path during beta. Generic OIDC and SAML are on the roadmap for general availability.

A formal Data Processing Agreement is available on request.

---

## How to give feedback

Three channels, in increasing order of urgency:

1. **In-app feedback widget** — top-right of every PWA screen, speech-bubble icon. Best for "I noticed this small thing" or "wishes I had." Goes straight to the SANTECH beta team.
2. **Weekly check-in** — 30-minute call with your customer success contact. Best for "let me walk through something with you" or "we need to talk about the roadmap."
3. **Critical issues** — email `beta@equipmenthub.io` or call/text your direct contact. Best for "the platform is broken right now" or "we have a security concern."

Every piece of feedback gets a response within 1 business day. Bugs get a fix or a workaround within 5 business days. We commit to this in writing because the beta only works if you trust the loop.

---

## Who to contact

- **Customer success / day-to-day:** Your assigned SANTECH contact (see beta agreement cover page)
- **Critical issues:** `beta@equipmenthub.io` + the phone number on your beta agreement
- **Pricing or conversion conversations:** Will be routed through your customer success contact starting at week 12
- **Legal / DPA / contract changes:** `legal@santechservices.com`
- **Public website:** `https://equipmenthub.io`

---

## What success looks like — for both of us

For your operations team, success in 90 days looks like:

- Technicians scanning QR codes daily without prompting
- Work orders being filed faster and with better evidence (photos, descriptions)
- Procedure runs being completed with full audit trail (vs. paper checklists)
- AI chat answering common questions instead of techs paging the senior maintainer
- Measurably faster MTTR or first-time-fix rate (we'll measure this together)

For our team, success looks like:

- Real usage data on every feature
- A working understanding of where the platform breaks under field conditions
- Direct feedback from technicians and maintenance managers (not just executives)
- A signed conversion at day 90 with founding-member pricing locked in

---

## What's *not* included in beta scope

Some features will come later. Specifically:

- **CMMS webhook integration** (Maximo, UpKeep, Fiix) — not in beta; available at general availability or via custom contract
- **SAML / generic OIDC SSO** — Microsoft Entra ID only during beta
- **SOC 2 Type I audit artifacts** — roadmap for Q1 2027
- **Multi-region deployment** — single US region during beta
- **Native mobile app** — PWA only; native app on roadmap for late 2026

These limitations are explicit in your beta agreement to keep the program scope honest. If any of these are a hard requirement for your conversion decision, please flag that to your customer success contact at week 1, not week 22.

---

## Final word

The beta program is a small bet on both sides. We're investing real authoring labor and platform access in your company; you're investing your team's time and feedback. The shared goal is to ship a product that actually works in MHI environments, validated against real field use — not just lab demos.

Thanks for being one of the first five. Looking forward to a productive 90 days.

— The SANTECH team
