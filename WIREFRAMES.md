# Equipment Hub — UI Wireframes & Design Spec

A complete structural spec for the Equipment Hub platform, intended as the
input to a visual-design pass. Covers both applications (PWA for floor use,
Admin for authoring), every screen's layout, component inventory, interaction
patterns, states, and motion.

The visual designer's job: give each of these screens a cohesive visual
language. The structure below is fixed. The aesthetic is open.

---

## 1. Product context

**What it is.** A Connected Worker Platform for the Material Handling and
Industrial Automation vertical. Technicians scan a QR code on a piece of
equipment and land on a contextual hub with documentation, training, parts,
AI troubleshooting, and the ability to open work orders. Admins (both our
staff and OEM staff) author content centrally.

**Who uses it.**
- **Technicians / operators** — on the PWA, usually on a phone or tablet, on
  the floor, often with gloves, sometimes in bright or dim lighting.
- **Trainers** — on the PWA tablet for longer authoring and coaching sessions.
- **OEM / dealer content authors** — on the Admin web app, desk-class usage.
- **Santech staff (us)** — on the Admin as super-users across tenants.

**Target devices.**
- Phone portrait (Android/iOS, 375–430 px) — PWA primary entry.
- Tablet landscape (iPad, Surface, ruggedized Zebra/Honeywell, ~1024–1280 px)
  — the sweet spot for both PWA and Admin.
- Desktop (1440 px+) — Admin heavy use.

**Tonal keywords.** Industrial, precise, confident, calm, modern, mechanical.
**Not.** Playful, consumer, corporate-bland, dashboard-template.

**Reference mental models.** Rockwell FactoryTalk, Siemens Industrial Edge,
Inductive Automation Ignition, Autodesk Fusion, Linear, Raycast, Notion.
**Away from.** Standard SaaS admin templates, consumer banking apps.

---

## 2. Information architecture

### PWA (apps/pwa)

```
/                              Landing (scan CTA)
/scan                          Live QR camera
/q/<code>        →  redirect   Sticker target — hands off to /a/<code>
/a/<code>                      Asset hub  (the hero surface)
    ├── Overview tab
    │    ├── Spec grid (Model, Serial, Site, Rev, …)
    │    └── Issues panel (list + report form)
    ├── Documents tab
    │    └── Document viewer (per kind)
    ├── Training tab
    │    └── Module runner → Quiz → Result
    ├── Parts tab
    │    └── Searchable BOM list
    └── Assistant tab
         └── Grounded streaming chat with citations
```

### Admin (apps/admin)

```
/                              Dashboard (metric tiles)
/tenants                       Organizations list
    └── /tenants/[id]          Org detail (sites, children)
/asset-models                  Asset models list
    └── /asset-models/[id]     Model detail (deployed instances, bulk import)
/content-packs                 Content packs list
    └── /content-packs/[id]    Pack detail (versions, documents, publish)
/training                      Training modules (enrollment stats)
/parts                         Parts catalog (searchable)
/qr-codes                      QR stickers (mint + print)
    └── /qr-codes/print        Printable sticker sheet
/users                         User directory
/audit                         Append-only event log
```

**Global:** Cmd-K command palette, toast system, theme toggle, sidebar, top bar.

---

## 3. Design principles

1. **Equipment is the noun.** Every screen orients around a specific
   serial-numbered asset or the catalog of asset models. Not "procedures",
   not "documents" — machines.
2. **Content shows, chrome hides.** Use density like Linear, not ornament like
   Stripe. Restrained borders, subtle elevation, no gratuitous shadows.
3. **Status is real.** LEDs, signal pills, and safety chips use OSHA-aligned
   color semantics — they mean something. Don't decorate with these colors.
4. **Type carries hierarchy.** Headings, captions, mono codes, tabular numbers
   do the work. Don't reach for color or weight first.
5. **Every screen has four states** the designer must consider: default,
   loading (skeleton), empty (icon + copy + action), error (banner + recovery).
6. **Motion is functional.** Enter, exit, focus — never decorative bounce.
7. **Touch targets ≥ 40 px.** Users wear gloves and stand on concrete.

---

## 4. Visual tokens (current baseline)

The designer may redefine these, but the semantic slots stay.

### Surfaces
```
surface-base           page background
surface-raised         cards, panels
surface-elevated       hover / zebra / nested panels
surface-inset          inputs, code, wells
surface-sidebar        Admin sidebar (dark graphite)
```

### Lines
```
line-subtle            tertiary dividers (table row borders)
line                   primary dividers (card borders)
line-strong            separator accents
```

### Ink
```
ink-primary            body text, headings
ink-secondary          metadata, descriptions
ink-tertiary           captions, hints
ink-inverse            text on dark surfaces
```

### Brand
```
brand                  engineering blue  — interaction, active nav
brand-strong           deeper blue       — hover, press
brand-soft             pale blue         — backgrounds for brand-tinted UI
brand-ink              contrast on brand — white on blue
```

### Signal (OSHA-aligned)
```
signal-ok              deep green        — healthy, pass, success
signal-warn            machinery orange  — warning, medium severity
signal-fault           deep crimson      — fault, critical
signal-info            brand-equivalent  — informational
signal-safety          OSHA yellow-ochre — safety-critical (verbatim content)
```

### Typography (current)
- **Sans:** IBM Plex Sans (300, 400, 500, 600, 700)
- **Mono:** IBM Plex Mono (400, 500, 600)

Type scale (rem):
```
caption   0.6875  uppercase, tracked +0.08em  — labels, spec field names
xs        0.75                                — tags, meta
sm        0.8125                              — secondary body
base      0.9375                              — primary body
lg        1.0625                              — larger body
xl        1.25                                — section titles
2xl       1.5     letter-spacing -0.01em      — asset name in nameplate
3xl       1.875   letter-spacing -0.02em      — page titles
4xl       2.25    letter-spacing -0.025em     — landing hero
```

