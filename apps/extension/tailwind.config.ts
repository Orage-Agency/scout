import type { Config } from "tailwindcss";

export default {
  darkMode: "class",
  content: ["./src/**/*.{ts,html}"],
  theme: {
    extend: {
      colors: {
        // Per §14.1 design tokens.
        base: "#0F172A",
        elevated: "#1E293B",
        primary: "#F1F5F9",
        muted: "#94A3B8",
        accent: "#DC2626",
        "accent-quiet": "#7F1D1D",
        success: "#15803D",
        warning: "#B45309",
        line: "#334155",
      },
      borderRadius: {
        sm: "4px",
        md: "6px",
        lg: "10px",
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
    },
  },
  plugins: [],
} satisfies Config;
