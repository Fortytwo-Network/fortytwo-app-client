/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["'Haffer XH'", "Inter", "system-ui", "sans-serif"],
        mono: ["'Haffer XH Mono'", "ui-monospace", "monospace"],
      },
      colors: {
        ft: {
          blue: "#2D2DFF",
          cyan: "#00DAF7",
          green: "#00DD00",
          red: "#EE0000",
          orange: "#CC9900",
          base: "#000000",
          surface: "#050505",
          card: "rgba(255,255,255,0.07)",
          border: "rgba(255,255,255,0.1)",
        },
      },
      keyframes: {
        "ft-pulse": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.3" },
        },
        "ft-blink": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0" },
        },
      },
      animation: {
        "ft-pulse": "ft-pulse 2s infinite",
        "ft-pulse-fast": "ft-pulse 0.6s infinite",
        "ft-blink": "ft-blink 1s step-end infinite",
      },
    },
  },
  plugins: [],
};
