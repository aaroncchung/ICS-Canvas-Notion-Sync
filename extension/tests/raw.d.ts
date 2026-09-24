/** Vite hands a file imported with ?raw to the test as its text. */
declare module "*?raw" {
  const text: string;
  export default text;
}
