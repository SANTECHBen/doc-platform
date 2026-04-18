import { createDb } from './client';
import * as schema from './schema';

// Minimum viable demo data — one OEM, one end-customer, one site, one asset
// model, one asset instance, one published ContentPackVersion with docs +
// training + parts, and a QR code resolving to the instance.
//
// After running this, the asset hub URL will be:
//   http://localhost:3000/a/DEMO01ALPHA
// and the API resolve endpoint:
//   http://localhost:3001/assets/resolve/DEMO01ALPHA

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const db = createDb(url);

// 1) Organizations — an OEM, and an end-customer whose parent is the OEM.
const [dematic] = await db
  .insert(schema.organizations)
  .values({
    type: 'oem',
    name: 'Dematic',
    slug: 'dematic',
    oemCode: 'DEMATIC',
  })
  .returning();
if (!dematic) throw new Error('Failed to insert OEM');

const [acme] = await db
  .insert(schema.organizations)
  .values({
    type: 'end_customer',
    name: 'Acme Logistics',
    slug: 'acme-logistics',
    parentOrganizationId: dematic.id,
  })
  .returning();
if (!acme) throw new Error('Failed to insert end customer');

// 2) Site owned by Acme.
const [memphisDC] = await db
  .insert(schema.sites)
  .values({
    organizationId: acme.id,
    name: 'Memphis DC 3',
    code: 'MEM-DC-3',
    city: 'Memphis',
    region: 'TN',
    country: 'US',
    timezone: 'America/Chicago',
  })
  .returning();
if (!memphisDC) throw new Error('Failed to insert site');

// 3) Asset model owned by the OEM.
const [multishuttleModel] = await db
  .insert(schema.assetModels)
  .values({
    ownerOrganizationId: dematic.id,
    modelCode: 'MS-4',
    displayName: 'Multishuttle MS-4',
    category: 'asrs',
    description: 'High-density multishuttle AS/RS goods-to-person system.',
    specifications: {
      throughputCasesPerHour: 1000,
      maxPayloadKg: 50,
      shuttleCount: 24,
    },
  })
  .returning();
if (!multishuttleModel) throw new Error('Failed to insert asset model');

// 4) ContentPack (base layer, owned by the OEM) + one published version.
const [basePack] = await db
  .insert(schema.contentPacks)
  .values({
    assetModelId: multishuttleModel.id,
    ownerOrganizationId: dematic.id,
    layerType: 'base',
    name: 'Multishuttle MS-4 Base',
    slug: 'multishuttle-ms-4-base',
  })
  .returning();
if (!basePack) throw new Error('Failed to insert content pack');

const [packV1] = await db
  .insert(schema.contentPackVersions)
  .values({
    contentPackId: basePack.id,
    versionNumber: 1,
    versionLabel: '1.0.0',
    status: 'published',
    publishedAt: new Date(),
    changelog: 'Initial release seeded for demo.',
  })
  .returning();
if (!packV1) throw new Error('Failed to insert pack version');

// 5) Documents (one safety-critical).
await db.insert(schema.documents).values([
  {
    contentPackVersionId: packV1.id,
    kind: 'markdown',
    title: 'Quick start',
    bodyMarkdown:
      '# Multishuttle MS-4 Quick Start\n\n' +
      '1. Verify all shuttles are parked in home positions.\n' +
      '2. Acknowledge any pending alarms from the HMI.\n' +
      '3. Start the sortation system before the aisle conveyors.\n' +
      '4. Ramp throughput gradually over the first 15 minutes.',
    safetyCritical: false,
    orderingHint: 0,
    tags: ['startup', 'operator'],
  },
  {
    contentPackVersionId: packV1.id,
    kind: 'markdown',
    title: 'Lockout / tagout procedure',
    bodyMarkdown:
      '# Lockout / Tagout — Multishuttle MS-4\n\n' +
      '**WARNING**: Servicing the shuttle drive requires full LOTO per OSHA 1910.147.\n\n' +
      '1. Notify all affected personnel that service is beginning.\n' +
      '2. Place the aisle in maintenance mode from the HMI.\n' +
      '3. Open disconnect switch DS-1 at the aisle end.\n' +
      '4. Apply personal lock and red tag bearing your name and date.\n' +
      '5. Test the circuit with a known-good voltmeter before contact.',
    safetyCritical: true,
    orderingHint: 1,
    tags: ['safety', 'loto', 'maintenance'],
  },
  {
    contentPackVersionId: packV1.id,
    kind: 'markdown',
    title: 'Fault E-217: E-stop circuit troubleshooting',
    bodyMarkdown:
      '# Fault E-217\n\n' +
      'E-217 indicates the emergency-stop circuit has opened. Clear path:\n\n' +
      '1. Inspect all E-stop mushroom buttons along the aisle; verify none are latched.\n' +
      '2. Check the safety relay ES-221 status LED — should be solid green when healthy.\n' +
      '3. Inspect the cable harness between ES-221 and the drive contactor for damage.\n' +
      '4. After resolving, twist-release any engaged E-stop, then reset from the HMI.',
    safetyCritical: false,
    orderingHint: 2,
    tags: ['fault', 'troubleshooting', 'e-stop'],
  },
]);

