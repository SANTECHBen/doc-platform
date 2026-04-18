import type { Config } from 'tailwindcss';

// Shop-floor palette. Semantic names (surface, border, signal) keep usage
// intent-driven; components don't hard-code hue + shade. Raw colors live in
// globals.css as CSS custom properties so themes can swap without rebuilding.
export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: {
          base: 'rgb(var(--surface-base) / <alpha-value>)',
          raised: 'rgb(var(--surface-raised) / <alpha-value>)',
          elevated: 'rgb(var(--surface-elevated) / <alpha-value>)',
          inset: 'rgb(var(--surface-inset) / <alpha-value>)',
        },
        line: {
          subtle: 'rgb(var(--line-subtle) / <alpha-value>)',
          DEFAULT: 'rgb(var(--line) / <alpha-value>)',
          strong: 'rgb(var(--line-strong) / <alpha-value>)',
        },
        ink: {
          primary: 'rgb(var(--ink-primary) / <alpha-value>)',
          secondary: 'rgb(var(--ink-secondary) / <alpha-value>)',
          tertiary: 'rgb(var(--ink-tertiary) / <alpha-value>)',
          inverse: 'rgb(var(--ink-inverse) / <alpha-value>)',
        },
        brand: {
          DEFAULT: 'rgb(var(--brand) / <alpha-value>)',
          strong: 'rgb(var(--brand-strong) / <alpha-value>)',
          soft: 'rgb(var(--brand-soft) / <alpha-value>)',
          ink: 'rgb(var(--brand-ink) / <alpha-value>)',
        },
        signal: {
          ok: 'rgb(var(--signal-ok) / <alpha-value>)',
          warn: 'rgb(var(--signal-warn) / <alpha-value>)',
          fault: 'rgb(var(--signal-fault) / <alpha-value>)',
          info: 'rgb(var(--signal-info) / <alpha-value>)',
          safety: 'rgb(var(--signal-safety) / <alpha-value>)',
        },
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        // Industrial scale — tight line heights, precise steps.
        'caption': ['0.6875rem', { lineHeight: '1rem', letterSpacing: '0.05em' }],
        'xs': ['0.75rem', { lineHeight: '1rem' }],
        'sm': ['0.8125rem', { lineHeight: '1.25rem' }],
        'base': ['0.9375rem', { lineHeight: '1.5rem' }],
        'lg': ['1.0625rem', { lineHeight: '1.625rem' }],
        'xl': ['1.25rem', { lineHeight: '1.75rem' }],
        '2xl': ['1.5rem', { lineHeight: '2rem', letterSpacing: '-0.01em' }],
        '3xl': ['1.875rem', { lineHeight: '2.25rem', letterSpacing: '-0.02em' }],
        '4xl': ['2.25rem', { lineHeight: '2.5rem', letterSpacing: '-0.025em' }],
      },
      borderRadius: {
        none: '0',
        sm: '2px',
        DEFAULT: '4px',
        md: '6px',
        lg: '8px',
        xl: '10px',
        '2xl': '12px',
      },
      boxShadow: {
        // Etched rather than floating — industrial consoles don't have drop shadows.
        'inset-line': 'inset 0 0 0 1px rgb(var(--line) / 0.8)',
        'etch': '0 1px 0 0 rgb(var(--line) / 0.5), inset 0 1px 0 0 rgb(255 255 255 / 0.03)',
        'lift': '0 2px 8px -2px rgb(0 0 0 / 0.3), 0 1px 2px rgb(0 0 0 / 0.2)',
      },
      backgroundImage: {
        'grid-subtle':
          'linear-gradient(rgb(var(--line) / 0.08) 1px, transparent 1px), linear-gradient(90deg, rgb(var(--line) / 0.08) 1px, transparent 1px)',
      },
    },
  },
  plugins: [],
} satisfies Config;
