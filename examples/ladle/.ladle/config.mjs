export default {
  stories: 'src/**/*.stories.{js,jsx,ts,tsx}',
  // Ladle writes meta.json here alongside the built app; juxtapose reads it
  // to enumerate stories.
  outDir: 'build',
};
