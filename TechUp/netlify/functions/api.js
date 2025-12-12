const serverless = require('serverless-http');
const app = require('../../server'); // Points to your server.js file

module.exports.handler = serverless(app);