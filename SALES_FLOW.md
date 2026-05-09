# Sales Flow & Customer Journey

Visual playbook for how deals start, grow, and compound over time. Worked against the **FedEx Memphis Secondary 25 (S25)** project as the reference case.

---

## The S25 reference project at a glance

```
FedEx Memphis Secondary 25 (S25) Sort System
─────────────────────────────────────────────
End-Customer:  FedEx Corporation, Memphis, TN
Integrator:    DMW&H (Fairfield, NJ)
Documentation: SANTECH (5 manuals, already authored)

OEMs in the system:
  ▸ Honeywell Intelligrated   — cross-belt sorter
  ▸ Intralox                  — flow splitter (ARB)
  ▸ SICK                      — vision / scan tunnel
  ▸ Visicon (Vitronic)        — singulator vision
  ▸ Transnorm                 — power turns / merges
  ▸ Flow Turn                 — power turn conveyors
  ▸ Talos                     — transport / scan conveyors
  ▸ Rice Lake                 — cargo scale (iQUBE)
  ▸ NORD                      — gear motors
  ▸ Baldor                    — AC motors
  ▸ Rockwell / Allen-Bradley  — PLCs, VFDs, HMIs
```

---

## Diagram 1: How S25 becomes three layered revenue streams

This is the core dynamic. One integration project at FedEx Memphis generates revenue from three different buyers across a 7-year window.

```
TIME →

YEAR 1               YEAR 2-3             YEAR 4+              YEAR 7+
─────────────        ─────────────        ─────────────        ─────────────

[INTEGRATOR]    →    [INTEGRATOR]    →    [INTEGRATOR]    →    [INTEGRATOR]
 DMW&H                DMW&H                DMW&H                DMW&H
 $42k/yr              $42-90k/yr           $90k/yr or rolls    (still on
                                            off Memphis         platform for
                                                                other projects)

                     [OEM #1]        →    [OEM #1]        →    [OEM #1]
                      Honeywell            Honeywell            Honeywell
                      Intelligrated        Intelligrated        Intelligrated
                      $150k/yr             $158k/yr             $175k/yr

                     [OEM #2]        →    [OEM #2]        →    [OEM #2]
                      Intralox             Intralox             Intralox
                      $80k/yr              $85k/yr              $95k/yr

                     [OEM #3]        →    [OEM #3]        →    [OEM #3]
                      SICK                 SICK                 SICK
                      $120k/yr             $126k/yr             $140k/yr

                                          [OEMs #4-8]    →    [OEMs #4-8]
                                          Transnorm,           same
                                          Flow Turn,
                                          Visicon,
                                          Talos,
                                          Rice Lake
                                          ~$215k/yr combined

                                          [END-CUSTOMER]   →   [END-CUSTOMER]
                                           FedEx Memphis        FedEx Memphis
                                           $80k yr-1 (disc.)    $130-140k/yr
                                           $130k yr-2+


ANNUAL REVENUE FROM THIS ONE PROJECT:

  Y1: $42k        Y2-3: $392k         Y4: $475k+           Y7: $680k+

7-YEAR TOTAL: ~$3.0M+ from one integration project
```

**Key insight:** DMW&H rolls off Memphis at handoff (year 3-4), but the OEM revenue compounds *forever* and FedEx takes over the operational layer. The platform never stops being paid for that equipment. **The OEM layer is the durable annuity.**

---

## Diagram 2: The customer acquisition flow

How we actually find, qualify, and close each customer type.