### Border radius
```
none   sharp
sm     2 px — pills, kbd
DEFAULT 4 px — buttons, inputs
md     6 px — cards, panels
lg     8 px — drawer, nameplate
```

### Motion
- **Page enter:** 220 ms, cubic-bezier(0.2, 0.6, 0.2, 1), fade-up 4 px.
- **Tab content enter:** 180 ms, same easing, fade-up 2 px.
- **Drawer:** 240 ms, cubic-bezier(0.16, 1, 0.3, 1), slide-in 16 px + fade.
- **Button press:** `translateY(0.5px)` active state, 0 ms.
- **LED pulse:** 2.5 s ease-in-out infinite.

---

## 5. Shared primitives

Every screen is assembled from these. The visual designer should establish
the canonical form of each.

| Primitive | Purpose | Notes |
|---|---|---|
| `Nameplate` | Equipment identification header | Like a milled-aluminum equipment plate; brand-accent rail on left edge |
| `Segbar` | Segmented tab control | Icon + label + count; active has etched shadow |
| `Card` | Content container | Subtle border + hover lift |
| `DataTable` | Admin tabular data | Zebra rows, mono for codes, hover highlight |
| `Pill` | Status/tag/tone label | default / success / warning / danger / info variants |
| `LED` | Pulsing status dot | ok / warn / fault / idle |
| `Button` | primary / secondary / ghost | 36 px min, icon + label |
| `Field` | Labeled form input | caption label + input + hint |
| `Drawer` | Right-side sheet | For forms, detail views |
| `Toast` | Bottom-right notification | success / error / info; border + color bar + icon |
| `Skeleton` | Loading placeholder | Shimmer animation |
| `EmptyState` | Empty-collection block | icon in soft circle + title + description + action |
| `Breadcrumbs` | Navigation trail | Home icon + chevron chain |
| `CommandPalette` | Cmd-K overlay | Grouped results, keyboard-driven |
| `TopBar` | Admin sticky page bar | Breadcrumbs left, Quick-find right |
| `Sidebar` | Admin primary nav | Dark, icon + label, active rail |
| `Caption` | ALL-CAPS micro label | 11 px, uppercase, letter-spaced |

---

## 6. PWA wireframes

### 6.1 Landing (`/`)

```
┌────────────────────────────────────────────────┐
│  [EH]  Equipment Hub                       [🌙]│  ← header
├────────────────────────────────────────────────┤
│                                                │
│                                                │
│                    ┌───┐                       │
│                    │ ▓ │  (QR tile icon)       │
│                    └───┘                       │
│                                                │
│              READY TO SCAN                     │  ← caption
│              Scan to begin.                    │  ← 4xl title
│                                                │
│        Point your camera at the QR             │
│        sticker on the equipment. Docs,         │
│        training, parts, grounded AI —          │
│        all for this exact serial.              │
│                                                │
│                                                │
│  ┌──────────────────────────────────────────┐  │
│  │           ⬇  SCAN EQUIPMENT               │  │  ← primary button
│  └──────────────────────────────────────────┘  │  w/ colored shadow
│                                                │
│   Hands busy? Hold the QR steady — hub loads   │
│   in under a second.                           │
│                                                │
└────────────────────────────────────────────────┘
```

- Max-width: 28 rem (phone-optimized).
- `Scan equipment` button has subtle brand-colored drop shadow.
- Caption above hero is uppercase-tracked.

### 6.2 Scanner (`/scan`)

```
┌────────────────────────────────────────────────┐
│  ← Back                     ● SCANNING         │
├────────────────────────────────────────────────┤
│                                                │
│     ┌┐────────────────────────────────────┐┐   │
│     └┘                                    └┘   │
│                                                │
│                  [CAMERA FEED]                 │
│                                                │
│            Brand-colored corner                │
│             guides at 24px inset               │
│                                                │
│                                                │
│     ┌┐                                    ┌┐   │
│     └┘────────────────────────────────────└┘   │
│                                                │
│      Align the QR code inside the frame.       │
│      Steady the phone — no button needed.      │
│                                                │
└────────────────────────────────────────────────┘
```

- Video aspect: 3:4 on phone, 16:9 on tablet landscape.
- Four brand-colored L-bracket corner guides sized 24×24 px.
- Auto-detects codes; no manual trigger.
- Error state: fault-tinted banner below video.

### 6.3 Asset hub (`/a/<qrCode>`) — THE HERO SCREEN

**Layout at tablet landscape (1024 px+):**

```
┌────────────────────────────────────────────────────────────────────────┐
│  ← Scan another          [EH] Equipment Hub                  [🌙]      │  top bar
├────────────────────────────────────────────────────────────────────────┤
│ ┌╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴┐ │
│ │▓                                                                     │ │  ← nameplate
│ │▓  ● FLOW TURN · MEMPHIS DC 3                         REV   OPEN WO  │ │     brand rail
│ │▓  Flow Turn Square-Turn                              1.0.0       0  │ │     on left edge
│ │▓  FT-SQUARE-TURN  ·  S/N FT-0042  ·  CONVEYOR                       │ │
│ └╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴┘ │
│                                                                        │
│ ┌──────────────────────────────────────────────────────────────────┐   │
│ │ ◨ Overview ◧  ▤ Documents 4  ▦ Training 1  🔧 Parts 2  ✦ Asst   │   │  ← segbar
│ └──────────────────────────────────────────────────────────────────┘   │    active: Overview
│                                                                        │
│ ┌──────────────────────────────────────────────────────────────────┐   │
│ │  MODEL CODE          CATEGORY         SERIAL           SITE       │   │
│ │  FT-SQUARE-TURN      CONVEYOR         FT-0042          Memphis DC │   │
│ │                                                                   │   │
│ │  CUSTOMER            CONTENT REV      OPEN ISSUES      INSTALLED  │   │
│ │  Flow Turn           1.0.0            0                4/16/26    │   │
│ │                                                                   │   │
│ │  ─── Work orders ────────────────────────── [ + Report issue ]    │   │
│ │                                                                   │   │
│ │       No open issues on this asset.                               │   │
│ │                                                                   │   │
│ └──────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────┘
```

