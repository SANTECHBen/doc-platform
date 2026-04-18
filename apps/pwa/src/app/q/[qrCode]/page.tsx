import { redirect } from 'next/navigation';

// Stickers print URLs of the form /q/<code>. We resolve server-side and forward
// to the stable asset URL — this keeps stickers retargetable and hides the
// internal instance ID from the printed artifact.
export default async function QrResolvePage({
  params,
}: {
  params: Promise<{ qrCode: string }>;
}) {
  const { qrCode } = await params;
  redirect(`/a/${qrCode}`);
}