```
                    ┌────────────────────────┐
                    │  LEAD                  │
                    │  Source: tradeshow,    │
                    │  outbound, referral    │
                    └────────┬───────────────┘
                             ↓
                    ┌────────────────────────┐
                    │  QUALIFY: Which type?  │
                    └────────┬───────────────┘
                             │
              ┌──────────────┼──────────────────┐
              ↓              ↓                  ↓
      ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
      │ INTEGRATOR   │  │     OEM      │  │ END-CUSTOMER │
      │ (priority 1) │  │ (priority 2) │  │ (priority 3) │
      │              │  │              │  │              │
      │ DMW&H, peer  │  │ Honeywell,   │  │ FedEx hubs,  │
      │ MHI firms    │  │ Intralox,    │  │ UPS, Amazon, │
      │              │  │ SICK, etc.   │  │ 3PLs         │
      └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
             │                  │                  │
             ↓                  ↓                  ↓
      ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
      │ Pitch:       │  │ Pitch:       │  │ Pitch:       │
      │ Service org  │  │ Aftermarket  │  │ Unified      │
      │ productivity │  │ parts revenue│  │ compliance + │
      │              │  │ + brand ctrl │  │ training     │
      └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
             ↓                  ↓                  ↓
      ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
      │ Demo using   │  │ Demo their   │  │ Demo unified │
      │ S25 / SANTECH│  │ equipment    │  │ multi-OEM    │
      │ as reference │  │ already in   │  │ view at      │
      │              │  │ platform     │  │ peer hub     │
      └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
             ↓                  ↓                  ↓
      ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
      │ Close in     │  │ Close in     │  │ Close in     │
      │ 30-90 days   │  │ 6-12 months  │  │ 9-12 months  │
      └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
             ↓                  ↓                  ↓
      ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
      │ $42-120k/yr  │  │ $30-250k/yr  │  │ $80-150k/yr  │
      └──────────────┘  └──────────────┘  └──────────────┘
```

**Sales priority order:** Start with DMW&H (already a SANTECH services customer), close 1-2 peer integrators. Use those wins to land OEMs in S25's bill of materials. Use OEM partnerships to pull FedEx in at the site level.

---

## Diagram 3: The land-and-expand motion within DMW&H

Once DMW&H signs as the founding integrator, here's how the relationship grows.

```
LAND
─────

  Month 0:   DMW&H signs Enterprise tier ($90k/yr)
             S25 + their other ~30 active projects in tenant
                            │
                            ↓
EXPAND PHASE 1 (within DMW&H)
──────────────

  Month 3:   They author 2-3 more projects beyond S25
             Asset count grows. Still in Enterprise tier.
                            │
                            ↓
  Month 6:   Sales pull DMW&H Service VP into platform
             ROI conversation. Renewal de-risked.
                            │
                            ↓
EXPAND PHASE 2 (cross-sell to OEMs in S25's BOM)
──────────────

  Month 9:   "Hey Honeywell, your sorter is in our platform
             via S25. Your manuals are already authored.
             Want to control your own content across every
             Honeywell sorter in the field?"
             Honeywell signs: +$150k/yr
                            │
                            ↓
  Month 12:  Same pitch to Intralox: +$80k/yr
                            │
                            ↓
  Month 15:  SICK signs: +$120k/yr
             Transnorm signs: +$60k/yr
                            │
                            ↓
EXPAND PHASE 3 (FedEx pull-through)
──────────────

  Month 18:  FedEx Memphis maintenance manager sees techs
             scanning QR codes and asks for site-level access.
             FedEx Memphis pilot tenant: +$80k/yr (year 1 disc.)
                            │
                            ↓
TOTAL FROM THIS ONE LANDING (Month 18):
  $90k DMW&H + $410k OEM + $80k FedEx = $580k ARR
```

**The lesson:** A single integrator landing — when paired with deliberate OEM cross-sell and end-customer pull-through — generates 5-7x its own subscription value within 18 months. **The S25 project specifically is gold because SANTECH already authored the OEM content; the OEM cross-sell pitch writes itself.**

---

## Diagram 4: The handoff trigger — what happens when warranty ends

The most important moment in the customer lifecycle. Handle this well and revenue compounds; handle it poorly and it churns.

