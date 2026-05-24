import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: { DEFAULT: '#2563eb', dark: '#1e40af' },
      },
    },
  },
  plugins: [],
};
export default config;
