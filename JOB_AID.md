# Job Aid: New Organization → Content → QR Code

End-to-end checklist for setting up a new customer in the admin app and getting a printable QR label.

Admin app: <https://equipment-hub-admin.vercel.app/>

Follow the steps in order. Each step depends on the one before it.

---

## Step 1 — Create the organization (OEM)

1. Go to **Organizations** (`/tenants`).
2. Click **New organization** (top right).
3. Fill in the drawer:
   - **Type:** `OEM` (for the equipment manufacturer). Use `dealer` / `integrator` / `end_customer` for downstream tenants — those need a parent org.
   - **Name** — display name (e.g. "Flow Turn").
   - **Slug** — URL-safe; auto-fills from name.
   - **OEM code** — short vendor code (OEMs only, e.g. "FLOWTURN").
4. Click **Create organization**.

> Repeat for any dealer / integrator / end-customer tenant. Pick the parent org you just created.

---

## Step 2 — Add a site to the tenant

A site is required before you can deploy any equipment instance.

1. From **Organizations**, click the tenant row to open its detail page.
2. In the **Sites** section, click **Add site**.
3. Fill in: name, code, city, region, country, postal code, timezone.
4. Save.

> **Branding (OEM only):** while on the tenant detail page, scroll to **Branding** to upload a logo and set a primary color. This is what end users see in the PWA after scanning.
> **Privacy:** toggle **Require QR scan for PWA access** if the customer wants the asset hub gated behind a physical scan.

---

## Step 3 — Create an asset model

1. Go to **Asset models** (`/asset-models`).
2. Click **New asset model**.
3. Fill in:
   - **OEM** — the org from Step 1.
   - **Model code** — equipment SKU (e.g. "FT-MERGE-90").
   - **Display name** — human-readable (e.g. "Flow Turn 90° Merge").
   - **Category** — pick from suggestions (`conveyor`, `sortation`, `asrs`, etc.).
   - **Description**, **Hero photo** — optional but recommended.
4. Click **Create asset model**.

---

## Step 4 — Create parts and build the Bill of Materials

Parts in the catalog do **not** appear on the PWA Parts tab unless they're on the asset model's BOM.

### 4a. Create the parts
1. Go to **Parts** (`/parts`).
2. Click **New part** for each part you need. Fill in OEM, OEM part number, display name, optional cross-references and image.
3. Use the **Components** button on a part row to add sub-parts (assemblies).

### 4b. Add parts to the asset model
1. Open the asset model detail (`/asset-models/[id]`).
2. Scroll to **Bill of materials**, click **Add part**.
3. Pick the catalog part and fill in **position**, **quantity**, **notes**.

---

## Step 5 — Author a content pack

This is where documents and training modules live. They're versioned per asset model.

1. Go to **Content packs** (`/content-packs`).
2. Click **New content pack**:
   - **Asset model** — from Step 3.
   - **Layer type** — `base` (OEM-authored), `dealer_overlay`, or `site_overlay`.
   - **Name** / **Slug** — auto-fills.
3. Click **Create content pack**.
4. Open the pack — a **draft version** is created automatically.
5. On the draft version row:
   - **Add document** — pick kind (`markdown`, `pdf`, `slides`, `schematic`, `video`, `external_video`, `structured_procedure`), title, language, optional safety-critical flag and tags. Upload the file or paste the URL.
   - **Add module** (training) — title, optional competency tag, estimated duration, pass threshold; link the documents the learner should read.
6. When the version has at least one document, click **Publish** to freeze it. Published versions are immutable — to change them, create a new version.

> **Tip:** Authoring is the product. Be explicit when linking parts, documents, and training — don't rely on auto-inference.

---

## Step 6 — Deploy an asset instance

An instance is one physical machine on a site. QR codes attach to instances, not to models.

1. Open the asset model detail (`/asset-models/[id]`).
2. Click **Add instance** (or **Bulk import** for many serials at once).
3. Pick the **site** (from Step 2) and enter the **serial number**.
4. Save. The new instance shows in **Deployed instances**. Pin it to the published content version if needed.

---

## Step 7 — Generate the QR code

1. Go to **QR codes** (`/qr-codes`).
2. In the **Generate new label** section:
   - **Asset instance** — pick the instance from Step 6.
   - **Caption** — what's printed on the label (e.g. "Aisle 1 east"). Optional.
   - **Label template** — pre-pick a template, or leave as "No preference" to choose at print time.
3. Click **Generate**. The new code appears in **Active labels**.

The code resolves to `https://<pwa-domain>/q/<code>`.

---

## Step 8 — Print the sheet

1. In **Active labels**, tick the codes you want (or click **Select all**).
2. Pick a **template** from the dropdown if you didn't pin one at generate time.
3. Click **Print sheet** — a print-ready window opens. Print, peel, apply.

> Custom layouts: top-right **Label templates** link → `/qr-codes/templates`.

---

## What the technician sees (PWA)

1. Technician opens the PWA, taps **Scan equipment** (`/scan`), scans the label.
2. The PWA hits `/q/<code>`, mints an 8-hour scan-session cookie, and redirects to `/a/<code>`.
3. They see the asset hub: tenant logo and brand colors, status indicator, and tabs for **Documents**, **Parts** (BOM only), **Training**, **Work Orders**.

---

## Quick sanity check before you hand off

- [ ] OEM organization created, with at least one site.
- [ ] Asset model created with a hero photo.
- [ ] Parts added to the catalog and to the model's BOM.
- [ ] Content pack has a **published** version with documents.
- [ ] Asset instance exists with a real serial number on the right site.
- [ ] QR code generated for that instance.
- [ ] Test scan: open the PWA, scan, and confirm the asset hub loads with the right branding and content.
