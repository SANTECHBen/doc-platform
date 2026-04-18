'use client';

import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

type ToastVariant = 'success' | 'error' | 'info';
interface Toast {
  id: string;
  title: string;
  description?: string;
  variant: ToastVariant;
  duration: number;
}

interface ToastApi {
  show: (toast: Omit<Toast, 'id' | 'duration'> & { duration?: number }) => void;
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
  info: (title: string, description?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const remove = useCallback((id: string) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const api = useMemo<ToastApi>(() => {
    const show: ToastApi['show'] = ({ title, description, variant, duration = 4500 }) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setToasts((t) => [...t, { id, title, description, variant, duration }]);
      if (duration > 0) {
        setTimeout(() => {
          setToasts((t) => t.filter((x) => x.id !== id));
        }, duration);
      }
    };
    return {
      show,
      success: (title, description) => show({ title, description, variant: 'success' }),
      error: (title, description) => show({ title, description, variant: 'error', duration: 7000 }),
      info: (title, description) => show({ title, description, variant: 'info' }),
    };
  }, []);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed bottom-6 right-6 z-[100] flex flex-col gap-2">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={() => remove(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');
  return ctx;
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const [enter, setEnter] = useState(false);
  useEffect(() => {
    const t = requestAnimationFrame(() => setEnter(true));
    return () => cancelAnimationFrame(t);
  }, []);

  const tone =
    toast.variant === 'success'
      ? {
          border: 'border-signal-ok/40',
          bar: 'bg-signal-ok',
          text: 'text-signal-ok',
          Icon: CheckCircle2,
        }
      : toast.variant === 'error'
      ? {
          border: 'border-signal-fault/50',
          bar: 'bg-signal-fault',
          text: 'text-signal-fault',
          Icon: AlertCircle,
        }
      : {
          border: 'border-brand/40',
          bar: 'bg-brand',
          text: 'text-brand',
          Icon: Info,
        };

  return (
    <div
      role="status"
      className={`pointer-events-auto relative flex w-[360px] items-start gap-3 overflow-hidden rounded-md border ${tone.border} bg-surface-raised p-3 pl-4 shadow-lg transition-all duration-200 ${
        enter ? 'translate-x-0 opacity-100' : 'translate-x-3 opacity-0'
      }`}
    >
      <span className={`absolute left-0 top-0 h-full w-1 ${tone.bar}`} />
      <tone.Icon size={18} strokeWidth={2} className={`mt-0.5 shrink-0 ${tone.text}`} />
      <div className="flex-1">
        <p className="text-sm font-medium text-ink-primary">{toast.title}</p>
        {toast.description && (
          <p className="mt-0.5 text-xs text-ink-secondary">{toast.description}</p>
        )}
      </div>
      <button
        onClick={onDismiss}
        className="text-ink-tertiary hover:text-ink-primary"
        aria-label="Dismiss"
      >
        <X size={14} />
      </button>
    </div>
  );
}