```
                  ┌──────────────────────────────────┐
                  │  S25 warranty period ending      │
                  │  (typically year 2-3 post go-live)│
                  └─────────────┬────────────────────┘
                                ↓
                  ┌──────────────────────────────────┐
                  │  60 days before handover:        │
                  │  Trigger automated outreach to   │
                  │  FedEx Memphis + DMW&H           │
                  └─────────────┬────────────────────┘
                                ↓
                  ┌──────────────────────────────────┐
                  │  Three possible outcomes         │
                  └─────────────┬────────────────────┘
                                │
              ┌─────────────────┼─────────────────┐
              ↓                 ↓                 ↓
      ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
      │ Outcome A    │  │ Outcome B    │  │ Outcome C    │
      │ DMW&H keeps  │  │ FedEx takes  │  │ Neither pays │
      │ long-term    │  │ Memphis      │  │              │
      │ service      │  │ in-house     │  │              │
      │ contract     │  │              │  │              │
      └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
             ↓                  ↓                  ↓
      ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
      │ DMW&H keeps  │  │ Productized  │  │ DMW&H tenant │
      │ paying as-is │  │ "Project     │  │ deactivates  │
      │              │  │ Handoff" SKU │  │ for Memphis. │
      │              │  │ at 50% off   │  │ QR codes go  │
      │              │  │ year-1       │  │ dark UNLESS  │
      │              │  │              │  │ OEMs are     │
      │              │  │ FedEx pays   │  │ signed up:   │
      │              │  │ $80k yr-1,   │  │ then content │
      │              │  │ $130k+ ongoing│  │ stays alive. │
      └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
             ↓                  ↓                  ↓
      ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
      │ Revenue:     │  │ Revenue:     │  │ Revenue:     │
      │ Unchanged    │  │ +$80-130k    │  │ Loss of      │
      │              │  │ (replaces    │  │ DMW&H + FedEx│
      │              │  │ DMW&H Memphis│  │ for Memphis; │
      │              │  │ slice)       │  │ OEMs survive │
      └──────────────┘  └──────────────┘  └──────────────┘
```

**Mitigation for Outcome C:** Push hard on OEM signups in years 1-2 (Honeywell, Intralox, SICK first). Even if both DMW&H and FedEx churn from Memphis, the OEM layer keeps paying and the equipment stays "live" on the platform.

---

## Diagram 5: The library flywheel — S25 as foundational seed

How S25's already-authored content makes future integrator sales progressively easier.

```
TODAY (S25 already authored)
────────────────────────────

  Library state:  10-12 OEMs partially authored from S25
                  (Honeywell Intelligrated, Intralox, SICK,
                  Visicon, Transnorm, Flow Turn, Talos, Rice
                  Lake, NORD, Baldor, Rockwell)
              │
              ↓
  This is the foundation library — most major MHI
  projects use 60-70% of these same OEMs.


YEAR 1: First few integrator deals
──────────────────────────────────

  New integrator signs up
              │
              ↓
  Per-project authoring cost: $30-60k
  (only the OEMs not in S25's footprint)
              │
              ↓
  Easier sell than from-scratch — most equipment
  pre-authored from S25 baseline


YEAR 3: 20+ OEMs in library
───────────────────────────

  New integrator signs up
              │
              ↓
  Per-project authoring cost:  $15-30k
              │
              ↓
  Faster integrator growth (10-15/year)


YEAR 5: 50+ OEMs in library
───────────────────────────

  New integrator signs up
              │
              ↓
  Per-project authoring cost:  $10-20k
              │
              ↓
  No-brainer — sign in a week
              │
              ↓
  Each new integrator becomes a vehicle for
  more OEM cross-sells, accelerating the loop.
```

**The strategic implication:** S25 isn't just a customer reference — it's a content seed. Every OEM signed up from S25's bill of materials makes every future integrator sale cheaper and easier.

---

## Diagram 6: The OEM cross-sell sequence from S25

Priority order for pitching the OEMs whose equipment is in S25.

