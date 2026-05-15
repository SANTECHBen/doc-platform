'use client';

import { use, useEffect, useState } from 'react';
import { Activity } from 'lucide-react';
import { Breadcrumbs } from '@/components/breadcrumbs';
import { TopBar } from '@/components/top-bar';
import { TilesSkeleton } from '@/components/skeleton';
import { PageHeader, MetricTile } from '@/components/page-shell';
import { ErrorBanner, Select } from '@/components/form';
import {
  getAnalytics,
  listOrganizations,
  type AdminAnalytics,
  type AdminOrganization,
} from '@/lib/api';

export default function OrgAnalyticsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: orgId } = use(params);
  const [days, setDays] = useState<number>(30);
  const [data, setData] = useState<AdminAnalytics | null>(null);
  const [org, setOrg] = useState<AdminOrganization | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      getAnalytics({ days, orgId }),
      listOrganizations(),
    ])
      .then(([d, orgs]) => {
        if (cancelled) return;
        setData(d);
        setOrg(orgs.find((o) => o.id === orgId) ?? null);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [orgId, days]);

  return (
    <>
      <TopBar>
        <Breadcrumbs
          items={[
            { label: 'Organizations', href: '/orgs' },
            { label: org?.name ?? '…', href: `/orgs/${orgId}` },
            { label: 'Analytics' },
          ]}
        />
      </TopBar>
      <div className="page-enter mx-auto max-w-[1440px] px-6 py-8 lg:px-10 lg:py-10">
        <PageHeader
          title="Analytics"
          description="How this customer is using the field side. Pick a window to see scans, hub views, work orders, and procedure runs."
          actions={
            <label className="flex items-center gap-2 text-sm text-ink-secondary">
              Window:
              <Select
                value={String(days)}
                onChange={(e) => setDays(Number(e.target.value))}
              >
                <option value="7">Last 7 days</option>
                <option value="30">Last 30 days</option>
                <option value="90">Last 90 days</option>
              </Select>
            </label>
          }
        />
        <ErrorBanner error={error} />
        {data === null ? (
          <TilesSkeleton count={6} />
        ) : (
          <div className="flex flex-col gap-6">
            <div className="grid grid-cols-2 gap-3.5 md:grid-cols-3 lg:grid-cols-4">
              <MetricTile
                label="QR scans"
                value={data.scans}
                sub={`${data.blockedScans} blocked`}
                tone="default"
              />
              <MetricTile label="Hub views" value={data.hubViews} sub="asset hub opens" />
              <MetricTile
                label="Active assets"
                value={data.activeAssets}
                sub="touched in window"
              />
              <MetricTile
                label="Work orders opened"
                value={data.workOrdersOpened}
                sub={`${data.workOrdersStatusChanges} status changes`}
                tone={data.workOrdersOpened > 0 ? 'warning' : 'default'}
              />
              <MetricTile
                label="Procedure runs"
                value={data.procedureRunsStarted}
                sub={`${data.procedureRunsFinished} finished, ${data.procedureRunsAbandoned} abandoned`}
              />
              <MetricTile
                label="Packs published"
                value={data.contentPacksPublished}
                sub={`${data.sectionsCreated} sections created`}
              />
              <MetricTile
                label="AI chat messages"
                value={data.aiChatMessages ?? '—'}
                sub="from techs"
              />
              <MetricTile
                label="Feedback"
                value={data.feedbackSubmissions}
                sub="submissions"
              />
            </div>

            {data.scansByDay.length > 0 && (
              <section className="rounded-md border border-line-subtle bg-surface-raised p-5">
                <h3 className="caption mb-4">Scans by day</h3>
                <div className="flex h-32 items-end gap-1">
                  {data.scansByDay.map((d) => {
                    const max = Math.max(
                      1,
                      ...data.scansByDay.map((x) => x.count),
                    );
                    const height = `${(d.count / max) * 100}%`;
                    return (
                      <div
                        key={d.day}
                        className="flex flex-1 flex-col items-center justify-end gap-1"
                        title={`${d.day}: ${d.count}`}
                      >
                        <div
                          className="w-full rounded-t bg-brand/70"
                          style={{ height }}
                        />
                      </div>
                    );
                  })}
                </div>
                <div className="mt-2 flex justify-between text-[10px] text-ink-tertiary">
                  <span>{data.scansByDay[0]?.day}</span>
                  <span>{data.scansByDay[data.scansByDay.length - 1]?.day}</span>
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </>
  );
}
