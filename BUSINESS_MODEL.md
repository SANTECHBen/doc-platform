# Connected Worker Platform — Business Model

A primer for understanding how this platform makes money, who pays for what, and why the business gets stronger over time. Grounded in the **FedEx Memphis Secondary 25 (S25)** sort-system project as the reference case.

---

## The one-paragraph pitch

We sell a platform that puts a QR sticker on every piece of warehouse-automation equipment so a technician can scan it and instantly see the right manual, the right parts list, the right procedure, and the right training for *that specific machine.* The business is durable because **three different parties pay us for different value from the same physical asset** — the OEM who built it, the integrator who installed it, and the end-customer who operates it. A single integration project — like FedEx Memphis S25 — becomes three layered revenue streams that compound across a 20-year equipment lifecycle.

---

## The reference project: FedEx Memphis Secondary 25

Throughout this document we use the **FedEx Memphis S25 sort system** as the worked example, because we already have ground truth on it:

- **End-customer:** FedEx Corporation, Memphis, TN
- **Integrator:** DMW&H (Fairfield, NJ)
- **Documentation:** Already authored by SANTECH (5 manuals: Operations & Maintenance, Operating Sequence, Program Documentation, HMI User, Operator Instruction)
- **Major subsystems and their OEMs:**

| Subsystem | OEM |
|-----------|-----|
| Cross-belt sorter | **Honeywell Intelligrated** |
| Flow splitter (ARB) | **Intralox** |
| Vision / scan tunnel cameras / scanners | **SICK** |
| Singulator + vision system | **Visicon (Vitronic)** |
| Power turn conveyors | **Transnorm** and **Flow Turn** |
| Transport conveyors / scan conveyor | **Talos** |
| Cargo scale | **Rice Lake (iQUBE indicator)** |
| Gear motors | **NORD** |
| AC motors | **Baldor** |
| PLCs, VFDs, HMIs | **Rockwell / Allen-Bradley** |
| Plow diverters, accumulation/buffering, runout sorters | DMW&H custom builds |

That's roughly **10-12 separately authored OEM content packages** plus DMW&H's integrator overlay, all wrapped around hundreds of physical asset instances on the Memphis floor.

---

## The three customers and why each pays

There are three types of customers, and they're paying us for fundamentally different things.

### 1. The Integrator (DMW&H)

**What they buy:** A productivity tool for their service organization across their entire project portfolio.

**Why they pay:** Service contracts are 30-40% margin while installs are 8-15%. Anything that makes service techs more productive — fewer truck rolls, faster MTTR, better first-time-fix rates — lets them either bid more competitively or pocket more margin. They pay because the platform pays for itself in fewer escalations and lower overtime.

**For DMW&H specifically:** They're a respected mid-size MHI integrator. They likely have 30-60 active service projects across their portfolio at any given time. Memphis S25 is one of those.

**Typical price:** $42k/yr (Pro, ≤250 assets) → $90-120k/yr (Enterprise, ≤1,000 assets) → custom above.

### 2. The OEM (Honeywell Intelligrated, Intralox, SICK, Visicon, Transnorm, Flow Turn, Talos, Rice Lake, etc.)

**What they buy:** Branded content distribution and aftermarket parts revenue capture across their entire installed fleet, regardless of which integrator installed it.

**Why they pay:** OEMs make thin margin selling equipment. The real money is in 15-20 years of parts, service, and consumables after the install. Right now most of that revenue leaks to third-party parts distributors (Grainger, Motion Industries, McMaster-Carr) because techs in the field don't know where to order genuine OEM parts. When every QR scan on an OEM's equipment routes to that OEM's authoritative parts catalog, recovered aftermarket revenue dwarfs the subscription cost.

**Typical price:**
- Specialty OEM (Flow Turn, Talos, Visicon): **$30-50k/yr**
- Mid-size OEM (Transnorm, Rice Lake): **$60-100k/yr**
- Major OEM (Honeywell Intelligrated, Intralox, SICK): **$150-250k/yr**

### 3. The End-Customer (FedEx)

**What they buy:** A single unified view of every piece of equipment in their facility, regardless of who built it or installed it, with full audit trails for compliance and competency tracking for safety.

**Why they pay:** FedEx Memphis is one of the largest sortation hubs in the world, with hundreds of pieces of equipment from dozens of vendors across decades of installations. Their in-house maintenance team needs unified documentation, OSHA / safety-compliance audit trails, and competency records for technician training. FedEx as an organization runs ~30 hubs of varying sizes, so a single-site signup is a foothold for an enterprise rollout.

**Typical price:** $80-150k/yr per major facility, with multi-site discounts for hub-level rollouts.

---

## How the S25 project becomes three revenue streams

Year-by-year revenue from FedEx Memphis S25 alone, assuming a realistic adoption curve:

