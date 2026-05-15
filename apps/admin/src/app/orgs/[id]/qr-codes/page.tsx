'use client';

import Link from 'next/link';
import { use, useEffect, useMemo, useState } from 'react';
import { Printer, QrCode, Settings2 } from 'lucide-react';
import { Breadcrumbs } from '@/components/breadcrumbs';
import { TopBar } from '@/components/top-bar';
import { EmptyState } from '@/components/empty-state';
import { TableSkeleton } from '@/components/skeleton';
import { PageHeader } from '@/components/page-shell';
import { ErrorBanner } from '@/components/form';
import {
  listAssetInstances,
  listOrganizations,
  listQrCodes,
  type AdminAssetInstance,
  type AdminOrganization,
  type AdminQrCode,
} from '@/lib/api';

export default function OrgQrCodesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: orgId } = use(params);
  const [codes, setCodes] = useState<AdminQrCode[] | null>(null);
  const [instances, setInstances] = useState<AdminAssetInstance[]>([]);
  const [org, setOrg] = useState<AdminOrganization | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([listQrCodes(), listAssetInstances(), listOrganizations()])
      .then(([c, ai, orgs]) => {
        if (cancelled) return;
        setCodes(c);
        setInstances(ai);
        setOrg(orgs.find((o) => o.id === orgId) ?? null);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  // Codes whose instance lives at a site at this org. listAssetInstances
  // returns {organization: { id }} so we can match cleanly.
  const orgInstanceIds = useMemo(
    () =>
      new Set(
        instances.filter((i) => i.organization.id === orgId).map((i) => i.id),
      ),
    [instances, orgId],
  );
  const filtered = useMemo(
    () =>
      (codes ?? []).filter(
        (c) => c.assetInstance && orgInstanceIds.has(c.assetInstance.id),
      ),
    [codes, orgInstanceIds],
  );

  const selectedIds = filtered.map((c) => c.id).join(',');
  const printHref = filtered.length
    ? `/orgs/${orgId}/qr-codes/print?ids=${selectedIds}`
    : null;

  return (
    <>
      <TopBar>
        <Breadcrumbs
          items={[
            { label: 'Organizations', href: '/orgs' },
            { label: org?.name ?? '…', href: `/orgs/${orgId}` },
            { label: 'QR codes' },
          ]}
        />
      </TopBar>
      <div className="page-enter mx-auto max-w-[1440px] px-6 py-8 lg:px-10 lg:py-10">
        <PageHeader
          title="QR codes"
          description="Scannable labels minted against asset instances. A tech scans one in the field, the PWA opens that instance's hub instantly."
          actions={
            <div className="flex gap-2">
              <Link
                href={`/orgs/${orgId}/qr-codes/templates`}
                className="btn btn-secondary btn-sm"
              >
                <Settings2 size={14} strokeWidth={2} /> Label templates
              </Link>
              {printHref && (
                <Link href={printHref} className="btn btn-primary btn-sm">
                  <Printer size={14} strokeWidth={2} /> Print all
                </Link>
              )}
            </div>
          }
        />
        <ErrorBanner error={error} />
        {codes === null ? (
          <TableSkeleton cols={4} rows={5} />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={QrCode}
            title="No QR codes yet"
            description="Mint a QR code from an asset instance — open the instance and click Mint QR. Then print and stick it on the equipment."
            action={
              <Link
                href={`/orgs/${orgId}/asset-models`}
                className="btn btn-secondary"
              >
                Open asset models
              </Link>
            }
          />
        ) : (
          <div className="overflow-hidden rounded-md border border-line-subtle bg-surface-raised">
            <table className="data-table">
              <thead className="bg-surface-inset text-left text-xs uppercase tracking-wide text-ink-tertiary">
                <tr>
                  <th className="px-4 py-2">Code</th>
                  <th className="px-4 py-2">Label</th>
                  <th className="px-4 py-2">Asset</th>
                  <th className="px-4 py-2">Site</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2">Created</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => (
                  <tr key={c.id} className="border-t border-line-subtle">
                    <td className="px-4 py-3 font-mono text-xs text-ink-primary">
                      {c.code}
                    </td>
                    <td className="px-4 py-3 text-ink-secondary">
                      {c.label ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-ink-secondary">
                      {c.assetInstance?.modelDisplayName}{' '}
                      <span className="font-mono text-xs text-ink-tertiary">
                        · {c.assetInstance?.serialNumber}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-ink-secondary">
                      {c.assetInstance?.siteName}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center gap-1 ${
                          c.active ? 'text-signal-ok' : 'text-ink-tertiary'
                        }`}
                      >
                        {c.active ? 'Active' : 'Disabled'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-ink-tertiary">
                      {new Date(c.createdAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