// 6) Training module with a quiz activity.
const [operatorModule] = await db
  .insert(schema.trainingModules)
  .values({
    contentPackVersionId: packV1.id,
    title: 'MS-4 Operator Basics',
    description: 'Pre-shift checks, startup sequence, alarm acknowledgment.',
    estimatedMinutes: 20,
    competencyTag: 'mhe.operator.asrs.multishuttle.basic',
    passThreshold: 0.8,
  })
  .returning();
if (!operatorModule) throw new Error('Failed to insert training module');

await db.insert(schema.lessons).values({
  trainingModuleId: operatorModule.id,
  title: 'Overview',
  bodyMarkdown:
    'The Multishuttle MS-4 moves totes between storage aisles and picking stations. ' +
    'Before every shift, verify all shuttles are homed, all aisles are clear of personnel, ' +
    'and no alarms are active on the HMI.',
  orderingHint: 0,
});

await db.insert(schema.activities).values({
  trainingModuleId: operatorModule.id,
  kind: 'quiz',
  title: 'Pre-operation check',
  config: {
    questions: [
      {
        prompt: 'Before starting an MS-4 shift, which system should you start first?',
        options: [
          'Aisle conveyors',
          'Sortation system',
          'Shuttles simultaneously with aisle conveyors',
          'None — the system auto-starts',
        ],
        correctIndex: 1,
        explanation: 'Sortation must be downstream-ready before upstream conveyors run.',
      },
      {
        prompt: 'An E-217 fault indicates:',
        options: [
          'Low battery on a shuttle',
          'Emergency stop circuit opened',
          'Communication timeout with the HMI',
          'Overheat on the drive motor',
        ],
        correctIndex: 1,
      },
    ],
  },
  weight: 1,
  orderingHint: 0,
});

// 7) Parts + BOM + references.
const [driveMotor, eStopRelay] = await db
  .insert(schema.parts)
  .values([
    {
      ownerOrganizationId: dematic.id,
      oemPartNumber: 'DM-4712',
      displayName: 'Shuttle drive motor assembly',
      description: 'Servo drive motor with integrated encoder for MS-4 shuttle.',
      crossReferences: ['SEW-DFS71M4B'],
      attributes: { voltage: '400V', powerKw: 1.5 },
    },
    {
      ownerOrganizationId: dematic.id,
      oemPartNumber: 'ES-221',
      displayName: 'Emergency-stop safety relay',
      description: 'Category 4 safety relay, dual-channel, monitored reset.',
      crossReferences: ['PILZ-PNOZ-X3'],
      attributes: { category: 'PLe', inputs: 2 },
    },
  ])
  .returning();
if (!driveMotor || !eStopRelay) throw new Error('Failed to insert parts');

await db.insert(schema.bomEntries).values([
  {
    assetModelId: multishuttleModel.id,
    partId: driveMotor.id,
    positionRef: 'M1',
    quantity: 24,
    notes: 'One per shuttle.',
  },
  {
    assetModelId: multishuttleModel.id,
    partId: eStopRelay.id,
    positionRef: 'ES-221',
    quantity: 1,
    notes: 'Aisle-end safety panel.',
  },
]);

// 8) Asset instance at the site, pinned to the published version.
const [ms4Instance] = await db
  .insert(schema.assetInstances)
  .values({
    assetModelId: multishuttleModel.id,
    siteId: memphisDC.id,
    serialNumber: 'MS4-00042',
    installedAt: new Date('2024-10-18T00:00:00Z'),
    pinnedContentPackVersionId: packV1.id,
  })
  .returning();
if (!ms4Instance) throw new Error('Failed to insert asset instance');

// 9) QR code.
const [qr] = await db
  .insert(schema.qrCodes)
  .values({
    code: 'DEMO01ALPHA',
    assetInstanceId: ms4Instance.id,
    label: 'Demo sticker — Memphis DC 3 aisle 1',
    active: true,
  })
  .returning();
if (!qr) throw new Error('Failed to insert QR code');

console.log('\nSeed complete.');
console.log('  Organization : Dematic (oem) → Acme Logistics (end_customer)');
console.log('  Site         : Memphis DC 3');
console.log('  Asset        : Multishuttle MS-4 · MS4-00042');
console.log('  Content pack : Multishuttle MS-4 Base v1.0.0 (published)');
console.log(`  QR code      : ${qr.code}`);
console.log('\nOpen the asset hub:');
console.log(`  http://localhost:3000/a/${qr.code}`);
console.log(`  http://localhost:3001/assets/resolve/${qr.code}`);

process.exit(0);