| Year | Integrator (DMW&H) | OEM signups | End-Customer (FedEx) | Annual Total |
|------|--------------------|-------------|-----------------------|--------------|
| 1 | $42k subscription | — | — | **$42k** |
| 2 | $42k | Honeywell Intelligrated $150k | — | **$192k** |
| 3 | $42k | + Intralox $80k, SICK $120k | — | **$392k** |
| 4 | $42k → may roll off Memphis | + Transnorm $60k, Flow Turn $40k | FedEx Memphis $80k (handoff yr-1) | **$472k** |
| 5 | (rolls on other DMW&H projects) | + Visicon $40k, Talos $35k, Rice Lake $40k | FedEx Memphis $130k | **$615k** |
| 6 | — | All renewing with 5% escalators | FedEx Memphis $135k | **$650k+** |
| 7 | — | All renewing | FedEx Memphis $140k | **$680k+** |

**7-year total revenue from the S25 project alone: ~$3.0M+**, with $650k recurring ARR by year 7.

**Important:** SANTECH already authored the S25 manuals as paid services. That authoring is a **sunk cost** to us. Loading it onto the platform converts a one-time services payment into recurring SaaS revenue from three buyers — without any incremental authoring labor.

---

## The same physical asset, three legitimate buyers

A common worry is "isn't it weird that all three pay for the same Honeywell sorter?" It's not — they're paying for different rights and different value:

- **Honeywell Intelligrated (OEM)** pays for the right to distribute their authoritative content and capture aftermarket parts revenue across every Honeywell sorter in the field — at FedEx Memphis, at UPS Worldport, at Amazon fulfillment centers, everywhere.
- **DMW&H (Integrator)** pays for managing their service portfolio — work orders, technician productivity, project tracking.
- **FedEx (End-Customer)** pays for unified facility management, compliance audit trails, and in-house competency tracking.

If DMW&H lost the FedEx Memphis service contract to another integrator tomorrow, those Honeywell sorter assets move from DMW&H's tenant to the new integrator's tenant. Honeywell Intelligrated's revenue doesn't change. FedEx's eventual signup doesn't change. **The OEM layer is the durable annuity; the integrator layer rotates as service contracts change hands.**

---

## The library flywheel — why this business gets stronger over time

This is the most important strategic dynamic to understand.

### Year 1 — empty library

When the first integrator signs up, the OEM library is empty. Every project requires expensive authoring from scratch.

### What S25 gives us as a starter

S25 alone seeds the library with **10-12 of the most common MHI OEMs** (Honeywell Intelligrated, Intralox, SICK, Visicon, Transnorm, Flow Turn, Talos, Rice Lake, NORD, Baldor, Rockwell). These OEMs appear on virtually every major MHI sortation project in North America. So **S25 isn't just one project — it's a foundational library that makes every future integrator project cheaper to onboard.**

### Year 3 — library at 50% coverage

After 2-3 years and several more projects layered onto the S25 baseline, you've authored content for 20+ MHI OEMs. New integrator projects find 60-70% of their equipment already authored. Authoring services per project drop to **$30-60k**.

### Year 5 — library mature

50+ OEMs covered. New integrator projects pay only **$10-20k** for site-specific overlay work. Subscription becomes the bulk of integrator spend.

### What's happening underneath

Each OEM signup does three things at once:

1. Adds **recurring subscription revenue** (durable annuity)
2. **Removes per-project authoring cost** for every future integrator project that uses that OEM's equipment
3. Increases the **platform's value to all future customers** (network effect)

The result is a flywheel: more OEMs → easier integrator sales → more integrators → more OEM cross-sell opportunities → more OEMs.

---

## Pricing summary

### Subscription tiers

| Tier | Target customer | Asset cap | Price |
|------|-----------------|-----------|-------|
| **Integrator Starter** | Small dealer/integrator | 50 assets, 25 techs | $1,200/mo ($14.4k/yr) |
| **Integrator Pro** | Mid-size integrator | 250 assets, 100 techs | $3,500/mo ($42k/yr) |
| **Integrator Enterprise** | Large integrator (DMW&H sized) | 1,000 assets | $7,500-10,000/mo ($90-120k/yr) |
| **OEM Small** | Specialty OEM (Flow Turn, Talos, Visicon) | Unlimited assets, ≤1,000 fleet | $30-50k/yr |
| **OEM Standard** | Mid-size OEM (Transnorm, Rice Lake) | Unlimited, ≤5,000 fleet | $60-100k/yr |
| **OEM Major** | Top-tier OEM (Honeywell Intelligrated, Intralox, SICK) | Unlimited, unlimited fleet | $150-250k/yr |
| **End-Customer Site** | Single facility (FedEx Memphis) | Per-site, custom assets | $80-150k/yr per site |
| **End-Customer Enterprise** | Multi-site operator (FedEx all hubs) | Custom | Custom, $5k/site/mo floor |

### Services (one-time, per engagement)