**Layout at phone portrait (375 px):**

```
┌──────────────────────────┐
│ ← Scan another    [🌙]   │
├──────────────────────────┤
│ ┌╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴┐│
│ │▓ ● FLOW TURN · MEMPHIS ││   nameplate stacks
│ │▓ Flow Turn Square-Turn ││   metadata under title
│ │▓ FT-SQUARE-TURN        ││
│ │▓ S/N FT-0042 · CONVEYOR││
│ │▓                        ││
│ │▓ REV    OPEN WO         ││   metrics row wraps
│ │▓ 1.0.0  0               ││
│ └╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴┘│
│                          │
│ [◨][▤ 4][▦ 1][🔧 2][✦]  │   icon-only tabs on narrow
│                          │
│ ┌──────────────────────┐ │
│ │ MODEL CODE           │ │   spec grid → 2 cols
│ │ FT-SQUARE-TURN       │ │
│ │                      │ │
│ │ CATEGORY             │ │
│ │ CONVEYOR             │ │
│ │ …                    │ │
│ └──────────────────────┘ │
└──────────────────────────┘
```

**Nameplate.** Core component. Lives at the top of every `/a/*` page.
- Brand-color vertical rail on the far left (3 px wide).
- Subtle radial blue wash in the top-right corner.
- Radial gradient from surface-raised → surface-elevated for paper-like depth.
- Status LED + caption above the asset display name.
- Primary title uses 2xl on phone, 3xl on tablet, semibold, tight tracking.
- Model code, serial number (brand-tinted), and category sit below title as a mono meta row separated by dots.
- Revision and open-work-order count shown right-aligned on tablet, stacked on phone.

**Segbar.** Border-enclosed 40 px pill with icon + label + count variants.
- Labels collapse to icon-only under ~640 px.
- Active tab has inset shadow, brand-tinted count chip.
- Keyboard nav via arrow keys.

### 6.4 Overview tab (inside `/a/<qrCode>`)

```
┌──────────────────────────────────────────────────────────────┐
│  MODEL CODE      CATEGORY      SERIAL        SITE            │
│  FT-SQUARE-TURN  CONVEYOR      FT-0042       Memphis DC      │
│  ( mono )        ( tracked )   (brand mono)                  │
│                                                              │
│  CUSTOMER        CONTENT REV   OPEN ISSUES   INSTALLED       │
│  Flow Turn       1.0.0         0 (ok)        Apr 16, 2026    │
│                                                              │
│  ─ WORK ORDERS ──────────── 0 ───── [ + Report issue ] ─     │
│                                                              │
│           No open issues on this asset.                      │
└──────────────────────────────────────────────────────────────┘

STATES
  default:   spec grid + "No open issues" text + report-issue button
  with issues: list of WorkOrderRow below caption
  report flow: inline form replaces button (title, description, severity)
```

**WorkOrderRow:**
```
┌────────────────────────────────────────────────┐
│  ● title text here                             │
│    • description (optional) on a new line      │
│    opened by Dev Technician · just now         │
│                                ┌─ HIGH  ─┐     │
│                                ┌─ OPEN  ─┐     │
└────────────────────────────────────────────────┘
```
- LED color keyed to severity (red/orange/sky/idle).
- Two stacked pills on the right: severity tone-tinted, status outlined.

### 6.5 Documents tab

**List (grid 3-col on tablet, 2-col on small-tablet, 1-col on phone):**
```
┌────────────────┐  ┌────────────────┐  ┌────────────────┐
│ ▤ DOCUMENT  [🛡]│  │ ▤ PDF          │  │ ▶ VIDEO        │
│                 │  │                │  │                │
│ Quick start     │  │ Lockout tagout │  │ Motor swap     │
│                 │  │   procedure    │  │                │
│ [startup][op]   │  │ [safety][loto] │  │ [maintenance]  │
└────────────────┘  └────────────────┘  └────────────────┘
```
- Cards have subtle border, lift slightly on hover (-0.5 px Y, tinted shadow).
- Kind label at top with small lucide icon (FileText, FileType2, Video, Youtube, Presentation, Layers, Paperclip).
- Safety chip top-right with shield icon if safety-critical.
- Title in base body, brand-color on hover.
- Tag chips at bottom (mono, subtle).

**Document viewer (per kind):**

*markdown / structured_procedure*
```
← All documents
 ┌ SAFETY-CRITICAL PROCEDURE ──────────────────────┐
 │ ⚠  Follow verbatim. Do not skip steps.          │
 └─────────────────────────────────────────────────┘
   DOCUMENT · PROCEDURE
   Lockout / tagout procedure
  ────────────────────────────
   # H1
   ## H2
   body text
   1. ordered list
   2. ordered list
   **bold**, `code`, [link]
```

*pdf / schematic*
```
← All documents                                     
   PDF
   Illustrated parts list
 ┌─────────────────────────────────────────┐
 │                                    ⛶    │   ← fullscreen button
 │         [   PDF IFRAME 75vh   ]         │      top-right
 │                                         │
 └─────────────────────────────────────────┘
   Rotate for landscape pages.  ⬇ Download file
```

