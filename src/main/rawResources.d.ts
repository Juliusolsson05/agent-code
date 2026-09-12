// Vite embeds the operator skill verbatim in the main bundle, including packaged builds.
declare module '*.md?raw' { const content: string; export default content }
