/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      // Colore del marchio: letto dai token CSS (--brand-rgb ecc. in index.css), così ogni tema
      // lo ridefinisce in un punto solo e le opacità (bg-brand/15) continuano a funzionare.
      colors: {
        brand: {
          DEFAULT: 'rgb(var(--brand-rgb) / <alpha-value>)',
          hi: 'rgb(var(--brand-hi-rgb) / <alpha-value>)',
          lo: 'rgb(var(--brand-lo-rgb) / <alpha-value>)',
        },
      },
      // Angoli più netti: etichetta/scatola, non "bolla". Vale per tutta l'app.
      borderRadius: {
        lg: '6px',
        xl: '8px',
        '2xl': '10px',
        '3xl': '14px',
      },
      fontFamily: {
        display: ['var(--font-display)'],
        mono: ['var(--font-mono)'],
      },
    },
  },
  plugins: [],
}