```
TIER 1 — Highest leverage (do first, target Q2-Q3 of Year 1)
────────────────────────────────────────────────────────────
  Why: Largest installed base, largest aftermarket parts
  revenue at stake, biggest annual contract values

  ▸ Honeywell Intelligrated    target $150k/yr
    (S25 sorter; ~thousands of similar sorters in N. America)

  ▸ Intralox                   target $80-100k/yr
    (S25 ARB flow splitter; massive installed base)

  ▸ SICK                       target $120-150k/yr
    (S25 vision tunnel; on virtually every modern sortation)


TIER 2 — Mid-size OEMs (do next, target Q4 Year 1)
──────────────────────────────────────────────────
  ▸ Transnorm           target $60k/yr
  ▸ Rice Lake           target $40-60k/yr
  ▸ Visicon (Vitronic)  target $40-50k/yr


TIER 3 — Specialty OEMs (Year 2)
────────────────────────────────
  ▸ Flow Turn           target $40k/yr
  ▸ Talos               target $35k/yr
  ▸ NORD                target $30k/yr
  ▸ Baldor (ABB)        target $40k/yr


TIER 4 — Controls / horizontal players (Year 2+)
────────────────────────────────────────────────
  ▸ Rockwell / Allen-Bradley   target $80k+/yr
    (PLCs, VFDs, FactoryTalk — touches every project,
     potentially partner-tier deal)


CUMULATIVE OEM ARR FROM S25's BOM IF ALL SIGN:
────────────────────────────────────────────────
  Tier 1:        $350-400k
  + Tier 2:      $140-170k
  + Tier 3:      $145k
  + Tier 4:      $80k+
  ──────────────────────
  TOTAL:         $715-795k/yr from OEMs alone
```

**Note:** You don't need to land all of them. Landing Tier 1 alone (Honeywell, Intralox, SICK) is **$350k+ ARR from a single project's bill of materials.**

---

## Pricing reference card

Quick-reference pricing to use in conversations.

| Customer | Starting price | Typical | Top tier |
|----------|----------------|---------|----------|
| Integrator | $14.4k/yr | $42-90k/yr | $90-120k/yr |
| OEM (specialty) | $30k/yr | $40-60k/yr | $80k/yr |
| OEM (mid-size) | $60k/yr | $80-100k/yr | $120k/yr |
| OEM (major) | $150k/yr | $180k/yr | $250k/yr |
| End-customer (per site) | $80k/yr | $130k/yr | $150k/yr |

**One-time services:**
- Single OEM manual authoring: $15-25k
- Site overlay authoring: $15-25k
- Multi-manual project bundle (S25-style, 5 manuals): $80-200k

**Add-ons (metered):**
- AI chat overage: $0.05/msg
- Storage overage: $0.10/GB/mo
- Onboarding agent runs: $250 each beyond included pool

---

## Sales process checklist

Use this for every new prospect.

### Discovery (30-60 minutes)
- [ ] Identify customer type (Integrator / OEM / End-Customer)
- [ ] Confirm fit: do they operate in MHI / industrial automation?
- [ ] Quantify scope: how many assets / projects / dealers / sites?
- [ ] Identify champion (Director of Service, VP Aftermarket, Maintenance Manager)
- [ ] Identify economic buyer (different from champion above the $50k mark)

### Demo (45-60 minutes) — use the S25 reference
- [ ] Open S25 reference — DMW&H tenant view, FedEx Memphis assets
- [ ] Show QR scan → asset hub → linked sections from S25 manuals
- [ ] Show authoring UX (PDF outline picker on real S25 manual)
- [ ] Show AI chat answering an S25 maintenance question with safety guardrails
- [ ] Show audit log + procedure evidence
- [ ] **If OEM:** show their equipment from S25 already in platform → "this is yours, with a few clicks"
- [ ] **If integrator:** show DMW&H portfolio view with S25 + neighbor projects
- [ ] **If end-customer:** show multi-OEM unified view + compliance reports for FedEx Memphis

### Proposal (within 5 days of demo)
- [ ] Subscription tier recommendation with asset count justification
- [ ] Authoring services line items with library credit (where applicable — most S25 OEMs already 30-60% authored)
- [ ] Multi-year pricing option (3-year @ 15% off)
- [ ] Founding-customer terms (if early enough)
- [ ] Implementation timeline (4-6 weeks typical)

### Close (target: 30-90 days for integrators, 6-12 months for OEMs/end-customers)
- [ ] Procurement / legal review
- [ ] Security questionnaire (SOC 2 roadmap one-pager)
- [ ] DPA / data-handling terms
- [ ] Signed MSA + Order Form
- [ ] Onboarding kickoff scheduled

### Post-close expand (within 90 days)
- [ ] Identify OEMs in their portfolio for cross-sell (use S25 BOM as template)
- [ ] Identify end-customers for pull-through
- [ ] Schedule QBR for month 6
- [ ] Set asset-growth milestones for tier-up triggers