*video (uploaded)*
```
   ▶ VIDEO
   Motor swap walkthrough
 ┌─────────────────────────────────────────┐
 │       HTML5 <video> controls            │
 └─────────────────────────────────────────┘
```

*external_video (YouTube/Vimeo/Mux)*
```
   ▶ VIDEO · EXTERNAL
 ┌─────────────────────────────────────────┐
 │       YouTube / Vimeo iframe embed      │
 └─────────────────────────────────────────┘
```

*slides*
```
   ⎙ SLIDES
 ┌─────────────────────────────────────────┐
 │   Microsoft Office viewer iframe        │
 │   (on public URL)                       │
 └─────────────────────────────────────────┘
 [ ⬇ Download deck ]
```

*file (generic)*
```
 ┌──────────────────────────────────────────┐
 │  filename.docx                           │
 │  123.4 KB                      [ ⬇ ]     │
 └──────────────────────────────────────────┘
```

### 6.6 Training tab

**Module list:**
```
┌────────────────────────────────────────────────┐
│  MS-4 Operator Basics           [ Passed 80% ] │
│  Pre-shift checks, startup sequence,           │
│  alarm acknowledgment.                         │
│  1 lesson   1 activity   ~20 min               │
└────────────────────────────────────────────────┘
```
- Enrollment badge: Passed (green) / Failed (red) / In progress (blue) / none.
- Click → Module runner.

**Module runner:**
```
← Back to training
MS-4 Operator Basics
description

LESSONS
 ┌────────────────────────────────────┐
 │ Overview                           │
 │ markdown body…                     │
 └────────────────────────────────────┘

ACTIVITIES
 ┌────────────────────────────────────┐
 │ Pre-operation check                │
 │ quiz                      Start →  │
 └────────────────────────────────────┘
```

**Quiz runner:**
```
← Back to module
MS-4 OPERATOR BASICS
Pre-operation check

1. Before starting an MS-4 shift, which system
   should you start first?
   ( ) Aisle conveyors
   (●) Sortation system
   ( ) Shuttles simultaneously
   ( ) None — the system auto-starts

2. An E-217 fault indicates:
   ( ) Low battery
   (●) Emergency stop circuit opened
   …

                               [ Submit ]
```

**Quiz result:**
```
Quiz result
 ┌──────────────────────────────────────────┐
 │  1 / 2 correct · 50%                     │
 │  Module score: 50% (pass: 80%)           │
 │  Below pass threshold — retake to re-    │
 │  score.                                  │
 └──────────────────────────────────────────┘

Q1: correct     (green row)
Q2: incorrect (correct was option 2)   (red row)

                                   [ Done ]
```

### 6.7 Parts tab

```
┌ FIND  🔍 Search by part #, name, position… ────┐
└──────────────────────────────────────────────┘

 ┌──────────────────────────────────────────┐
 │  DM-4712   Shuttle drive motor assembly  │
 │  Servo drive motor with integrated       │
 │  encoder for MS-4 shuttle.               │
 │  POS M1   QTY 24   XREF [SEW-DFS71M4B]   │
 └──────────────────────────────────────────┘
 ┌──────────────────────────────────────────┐
 │  ES-221   E-stop safety relay            │
 │  POS ES-221   QTY 1   XREF [PILZ-PNOZ-X3]│
 └──────────────────────────────────────────┘
```
- Part number in brand-tinted mono.
- Position ref and quantity in caption+mono pattern.
- Cross-reference chips are outlined mono pills.
- Discontinued parts render with 70% opacity + amber pill top-right.

### 6.8 Assistant (AI chat) tab

**Empty state:**
```
┌ ● GROUNDED ON THIS ASSET ───── Flow Turn Square-Turn · rev 1.0.0 ┐
│                                                                 │
│                 Ask about this equipment.                       │
│                                                                 │
│     Answers are grounded on the published content for this      │
│     exact serial. Safety-critical procedures are quoted         │
│     verbatim.                                                   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

[ ✦  What does fault E-217 mean?                          ⬆ ]
```

**With conversation:**
```
                          ┌───────────────────────────┐
                          │ user msg (brand bg)       │  right-aligned
                          │                           │  rounded, not corner
                          └───────────────────────────┘

● ASSISTANT
┌─────────────────────────────────────────────────┐
│  E-217 means the E-stop circuit has opened.[1]  │
│                                                 │
│  To clear:                                      │
│  1. Inspect E-stop buttons                      │
│  2. Verify safety-relay LED…                    │
│  ───── SOURCES ─────                            │
│  [1]  Fault E-217 troubleshooting  🛡 Safety    │
│        "E-217 indicates the emergency-stop…"    │
└─────────────────────────────────────────────────┘

[ ✦ Type another question…                        ⬆ ]
```

- Assistant responses rendered in markdown; citation markers `[cite:uuid]` are
  replaced with numbered `[1]` chips inline.
- Source panel under response shows numbered list with doc title + quoted
  chunk excerpt + optional Safety pill.
- Streaming cursor: 2×16 px brand-tinted bar pulsing.
- Composer has: Sparkles icon left, rounded send button (circle) right with
  ArrowUp icon. When streaming, send button becomes a filled Stop square.
- Focus state: 3 px brand-soft ring around the composer.

### 6.9 Scan QR → unknown code (error)

```
              [ ? ]

         Unknown sticker

   That QR doesn't match any active asset.
   It may have been revoked or not yet
   minted for this site.

         [ Scan another ]
```

---

## 7. Admin wireframes

### 7.1 Global shell

