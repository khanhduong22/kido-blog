/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        dark: {
          bg: '#0a0e17',
          surface: '#111827',
          card: '#161f30',
          border: '#1f293d',
          muted: '#94a3b8',
          text: '#f1f5f9'
        },
        brand: {
          blue: '#38bdf8',
          cyan: '#06b6d4',
          indigo: '#6366f1',
          accent: '#0284c7'
        }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'Consolas', 'monospace']
      }
    },
  },
  plugins: [],
};
