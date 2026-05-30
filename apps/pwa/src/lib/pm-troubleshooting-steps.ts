// Converters that turn PM plan buckets and troubleshooting items into the
// inline `JobAidSource` step shape consumed by VirtualJobAid. Lifted out of
// maintenance-tab so the parts tab's "Related PMs / Related Troubleshooting"
// rows can launch the SAME walkthrough the Maintenance tab launches instead
// of opening the row's optional see-also reference doc (which was usually a
// part's Removal & Replacement procedure — surprising behavior).
import type { PmPlanBucket, TroubleshootingGuide } from './api';

export interface InlineStep {
  title: string;
  bodyMarkdown?: string | null;
}

export function planBucketToSteps(bucket: PmPlanBucket): InlineStep[] {
  return bucket.items.map((it) => {
    const parts: string[] = [];
    if (it.remarks) parts.push(it.remarks);
    if (it.document) parts.push(`_Linked procedure: ${it.document.title}_`);
    return {
      title: `${it.component} — ${it.checkText}`,
      bodyMarkdown: parts.length > 0 ? parts.join('\n\n') : null,
    };
  });
}

export function troubleshootingToSteps(
  item: TroubleshootingGuide['items'][number],
): InlineStep[] {
  const out: InlineStep[] = [];

  const paired = (item.causes ?? []).filter(
    (c) =>
      c.cause.trim().length > 0 ||
      (c.remedySteps ?? []).some((s) => s.text.trim().length > 0),
  );

  if (paired.length > 0) {
    paired.forEach((c) => {
      const cause = c.cause.trim();
      const steps = (c.remedySteps ?? []).filter((s) => s.text.trim().length > 0);
      const bullets =
        steps.length > 0
          ? steps
              .map((s, i) => {
                const prefix = c.remedyStyle === 'numbered' ? `${i + 1}.` : '-';
                const docHint = s.document ? ` _(see: ${s.document.title})_` : '';
                return `${prefix} ${s.text}${docHint}`;
              })
              .join('\n')
          : '';
      out.push({
        title: cause ? `Possible cause: ${cause}` : 'Possible cause',
        bodyMarkdown: bullets || null,
      });
    });
    return out;
  }

  // Legacy unpaired fallback — pre-0028 guides stored parallel cause/remedy
  // lists; render them as a single combined step rather than dropping them.
  const causeText =
    item.causeItems.length > 0
      ? item.causeItems
          .filter((c) => c.text.trim())
          .map((c) => `- ${c.text}`)
          .join('\n')
      : item.cause?.trim() ?? '';
  const remedyText =
    item.remedyItems.length > 0
      ? item.remedyItems
          .filter((r) => r.text.trim())
          .map((r, i) => `${i + 1}. ${r.text}`)
          .join('\n')
      : item.remedy?.trim() ?? '';

  if (causeText || remedyText) {
    const sections: string[] = [];
    if (causeText) sections.push(`**Cause(s)**\n\n${causeText}`);
    if (remedyText) sections.push(`**Remedy**\n\n${remedyText}`);
    out.push({
      title: item.symptom,
      bodyMarkdown: sections.join('\n\n'),
    });
  }
  return out;
}
