# Equipment Hub — Frequently Asked Questions

Answers to common questions from beta participants. Updated through the program.

---

## General

### What is Equipment Hub?

A Connected Worker Platform purpose-built for material handling and industrial automation. Technicians scan a QR sticker on a piece of equipment, and instantly see the right manual, the right parts list, the right procedure, and the right training for *that specific machine.*

### What problem does it solve?

Three at once:
1. **Documentation discovery** — techs spend less time hunting for the right manual
2. **Aftermarket parts** — OEM-branded parts catalogs route orders back to the OEM (instead of leaking to third-party distributors)
3. **Compliance and training** — full audit trail of who scanned what, when, and what they did

### Who's behind it?

SANTECH Services — a documentation services firm that's been authoring OEM manuals for 20+ years. The Equipment Hub platform is built on top of that authoring expertise.

### Who else is using it during beta?

Five participants total: one anchor integrator (DMW&H), one peer integrator, and three OEMs whose equipment is widely used in MHI sortation systems. Each beta tenant is fully isolated — no participant can see another participant's data.

---

## For technicians

### Do I need to install an app?

No. Equipment Hub is a Progressive Web App — it runs in your phone's browser. Scan the QR with the built-in camera (iOS Camera app, Android Google Lens, or any QR reader).

### Will it work on my phone?

If you have a phone made in the last 4-5 years (iOS 15+ or Android 10+), yes. Modern Chrome, Safari, Edge, and Firefox are all supported.

### Will it work without signal?

Mostly. Recently viewed manuals and pages are cached and remain available offline. Reporting a new work order while offline is queued and submitted when signal returns. AI chat requires signal because it's calling a live model.

### Do I have to log in?

No. The QR scan creates a short-lived session (8 hours) tied to the specific QR code. No password, no login screen, no PII collected.

### Can I share a link to a manual with a coworker?

QR links are scoped to the scan session for security. If you share `equipmenthub.io/a/<code>` with a coworker, they'll see a "Scan Required" message. They need to scan the physical sticker themselves. This protects against shared URLs being abused.

### What happens if I scan a sticker that doesn't have content yet?

You'll see "No documents available for this asset" with a helpful empty state. The asset still exists; the OEM/integrator just hasn't authored content for it yet. Tap **Send feedback** (top-right) to let us know.

### Why does the AI sometimes refuse to paraphrase a procedure?

Safety-critical procedures (lockout/tagout, electrical work, mechanical stops) are quoted **verbatim** from the OEM manual. The AI will refuse to summarize or paraphrase these because a wrong-by-one-step rephrasing of LOTO can hurt someone. Read the quoted text carefully.

### Can I ask the AI in Spanish / French / etc.?

Yes — the AI responds in whatever language you ask in. The source content is in the language the OEM authored it in (usually English for North American manuals).

---

## For administrators / sponsors

### Who authors the content during beta?

SANTECH does. The audit found that beta participants don't get admin access during the program — that's a deliberate design choice. SANTECH's documentation team handles the authoring, you handle the field deployment.

### Can I see what techs are scanning?

Not during beta — analytics dashboards are SANTECH-internal during the program. We share the relevant numbers with your sponsor in weekly check-ins. Self-service analytics for tenants are on the roadmap for general availability.

### Can my team add their own internal SOPs as overlays?

Not during beta. Site-specific overlay authoring is a paid-tier feature available at conversion. SANTECH can author overlays as a one-time service if needed during the beta — flag this to your customer success contact.

### What's the conversion path?

At day 90:
- **Convert** to paid: founding-member pricing (50% off list for 24 months, locked rate)
- **Exit**: tenant goes read-only on day 91, deactivates on day 121

The decision and pricing conversation starts at **week 12**, not week 22, to give your procurement team a realistic timeline.

---

## Privacy and security

### Where is the data hosted?

US East region (Fly.io for the API, Vercel for the frontend, Cloudflare R2 for content storage, Neon Postgres for relational data). All providers offer SOC 2 Type II compliance. Multi-region availability is a paid-tier feature on the roadmap.

### Is the data encrypted?

In transit (TLS 1.3) and at rest (provider-level disk encryption). Specific QR-scan session tokens are HMAC-signed.

### Who can access my tenant's data?

Only your authorized users (during beta, this is just the SANTECH team and any technicians you've named). Multi-tenant isolation is enforced at the API layer — every request is scoped to the calling tenant's organization ID.

### Do you sell data?

No. We don't sell, share, or analyze your data for any purpose other than running your tenant. We do collect anonymized aggregate metrics (e.g., "across all tenants, average scans per QR per week") for product improvement.

### Can I get a Data Processing Agreement (DPA)?

Yes. Email `legal@santechservices.com` and we'll send the standard DPA. We're happy to negotiate redlines for enterprise procurement.

### What about SOC 2 / ISO?

SOC 2 Type I audit is on the roadmap for Q1 2027. We're using Vanta for evidence collection. Most beta participants don't require SOC 2 to sign; if your procurement does, ask your customer success contact for a current status one-pager.

### Is there PII in the QR codes?

No. A QR code is an opaque alphanumeric short code (8-24 characters, no embedded data). The platform resolves it server-side to the asset. Codes can be revoked and re-issued without re-stickering — the platform handles redirection.

---

## Pricing

### What does it cost after the beta?

| Tier | Price | Best for |
|------|-------|----------|
| Integrator Pro | $42k/yr | Mid-size dealers/integrators (≤250 assets) |
| Integrator Enterprise | $90-120k/yr | Large integrators (≤1,000 assets) |
| OEM Specialty | $30-50k/yr | Smaller OEMs (≤1,000 fielded units) |
| OEM Standard | $60-100k/yr | Mid-size OEMs |
| OEM Major | $150-250k/yr | Top-tier OEMs |
| End-Customer Site | $80-150k/yr | Per facility |

**Beta participants get founding-member pricing: 50% off list for 24 months, locked rate.**

### Are there add-on costs?

A few, all metered:
- AI chat overage: $0.05/message beyond included pool
- Storage overage: $0.10/GB/month
- Authoring services: $15-25k per OEM manual; site-overlay authoring same range

### What if I want to expand to multiple sites?

Multi-site discounts kick in at 3+ sites. Talk to your customer success contact for custom pricing.

---

## Technical

### What browsers are supported?

Modern Chrome, Safari, Edge, Firefox. Internet Explorer is not supported. The platform is tested against the last 2 major versions of each browser.

### What about mobile devices?

iOS 15+ and Android 10+. Older devices may work but aren't tested.

### Does it integrate with our CMMS?

Not during beta. CMMS webhook integration (Maximo, UpKeep, Fiix) is on the roadmap for general availability or available as a custom integration.

### Can I export my data?

Yes. Email `beta@equipmenthub.io` and we'll provide a one-time export of your tenant's work orders, audit log, and procedure runs as JSON or CSV.

### What's the SLA during beta?

Best-effort 99% uptime. Incidents are reported on the status page. The current platform runs in a single region; latency from outside North America may be noticeable.

---

## Still have questions?

- **In-app:** Tap the speech-bubble icon (top-right of any screen)
- **Email:** `beta@equipmenthub.io`
- **Weekly call:** Bring it to your customer success check-in
