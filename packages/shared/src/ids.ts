import { z } from 'zod';

export const UuidSchema = z.string().uuid();
export type Uuid = z.infer<typeof UuidSchema>;

// QR code is opaque short string, generated server-side. ~12 chars base32.
export const QrCodeStringSchema = z
  .string()
  .min(8)
  .max(24)
  .regex(/^[A-Z0-9]+$/, 'QR codes are uppercase base32');
export type QrCodeString = z.infer<typeof QrCodeStringSchema>;
