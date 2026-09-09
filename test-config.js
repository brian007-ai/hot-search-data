const {loadConfig, getPlatforms} = require('./fetcher/config-loader');
const c = loadConfig();
console.log('Sources:', c.sources.length);
console.log('Platforms:', getPlatforms(c).length);
console.log('First platform:', getPlatforms(c)[0]);