// test-storybook refuses to start without a Storybook config. With
// --index-json the story list comes from the served index.json, so this stub
// is never used to find stories.
module.exports = { stories: ['../stories/*.stories.js'] };