```
┌────────────────────────────────────────────────────────────────────┐
│┌──────────────┐┌──────────────────────────────────────────────────┐│
││ SIDEBAR      ││ TOP BAR:  [Home] > Organizations  ── [ Quick⌘K ] ││  sticky
│├──────────────┤├──────────────────────────────────────────────────┤│
││              ││                                                  ││
││ [EH] Equip   ││         PAGE CONTENT                             ││
││      Hub     ││         max-w 1440, px 6→10, py 8→10             ││
││              ││                                                  ││
││ ┃ Dashboard  ││                                                  ││
││   Orgs       ││                                                  ││
││   Asset models││                                                  ││
││   Content    ││                                                  ││
││   Training   ││                                                  ││
││   Parts      ││                                                  ││
││   QR codes   ││                                                  ││
││   Users      ││                                                  ││
││   Audit log  ││                                                  ││
││              ││                                                  ││
││ v0.0·dev [🌙]││                                                  ││
│└──────────────┘└──────────────────────────────────────────────────┘│
└────────────────────────────────────────────────────────────────────┘
```

**Sidebar.**
- Dark graphite (surface-sidebar).
- 60px wide brand logo + title header.
- Nav items: 16 px lucide icon + label, 8 px gap.
- Active item: white/10 background, brand-colored 3 px left rail rounded, icon turns brand.
- Footer: version text + theme toggle.

**Top bar.**
- Sticky, subtle border-bottom, 90% opacity background with backdrop blur.
- Left: breadcrumbs with Home icon and chevron separators.
- Right: Quick-find pill button (`🔍 Quick find  ⌘K`).

**Page enter motion:** fade-slide up 4 px, 220 ms.

### 7.2 Dashboard (`/`)

```
Home

DASHBOARD
At-a-glance tenant state. All counts are live from the database.

┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐
│ ORGS   [🏢]│  │ SITES  [📍]│  │ INST   [📦]│  │ QR     [▦] │
│     3      │  │     4      │  │     2      │  │     2      │
│            │  │            │  │            │  │            │
└────────────┘  └────────────┘  └────────────┘  └────────────┘
┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐
│ WO    [⚠]  │  │ PACKS  [✓] │  │ ENROLL [🎓]│  │ COMPL  [↗] │
│     1      │  │     2      │  │     3      │  │    33%     │
│  warn tone │  │            │  │  2 compl.  │  │  of 3      │
└────────────┘  └────────────┘  └────────────┘  └────────────┘
```
- Metric tiles: label caption top-left + lucide icon top-right + mono tabular large number + optional secondary line.
- Tone applied to number only: warn (amber), ok (green), fault (red), default.
- Hover: border-line (stronger).
- Skeleton state: same grid with shimmering rectangles.

### 7.3 Organizations list (`/tenants`)

```
Home > Organizations

ORGANIZATIONS                                 [ + New organization ]
All tenants. OEMs author base content; dealers and integrators
overlay; end customers consume.

┌──────────────────────────────────────────────────────────────┐
│ TYPE          NAME              PARENT      OEM CODE  SITES USERS│
├──────────────────────────────────────────────────────────────┤
│ [OEM]         Dematic           —           DEMATIC   0     0 │
│               dematic                                         │
│ [OEM]         Flow Turn         —           FLOWTURN  1     0 │
│               flow-turn                                       │
│ [END_CUST]    Acme Logistics    Dematic     —         1     1 │
│               acme-logistics                                  │
└──────────────────────────────────────────────────────────────┘

STATES
  loading: TableSkeleton (6 cols, 5 rows)
  empty:   EmptyState(Building2, "No organizations yet", …)
  error:   red banner above table
```

**NEW ORGANIZATION drawer:**
```
┌──────────────────────────────┐
│ New organization          ✕  │
├──────────────────────────────┤
│ TYPE *                       │
│ [ OEM          ▾]            │
│                              │
│ NAME *                       │
│ [ Flow Turn          ]       │
│                              │
│ SLUG *                       │
│ [ flow-turn          ]       │
│ lowercase, hyphens, digits.  │
│                              │
│ OEM CODE                     │
│ [ FLOWTURN           ]       │
│                              │
│                              │
│               [ Create org ] │
└──────────────────────────────┘
```

### 7.4 Organization detail (`/tenants/[id]`)

```
Home > Organizations > Flow Turn

FLOW TURN                                          [ + Add site ]
oem · flow-turn · FLOWTURN

SITES (1)
┌─────────────────────────────────────────────────────────┐
│ NAME         CODE        LOCATION         TIMEZONE      │
├─────────────────────────────────────────────────────────┤
│ Memphis S25  MEM-S25     Memphis, TN, US  America/Chi   │
└─────────────────────────────────────────────────────────┘

DOWNSTREAM ORGS (1)
┌─────────────────────────────────────────────────────────┐
│ TYPE         NAME              SITES                    │
├─────────────────────────────────────────────────────────┤
│ END_CUST     Acme Logistics    1                        │
└─────────────────────────────────────────────────────────┘

STATES
  sites empty: dashed border panel "No sites yet. Add one…"
```

### 7.5 Asset models list (`/asset-models`)

```
Home > Asset models

ASSET MODELS                                   [ + New asset model ]

┌────────────────────────────────────────────────────────────────┐
│ MODEL                  CATEGORY   OEM        INSTANCES  PACKS  │
├────────────────────────────────────────────────────────────────┤
│ Flow Turn Square-Turn  CONVEYOR   Flow Turn      1          1  │
│   FT-SQUARE-TURN                                               │
│   short description here                                       │
│                                                                │
│ Multishuttle MS-4      ASRS       Dematic        1          1  │
│   MS-4                                                         │
└────────────────────────────────────────────────────────────────┘
```

### 7.6 Asset model detail (`/asset-models/[id]`)

