import type { Config } from "tailwindcss";

export default {
  darkMode: "class",
  content: ["./src/**/*.{ts,html}"],
  theme: {
    extend: {
      colors: {
        // Orage brand palette — dark gold/copper on pure black.
        // See ORAGE_AI_BRAND_GUIDELINES.html for the source of truth.
        base: "#000000",       // primary background — pure black
        elevated: "#151515",   // secondary background
        surface: "#212121",    // card / modal surface
        primary: "#FFD69C",    // body text — light tan
        muted: "#FFE8C7",      // secondary text — soft tan (use with opacity)
        accent: "#B68039",     // primary brand — rich brown / gold
        "accent-soft": "#E4AF7A",  // copper / bronze — headings + highlights
        "accent-alt": "#E3C19E",   // copper alt
        "accent-deep": "#543C1C",  // deep brown — divider, subtle accents
        success: "#15803D",
        warning: "#B45309",
        line: "rgba(182, 128, 57, 0.25)", // gold at 25% opacity per brand spec
      },
      borderRadius: {
        sm: "4px",
        md: "6px",
        lg: "10px",
      },
      fontFamily: {
        // Body / UI / microcopy.
        sans: ["Montserrat", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
        // Display / headings — always all-caps at large sizes per brand spec.
        display: ["'Bebas Neue'", "system-ui", "sans-serif"],
        mono: ["'JetBrains Mono'", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      letterSpacing: {
        tightest: "-0.02em",
        brand: "0.18em", // Bebas Neue caps spacing per brand
      },
      backdropBlur: {
        glass: "20px",
      },
    },
  },
  plugins: [],
} satisfies Config;
