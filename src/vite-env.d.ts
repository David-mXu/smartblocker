// Vite asset imports (.svg) resolve to the emitted asset URL at build time.
declare module '*.svg' {
  const src: string;
  export default src;
}