```
Home > Asset models > Flow Turn Square-Turn

FLOW TURN SQUARE-TURN              [ ⇪ Bulk import ] [ + Add inst. ]
FT-SQUARE-TURN · conveyor · Flow Turn

DEPLOYED INSTANCES (1)
┌─────────────────────────────────────────────────────────────┐
│ SERIAL       SITE         CUSTOMER      PINNED     INSTALLED│
├─────────────────────────────────────────────────────────────┤
│ FT-0042      Memphis S25  Flow Turn     v1.0.0     4/16/26  │
└─────────────────────────────────────────────────────────────┘

DRAWER: Add instance
  Site (select) *
  Serial number (text) *
  Installed at (date)
  Info: Will auto-pin to latest published base ContentPack.
  [ Create instance ]

DRAWER: Bulk import
  Site for all serials (select) *
  Installed at (date)
  Serial numbers textarea (1 per line or CSV) *
  Parsed count: {n}
  [ Import {n} ]
  On success: green result panel "Imported X of Y. Z skipped."
```

### 7.7 Content packs list (`/content-packs`)

```
Home > Content packs

CONTENT PACKS                                 [ + New content pack ]

┌─────────────────────────────────────────────────────────────┐
│ NAME                 LAYER   MODEL          OWNER  VERS LATEST│
├─────────────────────────────────────────────────────────────┤
│ Flow Turn Square-Turn [BASE] Flow Turn Sq.. Flow   1    v1.0.0│
│   flow-turn-sq-turn-base                          [PUBLISHED]│
│                                                              │
│ Multishuttle MS-4     [BASE] Multishuttle.. Dematic 1   v1.0.0│
│   ms-4-base                                        [PUBLISHED]│
└─────────────────────────────────────────────────────────────┘
```

**NEW CONTENT PACK drawer:** Asset model (select), name (auto-from-model),
slug (auto), layer (base/dealer overlay/site overlay). Auto-creates draft v1.0.0.

### 7.8 Content pack detail (`/content-packs/[id]`)

```
Home > Content packs > Flow Turn Square-Turn

FLOW TURN SQUARE-TURN            [ + New draft version ] (if no draft)
base pack for Flow Turn Square-Turn (FT-SQUARE-TURN)

┌─────────────────────────────────────────────────────────────┐
│ v2.0.0  [DRAFT]                                             │
│                              [ + Add doc ] [ ⬆ Publish ]    │
│                                                             │
│  DOCUMENTS (1)                 TRAINING MODULES (0)         │
│  [pdf] Illustrated parts list  None.                        │
│        en              [Remove]                             │
└─────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│ v1.0.0  [PUBLISHED]   Published 4/17/2026                   │
│                                                             │
│  DOCUMENTS (1)                 TRAINING MODULES (0)         │
│  [pdf] Illustrated parts list  None.                        │
│        en                                                   │
└─────────────────────────────────────────────────────────────┘
```

**ADD DOCUMENT drawer (multi-kind):**
```
Kind (select with optgroups) *
  Text: Markdown | Structured procedure
  Uploaded: PDF | Slides | Video | Schematic | File
  External: Streaming video URL
Title *
Language (2-char) · Tags (CSV)
[☐] ⚠ Safety-critical
    Forces AI verbatim quote + warning banner in viewer.

≪ Kind-conditional fields ≫
  markdown:            [Markdown body textarea]
  external_video:      [Video URL input]
  video:               [Mux playback ID input (optional)] +
                       [Upload video file]
  pdf/slides/file/     [Upload file + progress bar]
    schematic:
                              [ Add document ]
```

### 7.9 Training (`/training`)

```
Home > Training

TRAINING
Modules authored against content packs, with enrollment and
completion stats across all users.

┌─────────────────────────────────────────────────────────────┐
│ MODULE              PACK      MODEL   DUR   PASS  ENROLL  %│
├─────────────────────────────────────────────────────────────┤
│ MS-4 Operator Basics  Multi…  Multi   20    80%   1      0%│
│   mhe.operator.asrs.…                             (0/1,1 f)│
└─────────────────────────────────────────────────────────────┘
```

### 7.10 Parts (`/parts`)

```
Home > Parts

PARTS
OEM-owned catalog. Each part can belong to many BOMs.

[🔍 Search by part #, name, cross-ref               ]

┌─────────────────────────────────────────────────────────────┐
│ PART #     NAME                      OWNER     XREF   BOMS │
├─────────────────────────────────────────────────────────────┤
│ DM-4712    Shuttle drive motor…      Dematic   [SEW] 1     │
│            Servo drive motor with…                         │
│ ES-221     E-stop safety relay       Dematic   [PILZ]1     │
└─────────────────────────────────────────────────────────────┘
```

### 7.11 QR codes (`/qr-codes`)

```
Home > QR codes

QR CODES
Stickers resolve via http://localhost:3000/q/<code>

─ MINT NEW STICKER ──────────────────────────────────────────
 Asset instance (select)
 [ FT Square-Turn · FT-0042 · Memphis S25          ▾ ]
 Label
 [ Aisle 1 east                                        ]
                                                 [ Mint ]

─ ACTIVE STICKERS ──── [Select all] [Clear] [Print sheet (2)] ─
┌─────────────────────────────────────────────────────────────┐
│ ☐ [QR] 0JS7T42GRCMH  FT Square-Turn  Memphis  Demo sticker  │
│                      FT-0042                                │
│ ☑ [QR] DEMO01ALPHA   Multishuttle    Memphis  Demo sticker  │
│                      MS4-00042       DC 3                   │
└─────────────────────────────────────────────────────────────┘
```

### 7.12 QR print sheet (`/qr-codes/print`)

Page auto-prints on load. Print layout (US Letter, 3×4 grid, 0.5 in margin):