| Service | Typical price | Margin |
|---------|---------------|--------|
| Per-OEM manual authoring (sectioning, parts linking) | $15-25k | 50-60% |
| Site-specific overlay authoring | $15-25k | 50-60% |
| Multi-manual project bundle (like S25's 5-manual set) | $80-200k | 50% |
| Onboarding & training | $5-15k | 70% |

### Add-ons (metered)

- AI chat overage: **$0.05/message** beyond included pool
- Storage overage: **$0.10/GB/mo** beyond included quota
- Onboarding agent runs: 5 included/mo, **$250 each** thereafter

---

## Cost structure — why margins stay high

The platform itself is cheap to operate at scale. The infrastructure cost barely scales with new customers because:

- Each new asset is one database row — kilobytes, not gigabytes.
- Content is stored once and served from edge CDN — adding more customers doesn't multiply storage.
- AI chat is the only real variable cost, and overage pricing covers heavy users.

A typical OEM at 2,000 fielded units paying $40k/yr generates roughly **$500/yr in actual platform costs** — meaning **~98% gross margin** at the unit level.

The real costs that scale are headcount: sales reps, customer success, content authors. Those grow with revenue and are controllable.

**Target gross margin at scale: 80-85%**, factoring in services revenue (lower margin) and content authoring labor.

---

## The S25 leverage move — converting authored content into platform IP

SANTECH has already invested significant authoring labor into S25 across 5 manuals. That labor was paid for once, by FedEx/DMW&H, as a services engagement.

**The leverage:** We can re-purpose the S25 authoring as the foundation of our platform's library — without doing new work — and use that content to:

1. **Pitch DMW&H** to subscribe to the platform: "Your S25 documentation is already structured; the platform makes it actually usable in the field."
2. **Pitch each OEM** (Honeywell, Intralox, SICK, etc.) to take ownership of their slice: "Your equipment is already authored from S25; sign up and own it across your full fleet for a fraction of new authoring cost."
3. **Pitch FedEx** to subscribe at the site level: "We already authored the manuals. Now your techs can use them via QR scan at every machine."

This turns a finite services engagement into a perpetual platform asset. The same authored content gets resold three times (and counting).

---

## Why this is a venture-scale business, not a niche tool

Three structural reasons the model compounds:

1. **Three-sided market with layered revenue.** Most B2B SaaS has one buyer. We have three buyers per asset, each paying for different value, with the OEM layer being a durable annuity that survives integrator turnover.

2. **Network effects from the OEM library.** Once 50+ MHI OEMs are on the platform, every new integrator project finds most of its equipment pre-authored. The platform becomes the de facto standard, not because we marketed it well but because the alternative is paying $150k+ to author from scratch.

3. **High switching cost from physical-world lock-in.** QR stickers are physically attached to equipment for 20 years. Audit logs, training records, work-order history, and procedure evidence are compliance assets that can't be casually migrated. Once a customer is on the platform, leaving is hard.

---

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| DMW&H tries to build their own internal tool | Stay ahead on AI/RAG, content library breadth, multi-tenant overlay complexity |
| FedEx refuses to pay at handoff, equipment goes "dark" | Tenant deactivation kills QR resolution; make handoff motion easy with discounted year-1; pursue OEM signups so content stays alive even if integrator/end-customer churns |
| Honeywell concerned about sharing content with competing integrators | Content licensing terms — OEM owns base layer; integrator overlays are per-tenant, not shared upstream |
| Big OEM (Honeywell, Daifuku) tries to build a competitor | Speed advantage; lock in mid-tier and specialty OEMs first; partner rather than compete |
| AI cost spike | Overage pricing built into contract; switch to cheaper models for routine queries |
| FedEx procurement requires SOC 2 / SAML SSO before they'll sign | Start SOC 2 Type I roadmap now; SAML/generic OIDC is ~2 weeks of dev work |

---

## Year-1 plan in one paragraph

**Q1-Q2:** Convert the existing S25 authoring into platform IP. Land DMW&H at $42-90k/yr Enterprise tier as the founding integrator using the SANTECH/S25 reference. Use that to land 2-4 additional mid-size MHI integrators at $42k/yr each. **ARR floor by mid-year: $200k.** **Q3:** Cross-sell into S25's OEMs in priority order — start with the most parts-revenue-motivated (Honeywell Intelligrated, Intralox, SICK). Goal: 1-2 OEMs signed at $80-150k/yr by end of Q3. **Q4:** Pitch FedEx Memphis at the site level using DMW&H + OEM coverage as the value story. Target $80k pilot signing for one hub. Close gaps in SAML SSO, CMMS webhook integration, and analytics dashboards in parallel. **Year-1 ARR target: $400-600k** with 6-10 paying tenants. Year-2 the OEM motion compounds toward $1.5-3M ARR.

---

## The mental model that makes this click

A single piece of equipment — say, one Honeywell Intelligrated cross-belt sorter at FedEx Memphis — has multiple legitimate stakeholders:

- **The OEM owns the title** — Honeywell made it, their parts go in it, their manual covers it
- **The Integrator holds the service lease** — DMW&H is contractually responsible for keeping it running
- **The End-Customer owns the premises** — it's at FedEx Memphis, on FedEx property, FedEx techs operate it daily

Each stakeholder pays us for **their relationship to the asset**, not for the asset itself. That's why all three can pay simultaneously without it feeling unfair, and why the layered revenue compounds across the equipment's full 20-year service life.

The platform's job is to make the QR sticker on the equipment outlive any single contract that put it there.