```
┌ Top toolbar (no-print): "2 stickers · 1 page"  [Print again] ┐

╔═══════════════════════════╗  ╔═══════════════════════════╗ … 
║▓┌──────┐ SCAN FOR DOCS   ║  ║▓┌──────┐ SCAN FOR DOCS   ║
║▓│ [QR] │ CONVEYOR         ║  ║▓│ [QR] │ ASRS             ║
║▓│ 140  │ Flow Turn Sq-Turn║  ║▓│ 140  │ Multishuttle MS-4║
║▓│ px   │ S/N FT-0042      ║  ║▓│ px   │ S/N MS4-00042    ║
║▓└──────┘ Memphis S25      ║  ║▓└──────┘ Memphis DC 3     ║
║▓         ID · 0JS7T42GR…  ║  ║▓         ID · DEMO01ALPHA ║
╚═══════════════════════════╝  ╚═══════════════════════════╝
```
- Black border, 1 px.
- Brand-blue vertical rail 4 px on left edge.
- QR on left, text block on right.
- Top of text block: "SCAN FOR DOCS · PARTS · AI" microprint.
- Hierarchy: category caption → model display (2 lines max) → serial in mono
  → site → label → short code at bottom.
- Grid auto-rows 2.5 in tall, gap 0.08 in.

### 7.13 Users (`/users`)

```
Home > Users

USERS
Cross-tenant user directory. Roles scope to org memberships.

┌─────────────────────────────────────────────────────────────┐
│ NAME               EMAIL             HOME ORG    ROLES MEM ST│
├─────────────────────────────────────────────────────────────┤
│ Dev Technician     dev@doc-platform  Acme        [tech] 1 [●]│
└─────────────────────────────────────────────────────────────┘
```
- Roles shown as subtle pill chips.
- Status: active (green pill) / disabled (red pill).

### 7.14 Audit log (`/audit`)

```
Home > Audit log

AUDIT LOG
Append-only record — QR scans, work-order changes, publishes.
Required for safety-critical compliance. Most recent 200.

[🔍 Filter by event type, actor, target            ]

┌─────────────────────────────────────────────────────────────┐
│ WHEN          EVENT                 ACTOR  ORG      TARGET  │
├─────────────────────────────────────────────────────────────┤
│ 4/17 09:32    [published] content…  Dev T  Flow T   content…│
│                                                       8f3a…  │
│ 4/17 09:15    [qr.scan] resolved    —      Flow T   asset_i  │
│                                                       bbe8…  │
│ 4/17 08:58    [work_order.opened]   Dev T  Flow T   work_or  │
│                                          {3 fields ▾}        │
└─────────────────────────────────────────────────────────────┘
```
- Event pill tone: published=success (green), qr.scan=info (blue),
  work_order=warning (amber), default=neutral.
- Payload column has a `<details>` toggle that expands to a mono JSON block.

### 7.15 Command palette (Cmd-K overlay)

```
        ┌────────────────────────────────────────────┐
        │ 🔍  search organizations, assets, packs…ESC│
        ├────────────────────────────────────────────┤
        │ NAVIGATE                                   │
        │ ⊞  Dashboard                               │
        │ 🏢 Organizations                           │
        │ 📦 Asset models           ← selected (brand-soft bg)
        │ 🗃 Content packs                           │
        │ 🎓 Training                                │
        │ 🔧 Parts                                   │
        │ ▦  QR codes                                │
        │ 👥 Users                                   │
        │ 📜 Audit log                               │
        │ ORGANIZATIONS                              │
        │ 🏢 Flow Turn               oem · flow-turn │
        │ 🏢 Acme Logistics          end customer    │
        │ ASSET MODELS                               │
        │ 📦 Flow Turn Square-Turn   FT-SQUARE-TURN  │
        │ …                                          │
        ├────────────────────────────────────────────┤
        │  ↑↓ navigate   ↵ open         ⌘K toggle    │
        └────────────────────────────────────────────┘
```
- Overlay: centered, `max-w-xl`, 10 vh top offset.
- Backdrop: black/30 + subtle backdrop-blur.
- Groups: Navigate first (static), then Organizations, Asset models,
  Content packs, QR codes, Users (dynamic).
- Selected row: brand-soft background, brand-strong text, corner-down icon
  on the right.
- Keyboard: ↑↓ moves cursor, ↵ navigates, ESC closes, Cmd/Ctrl+K toggles.

### 7.16 Toast system

```
     bottom-right, stacked, 360 px wide, 16 px gap, 24 px margin
     enter: fade + translate-x 12 px, 200 ms

 ┌│ ✓  Version published                       ✕ ┐
 │   Content is now immutable and                 │  success tone:
 │   available to instances.                      │  left green bar,
 └────────────────────────────────────────────────┘  green check icon

 ┌│ ⚠  Upload failed                             ✕ ┐
 │   Network error — check your connection.        │  error tone:
 │                                                 │  left red bar,
 └─────────────────────────────────────────────────┘  red alert icon

 ┌│ i  Imported 500 of 500                        ✕ ┐
 │   Every serial created successfully.            │  info tone:
 │                                                 │  left brand bar
 └─────────────────────────────────────────────────┘
```

---

## 8. States matrix

For every collection surface the visual designer should define:

| State | PWA examples | Admin examples |
|---|---|---|
| **Default** | Docs grid populated, work orders listed | Tables with rows |
| **Loading** | `DocListSkeleton` (card shimmer) | `TableSkeleton` (header + rows) or `TilesSkeleton` (dashboard) |
| **Empty** | "No documents published in this revision." | `EmptyState` with lucide icon + copy + optional CTA |
| **Error** | Red banner at top of section | Red banner before content |

Empty-state copy template:
> `Title`: short, inviting  
> `Description`: one sentence explaining WHY it's empty + what to do  
> `Action`: primary button when the user can do something

Example:
> **No content packs yet**  
> A content pack is the versioned bundle of documents, training, and parts
> for one asset model. Pick a model to start authoring.  
> `[ + Create a pack ]`

---

## 9. Interaction patterns

- **Buttons:** hover = darker shade or surface-elevated; press = `translateY(0.5px)`; focus-visible = 2 px brand outline with 2 px offset.
- **Links:** underline-offset 2, hover underline.
- **Cards:** hover = -0.5 px Y translate + brand-tinted shadow (docs), or border darkens (listings).
- **Drawers:** slide in from right 240 ms + fade; backdrop dims page 30% with subtle blur; ESC or backdrop click to close.
- **Command palette:** Cmd/Ctrl+K globally; ESC closes; arrow keys navigate groups without skipping.
- **Toasts:** auto-dismiss after 4.5 s (success/info) or 7 s (error). Manual dismiss via ✕.
- **Theme toggle:** instant swap with localStorage persistence; synchronous boot script prevents FOUC.
- **Tab switch:** content cross-fades with slight Y offset.
- **Focus management:** drawers focus first input; palette auto-focuses search.

---

## 10. Responsive breakpoints

```
phone            0   – 639 px   1-col everywhere, icon-only tabs
small-tablet    640  – 767 px   tab labels appear; forms 1-col
tablet landscape 768 – 1023 px  spec grid 3-col, docs grid 2-col
small desktop  1024 – 1279 px   docs grid 3-col
desktop         1280 +          full density, admin tables expanded
```

**Tablet landscape is the design target.** Both apps should look deliberate
and spacious at 1024 × 768, not merely stretched.

---

## 11. What the visual designer should produce

1. **Token palette.** Color, type, radius, shadow, spacing — with both light
   and dark themes. Keep semantic slot names in section 4.
2. **Primitive designs.** Each component in section 5 rendered in all its
   states (default/hover/focus/active/disabled/loading/error where relevant).
3. **Screen mockups.** At least:
   - PWA landing, asset hub (phone + tablet landscape), doc viewer for each
     kind, chat with citations, training quiz, parts list.
   - Admin dashboard, organizations list + detail, asset-model detail with
     bulk-import drawer, content-pack detail with draft + published version,
     QR codes page, command palette overlay, toast stack.
4. **Motion specs.** Confirm or revise the timings in section 4.
5. **Icon set review.** Confirm or replace the lucide-react icons used (see
   appendix).

**Keep these constraints:**
- IBM Plex (Sans + Mono) typography — it's load-bearing for the industrial
  feel.
- OSHA-aligned signal colors — the safety semantics are real.
- 40 px minimum touch targets.
- Tablet landscape primary.
- Sticky top bar + sidebar for Admin; nameplate + segbar + panel for PWA.
- Icon + label in nav, icon-only collapses only under 640 px.

**Free to redesign:**
- Exact hues, gradients, and surface depths.
- Shadow language.
- Corner-radius scale.
- Card ornament (grid patterns, edge highlights, subtle textures).
- Empty-state illustrations.
- Logo / wordmark.

---

## 12. Appendix — Icon inventory (lucide-react)

| Use | Icon |
|---|---|
| PWA tabs: Overview / Docs / Training / Parts / Assistant | LayoutGrid / FileText / GraduationCap / Wrench / MessageSquare |
| Admin nav: Dashboard / Orgs / Models / Packs / Training / Parts / QR / Users / Audit | LayoutDashboard / Building2 / Boxes / FileStack / GraduationCap / Wrench / QrCode / Users / ScrollText |
| Actions | Plus / Upload / Printer / Send / Download / Maximize2 / Minimize2 / Square / ArrowUp |
| Nav | ChevronLeft / ChevronRight / CornerDownLeft / Home / Search / Command |
| Doc kinds | FileText / FileType2 / Video / Youtube / Presentation / Layers / Paperclip |
| Signals | ShieldAlert / AlertCircle / CheckCircle2 / Info / AlertTriangle / Sparkles |
| Theme | Sun / Moon |

---

## 13. Appendix — Component file map

```
apps/pwa/src/
  app/
    page.tsx                 Landing
    scan/page.tsx            Scanner
    a/[qrCode]/
      page.tsx               Asset hub shell
      tabs.tsx               Segbar + Overview
      docs-tab.tsx           Documents list + viewer
      training-tab.tsx       Module list + runner + quiz + result
      parts-tab.tsx          BOM list + search
      chat-tab.tsx           Assistant streaming chat
      issues-panel.tsx       Work orders list + report form
  components/
    toast.tsx                Toast provider + hook
    theme-toggle.tsx         Sun/Moon button + boot script
    skeleton.tsx             Skeleton + DocListSkeleton

apps/admin/src/
  app/
    page.tsx                 Dashboard
    tenants/                 Orgs list + detail
    asset-models/            Models list + detail
    content-packs/           Packs list + detail
    training/page.tsx
    parts/page.tsx
    qr-codes/page.tsx        Mint + select + print
    qr-codes/print/page.tsx  Printable sheet
    users/page.tsx
    audit/page.tsx
  components/
    sidebar.tsx              Dark sidebar with nav
    top-bar.tsx              Sticky top bar with palette trigger
    page-shell.tsx           PageShell wrapper, PageHeader, MetricTile, Pill, Card, DataLoader
    breadcrumbs.tsx          Home + chain
    command-palette.tsx      Cmd-K overlay
    empty-state.tsx          Icon + title + description + action
    skeleton.tsx             Skeleton + TableSkeleton + TilesSkeleton + DetailSkeleton
    form.tsx                 Field / TextInput / Select / Textarea / buttons / Drawer / ErrorBanner
    toast.tsx                Toast provider + hook
    theme-toggle.tsx         Sun/Moon button + boot script
```

---

*End of wireframe & design spec.*
